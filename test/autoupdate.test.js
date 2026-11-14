import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";

import { decideAutoUpdate, runAutoUpdate, readyFor, needsAppSetup, launcherHash, readUpdateState, DAY_MS } from "../src/autoupdate.js";
import { installArgs } from "../src/version.js";
import { handler, initServer, hooks } from "../src/ui.js";
import { DEFAULTS, saveSettings, loadSettings } from "../src/settings.js";

const tmp = (p = "tw-au-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
function withHome(fn) {
  const prev = process.env.HOME, home = tmp("tw-au-home-");
  process.env.HOME = home;
  const done = () => { process.env.HOME = prev; fs.rmSync(home, { recursive: true, force: true }); };
  return Promise.resolve().then(() => fn(home)).finally(done);
}

const base = { mode: "auto", updateCheck: true, source: "github", current: "0.8.0", latest: { version: "0.9.0", source: "github" }, busy: false, lastAttemptAt: 0, ready: null, now: 1_000_000_000_000 };

test("decideAutoUpdate: installs a newer version with the same source rule as `update`", () => {
  const d = decideAutoUpdate(base);
  assert.equal(d.action, "install");
  assert.deepEqual(d.args, ["install", "-g", "github:OnurSamett/tokenwise-studio"]);
  const n = decideAutoUpdate({ ...base, latest: { version: "0.9.0", source: "npm" } });
  assert.deepEqual(n.args, ["install", "-g", "tokenwise-studio@latest"]);
  assert.deepEqual(installArgs("npm"), n.args);
});

test("decideAutoUpdate: skips for mode, dev checkout, update check off, up to date, already installed", () => {
  assert.equal(decideAutoUpdate({ ...base, mode: "notify" }).reason, "mode");
  assert.equal(decideAutoUpdate({ ...base, mode: "off" }).reason, "mode");
  assert.equal(decideAutoUpdate({ ...base, source: "dev" }).reason, "dev checkout");
  assert.equal(decideAutoUpdate({ ...base, updateCheck: false }).action, "skip");
  assert.equal(decideAutoUpdate({ ...base, current: "0.9.0" }).reason, "up to date");
  assert.equal(decideAutoUpdate({ ...base, current: "1.0.0" }).reason, "up to date");
  assert.equal(decideAutoUpdate({ ...base, ready: { version: "0.9.0" } }).reason, "already installed");
  assert.equal(decideAutoUpdate({ ...base, latest: null }).retry, true);
});

test("decideAutoUpdate: busy waits and retries; at most one attempt per 24h", () => {
  const b = decideAutoUpdate({ ...base, busy: true });
  assert.deepEqual([b.action, b.reason, b.retry], ["skip", "busy", true]);
  assert.equal(decideAutoUpdate({ ...base, lastAttemptAt: base.now - DAY_MS + 1000 }).reason, "tried within 24h");
  assert.equal(decideAutoUpdate({ ...base, lastAttemptAt: base.now - DAY_MS - 1000 }).action, "install");
});

function harness(over = {}) {
  const calls = { install: [], log: [] };
  const state = {};
  const deps = {
    mode: () => "auto", updateCheck: () => true, source: () => "github", current: () => "0.8.0",
    latest: async () => ({ version: "0.9.0", source: "github" }), busy: () => false,
    install: async (args) => { calls.install.push(args); return { ok: true, out: "" }; },
    now: () => 5_000_000_000_000, readState: () => state, writeState: (p) => Object.assign(state, p),
    log: (m) => calls.log.push(m), lock: async (fn) => ({ locked: false, value: await fn() }),
    ...over,
  };
  return { deps, calls, state };
}

test("runAutoUpdate: installs, records update-ready and the attempt, logs", async () => {
  const { deps, calls, state } = harness();
  const r = await runAutoUpdate(deps);
  assert.equal(r.action, "installed");
  assert.equal(calls.install.length, 1);
  assert.equal(state.ready.version, "0.9.0");
  assert.ok(state.autoAttemptAt);
  assert.ok(calls.log.some((l) => /installing 0\.9\.0/.test(l)));
  // A second pass within 24h does nothing, and does not even ask for the latest version.
  let asked = false;
  const r2 = await runAutoUpdate({ ...deps, latest: async () => { asked = true; return null; } });
  assert.equal(r2.action, "skip");
  assert.equal(asked, false);
});

test("runAutoUpdate: never installs while busy, does not burn the 24h attempt, retries later", async () => {
  let busy = true;
  const { deps, calls, state } = harness({ busy: () => busy });
  const r = await runAutoUpdate(deps);
  assert.deepEqual([r.action, r.reason], ["skip", "busy"]);
  assert.equal(calls.install.length, 0);
  assert.equal(state.autoAttemptAt, undefined);
  busy = false;
  assert.equal((await runAutoUpdate(deps)).action, "installed");
});

test("runAutoUpdate: failed install is logged, remembered, and not retried within 24h", async () => {
  const { deps, calls, state } = harness({ install: async () => ({ ok: false, out: "EACCES: permission denied" }) });
  const r = await runAutoUpdate(deps);
  assert.equal(r.action, "failed");
  assert.equal(state.ready, undefined);
  assert.equal(state.autoFailed.version, "0.9.0");
  assert.ok(calls.log.some((l) => /install failed.*EACCES/.test(l)));
  assert.equal((await runAutoUpdate(deps)).action, "skip");
});

test("runAutoUpdate: notify/off modes and dev checkouts never touch the network or npm", async () => {
  for (const o of [{ mode: () => "notify" }, { mode: () => "off" }, { source: () => "dev" }, { updateCheck: () => false }]) {
    const { deps, calls } = harness({ ...o, latest: async () => { throw new Error("network"); } });
    const r = await runAutoUpdate(deps);
    assert.equal(r.action, "skip");
    assert.equal(calls.install.length, 0);
  }
});

test("runAutoUpdate: another updater holding the lock means skip", async () => {
  const { deps, calls } = harness({ lock: async () => ({ locked: true }) });
  const r = await runAutoUpdate(deps);
  assert.equal(r.action, "skip");
  assert.equal(calls.install.length, 0);
});

test("readyFor: only when the installed version is newer than what this process loaded", () => {
  assert.equal(readyFor("0.8.0", { ready: { version: "0.9.0" } }).version, "0.9.0");
  assert.equal(readyFor("0.9.0", { ready: { version: "0.9.0" } }), null);
  assert.equal(readyFor("0.8.0", {}), null);
});

test("needsAppSetup: compares the Swift source hash stored in the app's config.json", () => {
  const root = tmp("tw-root-"), app = tmp("tw-app-");
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    fs.writeFileSync(path.join(root, "launcher", "TokenwiseStudio.swift"), "// v1");
    const h = crypto.createHash("sha256").update("// v1").digest("hex");
    assert.equal(launcherHash(root), h);
    assert.equal(needsAppSetup({ platform: "darwin", root, app }), false, "no app installed");
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<string>com.nolienlabs.tokenwise-studio</string>");
    assert.equal(needsAppSetup({ platform: "darwin", root, app }), true, "old app without a stored hash");
    fs.writeFileSync(path.join(app, "Contents", "Resources", "config.json"), JSON.stringify({ launcherHash: h }));
    assert.equal(needsAppSetup({ platform: "darwin", root, app }), false);
    fs.writeFileSync(path.join(root, "launcher", "TokenwiseStudio.swift"), "// v2");
    assert.equal(needsAppSetup({ platform: "darwin", root, app }), true);
    assert.equal(needsAppSetup({ platform: "linux", root, app }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true }); }
});

