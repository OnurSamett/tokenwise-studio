// Automatic updates: decide (pure), install in the background, remember "update ready", and restart
// studio servers gracefully. State lives in ~/.tokenwise-studio/update.json (shared with the version
// cache), progress in update.log. Everything with side effects is injectable for tests.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "./process.js";
import { fileURLToPath } from "node:url";
import { cacheFile, compareVersions, currentVersion, installArgs, installSource, latestVersion } from "./version.js";
import { loadSettings } from "./settings.js";
import { BUNDLE_ID, defaultAppPath, findAppBundle } from "./appbundle.js";

export const DAY_MS = 24 * 3600 * 1000;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDir = () => path.join(os.homedir(), ".tokenwise-studio");
export const logFile = () => path.join(stateDir(), "update.log");
const lockFile = () => path.join(stateDir(), "update.lock");
export const serversFile = () => path.join(stateDir(), "servers.json");
export const appBundlePath = () => findAppBundle({ requireExecutable: false })?.appPath || defaultAppPath();

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

export const readUpdateState = () => readJson(cacheFile()) || {};
export function writeUpdateState(patch) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const next = { ...readUpdateState(), ...patch };
    const tmp = `${cacheFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, cacheFile());
    return next;
  } catch { return null; }
}

export function logUpdate(msg) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/**
 * Pure decision. Returns { action: "install", args } or { action: "skip", reason, retry }.
 * `retry` is true when the same check should simply run again later (busy, offline).
 */
export function decideAutoUpdate({ mode, updateCheck = true, source, current, latest, busy, lastAttemptAt = 0, ready = null, now = Date.now() }) {
  if (mode !== "auto") return { action: "skip", reason: "mode", retry: false };
  if (updateCheck === false) return { action: "skip", reason: "update check is off", retry: false };
  if (source === "windows") return { action: "skip", reason: "download a new Windows zip to update the beta", retry: false };
  if (source === "dmg") return { action: "skip", reason: "download a new DMG to update the signed app", retry: false };
  if (source === "dev") return { action: "skip", reason: "dev checkout", retry: false };
  if (lastAttemptAt && now - lastAttemptAt < DAY_MS) return { action: "skip", reason: "tried within 24h", retry: false };
  if (!latest || !latest.version) return { action: "skip", reason: "no latest version", retry: true };
  if (compareVersions(latest.version, current) <= 0) return { action: "skip", reason: "up to date", retry: false };
  if (ready?.version && compareVersions(ready.version, latest.version) >= 0) return { action: "skip", reason: "already installed", retry: false };
  if (busy) return { action: "skip", reason: "busy", retry: true };
  return { action: "install", args: installArgs(latest.source) };
}

// One installer at a time across all studio servers on this machine.
async function withLock(fn) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const f = lockFile();
  try { if (Date.now() - fs.statSync(f).mtimeMs > 15 * 60 * 1000) fs.rmSync(f, { force: true }); } catch {}
  let fd;
  try { fd = fs.openSync(f, "wx"); } catch { return { locked: true }; }
  try { fs.writeSync(fd, String(process.pid)); } catch {}
  try { return { locked: false, value: await fn() }; }
  finally { try { fs.closeSync(fd); } catch {} fs.rmSync(f, { force: true }); }
}

/** Run `npm <args>` without a shell. Resolves { ok, out } with the tail of the output. */
export function npmInstall(args, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn("npm", args, { timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (err) { resolve({ ok: false, out: err.message }); return; }
    let out = "";
    const capture = chunk => { out = (out + chunk).slice(-2000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", err => resolve({ ok: false, out: out.trim() || err.message }));
    child.on("close", code => resolve({ ok: code === 0, out: out.trim() }));
  });
}

/**
 * One auto-update pass. Never throws. `deps` overrides side effects (see tests).
 * Returns { action, reason, version? }.
 */
export async function runAutoUpdate(deps = {}) {
  const d = {
    mode: () => loadSettings().autoUpdate,
    updateCheck: () => loadSettings().updateCheck,
    source: () => installSource(),
    current: () => currentVersion(),
    latest: () => latestVersion(),
    busy: () => false,
    install: npmInstall,
    now: () => Date.now(),
    readState: readUpdateState,
    writeState: writeUpdateState,
    log: logUpdate,
    lock: withLock,
    ...deps,
  };
  try {
    const pre = decideAutoUpdate({ mode: d.mode(), updateCheck: d.updateCheck(), source: d.source(), current: d.current(),
      latest: { version: "0.0.0" }, busy: false, lastAttemptAt: d.readState().autoAttemptAt, now: d.now() });
    // Cheap exits before touching the network.
    if (pre.action === "skip" && !["up to date", "no latest version"].includes(pre.reason)) return pre;

    const locked = await d.lock(async () => {
      const state = d.readState();
      const latest = await d.latest();
      const dec = decideAutoUpdate({ mode: d.mode(), updateCheck: d.updateCheck(), source: d.source(), current: d.current(), latest,
        busy: d.busy(), lastAttemptAt: state.autoAttemptAt, ready: state.ready, now: d.now() });
      if (dec.action !== "install") {
        if (dec.reason === "busy") d.log(`update ${latest?.version} waiting: studio is busy, will retry`);
        return dec;
      }
      d.writeState({ autoAttemptAt: d.now() });
      d.log(`installing ${latest.version}: npm ${dec.args.join(" ")}`);
      const r = await d.install(dec.args);
      if (!r.ok) {
        d.log(`install failed: ${String(r.out).split("\n").slice(-3).join(" | ")}`);
        d.writeState({ autoFailed: { version: latest.version, at: new Date(d.now()).toISOString() } });
        return { action: "failed", reason: "install failed", version: latest.version };
      }
      d.log(`installed ${latest.version}; waiting for a restart`);
      d.writeState({ ready: { version: latest.version, at: new Date(d.now()).toISOString() }, autoFailed: null });
      return { action: "installed", reason: "ok", version: latest.version };
    });
    if (locked.locked) return { action: "skip", reason: "another update is running", retry: true };
    return locked.value;
  } catch (e) {
    try { d.log(`auto-update error: ${e.message}`); } catch {}
    return { action: "skip", reason: "error", retry: true };
  }
}

/** "update ready" for this running server: installed version is newer than the one this process loaded. */
export function readyFor(loadedVersion, state = readUpdateState()) {
  const r = state.ready;
  return r && r.version && compareVersions(r.version, loadedVersion) > 0 ? { version: r.version, at: r.at || null } : null;
}

// ---- launcher (Swift app) change detection ----

export function launcherHash(root = ROOT) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "launcher", "TokenwiseStudio.swift"))).digest("hex"); } catch { return null; }
}
export function appLauncherHash(app = appBundlePath()) {
  return readJson(path.join(app, "Contents", "Resources", "config.json"))?.launcherHash || null;
}
/** Does the Mac app need rebuilding (installed app was compiled from different Swift source)? */
export function needsAppSetup({ platform = process.platform, root = ROOT, app = appBundlePath() } = {}) {
  if (platform !== "darwin") return false;
  if (fs.existsSync(path.join(app, "Contents", "Resources", "app", ".bundled"))) return false;
  try {
    const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
    if (!plist.includes(`<string>${BUNDLE_ID}</string>`)) return false; // not ours: setup would refuse anyway
  } catch { return false; } // no app installed
  const want = launcherHash(root);
  return !!want && want !== appLauncherHash(app);
}

/** Rebuild the Mac app with the installed version: `setup --no-mcp`, non-interactive. */
export function runSetup({ root = ROOT, timeoutMs = 4 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "src", "cli.js"), "setup", "--no-mcp"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out = (out + c).slice(-2000); });
    child.stderr.on("data", (c) => { out = (out + c).slice(-2000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}

// ---- stopping servers ----

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
export function registeredServers() {
  const map = readJson(serversFile()) || {};
  const urls = new Set();
  for (const v of Object.values(map)) {
    try { const u = new URL(String(v)); if (u.protocol === "http:" && LOCAL.test(u.hostname)) urls.add(u.origin); } catch {}
  }
  return [...urls];
}

async function postQuit(url, force) {
  try {
    const r = await fetch(`${url}/api/quit`, {
      method: "POST", headers: { "content-type": "application/json", "x-tokenwise": "1" },
      body: JSON.stringify(force ? { force: true } : {}), signal: AbortSignal.timeout(2500),
    });
    if (r.ok) return "quit";
    if (r.status === 409) return "busy";
    return r.status === 404 || r.status === 400 ? "unsupported" : "failed";
  } catch { return "gone"; }
}

/**
 * Ask studio servers to exit. Busy ones (running jobs) refuse unless `force`.
 * Returns { quit, busy, unsupported, gone, failed } counts. `except` is an origin to leave alone.
 */
export async function quitStudioServers({ except = null, force = false, urls = registeredServers() } = {}) {
  const out = { quit: 0, busy: 0, unsupported: 0, gone: 0, failed: 0 };
  for (const u of urls) {
    if (except && u === except) continue;
    out[await postQuit(u, force)]++;
  }
  return out;
}