test("settings: autoUpdate defaults to auto and validates", () => withHome(() => {
  assert.equal(DEFAULTS.autoUpdate, "auto");
  assert.equal(loadSettings().autoUpdate, "auto");
  assert.equal(saveSettings({ autoUpdate: "notify" }).autoUpdate, "notify");
  assert.throws(() => saveSettings({ autoUpdate: "yes" }), /autoUpdate/);
}));

async function call(method, urlPath, { headers = {}, body } = {}) {
  const req = new PassThrough();
  req.method = method; req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", ...(method === "POST" ? { "x-tokenwise": "1" } : {}), ...headers };
  let status = 200; const chunks = [];
  const res = { writeHead(c) { status = c; }, end(d) { if (d) chunks.push(Buffer.from(String(d))); }, on() {} };
  const p = handler(req, res);
  if (method === "POST") req.end(JSON.stringify(body ?? {})); else req.end();
  await p;
  const text = Buffer.concat(chunks).toString();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status, json };
}

test("/api/state and /api/version carry the loaded version; /api/quit is CSRF protected and exits", () => withHome(async (home) => {
  const repo = tmp("tw-au-repo-");
  const exits = []; const real = hooks.exit; hooks.exit = (c) => exits.push(c);
  try {
    initServer({ repo });
    const st = await call("GET", "/api/state");
    assert.match(st.json.version, /^\d+\.\d+\.\d+/);
    const v = await call("GET", "/api/version");
    assert.equal(v.json.loaded, st.json.version);
    assert.equal(v.json.autoUpdate, "auto");
    assert.equal(v.json.ready, null);

    assert.equal((await call("POST", "/api/quit", { headers: { "x-tokenwise": "" } })).status, 403, "missing header");
    assert.equal((await call("POST", "/api/quit", { headers: { origin: "https://evil.example" } })).status, 403, "foreign origin");
    assert.equal((await call("POST", "/api/quit", { headers: { host: "evil.example" } })).status, 403, "foreign host");
    assert.equal((await call("GET", "/api/quit")).status, 404, "GET does nothing");
    assert.equal(exits.length, 0);

    const ok = await call("POST", "/api/quit", { headers: { origin: "http://127.0.0.1:4790" } });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 1700));
    assert.ok(exits.length >= 1);
  } finally { hooks.exit = real; fs.rmSync(repo, { recursive: true, force: true }); }
}));
