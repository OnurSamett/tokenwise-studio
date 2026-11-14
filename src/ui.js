#!/usr/bin/env node
// tokenwise studio web UI + API. Usage: tokenwise-studio-ui [repo-path] [--port 4777]
// Binds to 127.0.0.1 only.
import "./env-init.js"; // must stay first: loads API keys / PATH from the login shell
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { saveUpload, resolveUpload, UPLOAD_BODY_LIMIT } from "./uploads.js";
import { Jobs } from "./jobs.js";
import { Chats, pickOrchestrator } from "./orchestrator.js";
import { normalize } from "./events.js";
import { limits } from "./limits.js";
import { doctor, clearDoctorCache } from "./doctor.js";
import { loadTeam, saveTeam, teamOptions, geminiFamilies } from "./team.js";
import { CATALOG } from "./models.js";
import { listFreeModels } from "./freechat.js";
import { loadSettings, saveSettings, settingsInfo } from "./settings.js";
import { exportChat, backupAll } from "./export.js";
import { loadInstructions, instructionsPath, workerNotes, INSTRUCTIONS_CAP, INSTRUCTIONS_FILE } from "./instructions.js";
import { aggregateUsage } from "./usage.js";
import { resolveJobImage, imageType } from "./jobimages.js";
import { runTests, testRunning, testTail, detectTestCommand, loadTestOverride, loadLintOverride, saveTestConfig, runCombinedCheck, loadCombinedCheck, combinedCheckRunning, combinedTail } from "./testrun.js";
import { createSnapshot } from "./snapshots.js";
import { currentVersion, installSource, latestVersion, cachedLatest, compareVersions } from "./version.js";
import { runAutoUpdate, readyFor, readUpdateState, needsAppSetup, runSetup, quitStudioServers, logUpdate } from "./autoupdate.js";
import { parseStudioErrors, formatStudioPrompt } from "./studiolog.js";


const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");
const i18nPath = path.join(path.dirname(htmlPath), "i18n.js");
const citationsPath = path.join(path.dirname(htmlPath), "citations.js");
// The version this process was started with. package.json on disk changes under a long-running server
// when it is upgraded, so the page and the app compare against this, not against the file.
const LOADED_VERSION = currentVersion();
export const hooks = { exit: (code) => process.exit(code) }; // replaced in tests
let repo, jobs, chats; // current project; replaced by POST /api/project
let serverChatOpts = {};

const RECENTS = path.join(os.homedir(), ".tokenwise-studio", "recents.json");
function recents() {
  try { const r = JSON.parse(fs.readFileSync(RECENTS, "utf8")); return Array.isArray(r) ? r.filter((x) => typeof x === "string") : []; } catch { return []; }
}
function remember(p) {
  const list = [p, ...recents().filter((x) => x !== p)].slice(0, 8);
  try { fs.mkdirSync(path.dirname(RECENTS), { recursive: true }); fs.writeFileSync(RECENTS, JSON.stringify(list, null, 2)); } catch {}
  return list;
}
function openProject(p) {
  repo = p; jobs = new Jobs(repo); chats = new Chats(jobs, serverChatOpts);
  remember(repo);
}
function combinedCheckInfo() {
  const c = loadCombinedCheck(jobs);
  if (!c) return null;
  const running = combinedCheckRunning(jobs);
  const tail = combinedTail(jobs) || c.tail || "";
  const status = c.status === "running" && !running ? "error" : c.status;
  return { ...c, status, tail };
}
const state = () => ({ version: LOADED_VERSION, repo, project: { path: repo, name: path.basename(repo) }, recents: recents(), chats: chats.list(),
  jobs: jobs.list().map(({ test, applyPost, ...j }) => (test ? { ...j, test: { ...test, tail: undefined } } : j)),
  combinedCheck: combinedCheckInfo(),
  team: (({ mode, preset }) => ({ mode, preset }))(loadTeam(jobs.home)) });

const gitIn = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const staged = () => { try { return gitIn("diff", "--cached", "--name-only").split("\n").filter(Boolean); } catch { return []; } };

function jobTimeline(id, from = 0) {
  const j = jobs.get(id);
  const f = jobs.file(id, "log");
  if (!fs.existsSync(f)) return { items: [], next: 0 };
  const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const items = [];
  for (const l of all.slice(from)) {
    try { const e = JSON.parse(l); for (const it of normalize(j.agent, e, j.cwd)) items.push({ t: e.t, ...it }); } catch {}
  }
  return { items, next: all.length };
}

function chatTimeline(id, from = 0) {
  const { entries, next } = chats.log(id, from);
  const items = [];
  for (const e of entries) {
    if (e.stream === "user") { items.push({ t: e.t, kind: "user", text: e.line, images: e.images || [], turn: e.turn }); continue; }
    for (const it of normalize(e.agent || "claude", e, repo)) items.push({ t: e.t, turn: e.turn, ...it });
  }
  return { items, next };
}

function splitDiff(raw) {
  if (!raw) return [];
  return raw.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git")).map((patch) => {
    const m = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const add = (patch.match(/^\+(?!\+\+)/gm) || []).length, del = (patch.match(/^-(?!--)/gm) || []).length;
    const p = m ? m[2] : "?";
    // Binary files (generated images): keep the header only; the base85 body is useless in a review and can be huge.
    if (/^GIT binary patch$|^Binary files /m.test(patch)) {
      const head = patch.split("\n").filter((l) => /^(diff --git|new file mode|deleted file mode|similarity|rename )/.test(l)).join("\n");
      return { path: p, add: 0, del: 0, binary: true, image: !!imageType(p), deleted: /^deleted file mode/m.test(patch), patch: head + "\n" };
    }
    return { path: p, add, del, patch };
  });
}

// Instructions file state for Settings and the editor drawer. `text` is what the editor shows (the whole file).
const MAX_INSTRUCTIONS_WRITE = 256 * 1024;
function instructionsInfo() {
  const loaded = loadInstructions(repo);
  let text = "", exists = false;
  for (const rel of [INSTRUCTIONS_FILE, ".tokenwise-studio/instructions.md"]) {
    try {
      const f = path.join(repo, rel), st = fs.lstatSync(f);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_INSTRUCTIONS_WRITE) continue;
      if (rel === INSTRUCTIONS_FILE) exists = true;
      const t = fs.readFileSync(f, "utf8");
      if (rel === INSTRUCTIONS_FILE || t.trim()) { text = t; break; }
    } catch {}
  }
  return { path: instructionsPath(repo), file: INSTRUCTIONS_FILE, exists, text, cap: INSTRUCTIONS_CAP,
    loaded: !!loaded, source: loaded ? loaded.rel : null, bytes: loaded ? loaded.bytes : 0, truncated: !!loaded?.truncated, workerNotes: !!workerNotes(loaded) };
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0, exceeded = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) { if (!exceeded) reject(new Error("request body too large")); exceeded = true; chunks.length = 0; }
    else if (!exceeded) chunks.push(c);
  });
  req.on("error", reject);
  req.on("end", () => {
    if (exceeded) return;
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
    catch { reject(new Error("invalid JSON")); }
  });
});

// Only answer requests addressed to this machine (blocks DNS rebinding), and require a custom
// header plus a local Origin on every state-changing request (blocks CSRF from other websites:
// browsers can't send a custom header cross-origin without a CORS preflight, which we never grant).
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
function allowed(req) {
  if (!LOCAL_HOST.test(req.headers.host || "")) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers["x-tokenwise"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin) { try { if (!LOCAL_HOST.test(new URL(origin).host)) return false; } catch { return false; } }
  return true;
}

// Benchmark table (src/benchmarks.json): read fresh each time so edits show up without a restart.
function loadBenchmarks() {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "benchmarks.json"), "utf8")); }
  catch { return null; }
}

// Who would orchestrate the next message right now. pickOrchestrator runs CLI sign-in checks,
// so the answer is cached briefly per model/effort.
const orchCache = new Map();
function orchestratorNow(model, effort) {
  if (!["opus", "sonnet", "haiku"].includes(model)) model = "opus";
  if (!["low", "medium", "high", "xhigh"].includes(effort)) effort = "medium";
  const key = `${jobs.home}|${model}|${effort}`, hit = orchCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const p = pickOrchestrator(jobs.home, model, effort);
  const v = { agent: p.agent, model: p.model, effort: p.effort, reason: p.reason || null };
  orchCache.set(key, { at: Date.now(), v });
  return v;
}

// Update check for the sidebar: cached answer if fresh, else kick off a background check and answer latest:null.
let versionCheck = null;
function versionInfo() {
  const current = currentVersion(), source = installSource(), settings = loadSettings();
  const base = { current, loaded: LOADED_VERSION, source, autoUpdate: settings.autoUpdate, ready: readyFor(LOADED_VERSION), autoFailed: !!readUpdateState().autoFailed };
  if (!settings.updateCheck) return { ...base, latest: null, updateAvailable: false, disabled: true };
  const c = cachedLatest();
  if (!c && !versionCheck) versionCheck = latestVersion().catch(() => null).finally(() => { versionCheck = null; });
  return { ...base, latest: c ? c.version : null, updateAvailable: !!c && compareVersions(c.version, current) > 0 };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Is anything running in this project: a job, a test run, a check, an orchestrator turn? */
export function studioBusy() {
  if (!jobs || !chats) return false;
  if (jobs.running.size || jobs.testing.size || jobs.combinedChecking?.active || chats.running.size) return true;
  try { return jobs.list().some((j) => j.status === "running" && (!j.pid || alive(j.pid))); } catch { return false; }
}

// Background auto-update (Settings > Updates). Checks soon after start, then hourly; the 24h limit lives in update.json.
let autoTimer = null;
export function startAutoUpdater({ firstDelayMs = 60_000, everyMs = 3600_000 } = {}) {
  if (autoTimer || process.env.TOKENWISE_NO_AUTOUPDATE === "1") return;
  const tick = async () => {
    const r = await runAutoUpdate({ busy: studioBusy });
    if (r.action === "failed") logUpdate(`auto-update of ${r.version} failed; will try again in 24h`);
  };
  const first = setTimeout(() => { tick(); autoTimer = setInterval(tick, everyMs); autoTimer.unref?.(); }, firstDelayMs);
  first.unref?.();
  autoTimer = first;
}

// Exit after the response has been flushed (graceful: servers.json is cleaned by the exit hook).
const exitSoon = (res) => { res.on?.("finish", () => setTimeout(() => hooks.exit(0), 100)); setTimeout(() => hooks.exit(0), 1500).unref?.(); };

export function initServer({ repo: start, summarize, spawn } = {}) {
  serverChatOpts = { ...(summarize ? { summarize } : {}), ...(spawn ? { spawn } : {}) };
  openProject(path.resolve(start || process.cwd()));
}

export const handler = async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url, "http://x");
  const from = Number(url.searchParams.get("from") || 0);
  const m = url.pathname.match(/^\/api\/(\w+)(?:\/([\w-]+))?$/);
  try {
    if (url.pathname === "/") return send(res, 200, fs.readFileSync(htmlPath, "utf8"), "text/html; charset=utf-8");
    if (url.pathname === "/i18n.js") return send(res, 200, fs.readFileSync(i18nPath, "utf8"), "application/javascript; charset=utf-8");
    if (url.pathname === "/citations.js") return send(res, 200, fs.readFileSync(citationsPath, "utf8"), "application/javascript; charset=utf-8");
    // Provider logos (unmodified lobe-icons SVGs, see assets/providers/NOTICE.md). Names are whitelisted by pattern.
    const lm = url.pathname.match(/^\/providers\/([a-z0-9-]{1,30})\.svg$/);
    if (lm) {
      const f = path.join(path.dirname(htmlPath), "..", "assets", "providers", lm[1] + ".svg");
      if (!fs.existsSync(f)) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
      let svg = fs.readFileSync(f, "utf8");
      // Marks drawn with currentColor are meant to take the surrounding text colour; inside <img> that would be
      // black, so fill it in from ?fg=<hex> (the file on disk stays unmodified).
      const fg = url.searchParams.get("fg");
      if (fg && /^[0-9a-f]{6}$/i.test(fg)) svg = svg.replace(/<svg\b/, `<svg color="#${fg}"`);
      return res.end(svg);
    }
    if (url.pathname === "/logo.png" || url.pathname === "/favicon.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
      const file = url.pathname === "/favicon.png" ? "favicon-64.png" : "logo.png";
      return res.end(fs.readFileSync(path.join(path.dirname(htmlPath), "..", "assets", file)));
    }
    if (!m) return send(res, 404, { error: "not found" });
    const [, what, id] = m;
    if (req.method === "GET") {
      if (what === "upload") {
        const image = resolveUpload(repo, url.searchParams.get("path"));
        return send(res, 200, fs.readFileSync(image.abs), image.type);
      }
      if (what === "usage") return send(res, 200, aggregateUsage({ chats: chats.list(), jobs: jobs.list(), days: Number(url.searchParams.get("days") || 14) }));
      if (what === "jobimage") {
        const img = resolveJobImage(jobs, url.searchParams.get("job"), url.searchParams.get("path"));
        res.writeHead(200, { "content-type": img.type, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
        return res.end(fs.readFileSync(img.abs));
      }
      if (what === "test") { const j = jobs.get(id); return send(res, 200, { test: j.test || null, running: testRunning(j), tail: testTail(jobs, id) || j.test?.tail || "" }); }
      if (what === "combinedcheck") { const c = combinedCheckInfo(); return send(res, 200, { check: c, running: combinedCheckRunning(jobs), tail: c?.tail || "" }); }
      if (what === "testcmd") {
        const d = detectTestCommand(repo);
        return send(res, 200, { override: loadTestOverride(jobs.home), lint: loadLintOverride(jobs.home), detected: d ? { label: d.label, source: d.source } : null });
      }
      if (what === "state") return send(res, 200, state());
      if (what === "export") {
        const fmt = url.searchParams.get("format") === "json" ? "json" : "md";
        const x = exportChat(jobs, chats, id);
        res.writeHead(200, { "content-type": fmt === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${x.name}.${fmt}"`, "cache-control": "no-store" });
        return res.end(fmt === "json" ? x.json : x.md);
      }
      if (what === "instructions") return send(res, 200, instructionsInfo());
      if (what === "staged") return send(res, 200, { files: staged() });
      if (what === "doctor") return send(res, 200, doctor());
      if (what === "team") return send(res, 200, { team: loadTeam(jobs.home), options: teamOptions(await listFreeModels()) });
      if (what === "models") {
        const d = doctor(), ok = (a) => !!(d[a] && d[a].installed && d[a].signedIn);
        return send(res, 200, {
          catalog: CATALOG,
          available: { codex: ["luna", "terra", "sol", "astra"], claude: ["haiku", "sonnet", "opus"], gemini: geminiFamilies(), free: (await listFreeModels()).map((m) => m.id) },
          ready: { codex: ok("codex"), claude: ok("claude"), gemini: ok("gemini"), free: ok("free") },
          benchmarks: loadBenchmarks(),
        });
      }
      if (what === "settings") return send(res, 200, settingsInfo());
      if (what === "version") return send(res, 200, versionInfo());
      if (what === "limits") return send(res, 200, limits(jobs.home));
      if (what === "orchestrator") return send(res, 200, orchestratorNow(url.searchParams.get("model"), url.searchParams.get("effort")));
      if (what === "chatlog") return send(res, 200, chatTimeline(id, from));
      if (what === "log") return send(res, 200, jobTimeline(id, from));
      if (what === "diff") return send(res, 200, { files: splitDiff(jobs.diff(id)), conflicts: jobs.conflicts(id) });
      if (what === "conflicts") return send(res, 200, jobs.conflicts(id));
    }
    if (req.method === "POST") {
      const b = await readBody(req, what === "upload" ? UPLOAD_BODY_LIMIT : undefined);
      if (what === "upload") return send(res, 200, saveUpload(repo, b));
      if (what === "studiolog") {
        if (b?.action === "format") return send(res, 200, { message: formatStudioPrompt(b.selected) });
        if (typeof b?.text !== "string") throw new Error("text must be a string");
        return send(res, 200, parseStudioErrors(b.text, { repo }));
      }
      if (what === "settings") {
        saveSettings(b);
        orchCache.clear();
        clearDoctorCache();
        return send(res, 200, settingsInfo());
      }
      if (what === "backup") return send(res, 200, backupAll(jobs, chats));
      if (what === "instructions") {
        if (typeof b.text !== "string") throw new Error("text must be a string");
        if (Buffer.byteLength(b.text) > MAX_INSTRUCTIONS_WRITE) throw new Error("instructions are too large (256 KB max)");
        const f = instructionsPath(repo);
        try { if (fs.lstatSync(f).isSymbolicLink()) throw new Error(`${INSTRUCTIONS_FILE} is a symlink; edit it directly`); } catch (e) { if (e.code !== "ENOENT") throw e; }
        fs.writeFileSync(f, b.text);
        return send(res, 200, instructionsInfo());
      }
      if (what === "test") { const { job } = runTests(jobs, id); return send(res, 200, { test: { ...job.test, tail: undefined }, running: true }); }
      if (what === "combinedcheck") { const { check } = runCombinedCheck(jobs); return send(res, 200, { check, running: true }); }
      if (what === "testcmd") {
        saveTestConfig(jobs.home, {
          ...(b.command !== undefined ? { command: b.command } : {}),
          ...(b.lint !== undefined ? { lint: b.lint } : {}),
        });
        const d = detectTestCommand(repo);
        return send(res, 200, { override: loadTestOverride(jobs.home), lint: loadLintOverride(jobs.home), detected: d ? { label: d.label, source: d.source } : null });
      }
      if (what === "team") return send(res, 200, { team: saveTeam(jobs.home, b) });
      if (what === "chat") return send(res, 200, chats.send(b));
      if (what === "stop") return send(res, 200, chats.stop(id));
      if (what === "merge") return send(res, 200, jobs.merge(id, b.files, { autoCheck: b.autoCheck !== false }));
      if (what === "rebase") return send(res, 200, jobs.rebase(id));
      if (what === "resolve") return send(res, 200, jobs.resolveConflict(id, b));
      if (what === "quit") {
        if (studioBusy() && b.force !== true) return send(res, 409, { error: "busy", busy: true });
        send(res, 200, { ok: true });
        return exitSoon(res);
      }
      if (what === "restart") {
        if (studioBusy()) return send(res, 409, { error: "busy", busy: true });
        let setup = null;
        if (needsAppSetup()) { logUpdate("launcher changed: running setup --no-mcp"); setup = (await runSetup()).ok; logUpdate(`setup ${setup ? "ok" : "failed"}`); }
        const others = await quitStudioServers({ except: serverUrl });
        logUpdate(`restart: ${JSON.stringify(others)}`);
        send(res, 200, { ok: true, setup, others });
        return exitSoon(res);
      }
      if (what === "undo") return send(res, 200, jobs.undo(id));
      if (what === "discard") return send(res, 200, jobs.discard(id));
      if (what === "rename") return send(res, 200, chats.rename(id, b.title));
      if (what === "compact") return send(res, 200, await chats.compact(id));
      if (what === "delete") return send(res, 200, chats.remove(id));
      if (what === "commit") {
        const message = String(b.message || "").trim();
        if (!message) throw new Error("commit message is empty");
        const files = staged();
        if (!files.length) throw new Error("nothing is staged");
        createSnapshot(repo, "commit", files);
        gitIn("commit", "-m", message);
        return send(res, 200, { ok: true, sha: gitIn("rev-parse", "--short", "HEAD").trim(), files: files.length });
      }
      if (what === "project") {
        const p = path.resolve(String(b.path || "").replace(/^~(?=$|[\\/])/, os.homedir()));
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`);
        openProject(p);
        if (serverUrl) registerServer(p, serverUrl);
        return send(res, 200, state());
      }
      if (what === "delegate") return send(res, 200, jobs.start({ ...b, parent: null }));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
};

// ~/.tokenwise-studio/servers.json maps project path -> running server URL (read by the notification app).
const serversFile = () => path.join(os.homedir(), ".tokenwise-studio", "servers.json");
function updateServers(fn) {
  try {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(serversFile(), "utf8")) || {}; } catch {}
    fn(map);
    fs.mkdirSync(path.dirname(serversFile()), { recursive: true });
    const tmp = `${serversFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, serversFile());
  } catch {}
}
let cleanupHooked = false;
const ownUrls = new Set();
let serverUrl = null;
function registerServer(repoPath, url) {
  serverUrl = url;
  // One server shows one project at a time: drop older entries for this URL (e.g. after switching project).
  updateServers((m) => { for (const k of Object.keys(m)) if (m[k] === url) delete m[k]; m[repoPath] = url; });
  ownUrls.add(url);
  if (cleanupHooked) return;
  cleanupHooked = true;
  const clean = () => updateServers((m) => { for (const k of Object.keys(m)) if (ownUrls.has(m[k])) delete m[k]; });
  process.on("exit", clean);
  // Only take over signals when nothing else handles them, so default termination behaviour is kept.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    if (process.listenerCount(sig) === 0) process.on(sig, () => { clean(); process.exit(0); });
  }
}

let activeServer = null;
export function startServer({ repo: start, port = 4777, summarize, spawn } = {}) {
  initServer({ repo: start, summarize, spawn });
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      activeServer = server;
      const url = `http://127.0.0.1:${server.address().port}`;
      registerServer(path.resolve(start || process.cwd()), url);
      resolve(url);
    });
  });
}

export function stopServer() {
  return new Promise((resolve) => {
    if (!activeServer) return resolve();
    const s = activeServer;
    activeServer = null;
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf("--port");
  const port = pi >= 0 ? Number(argv[pi + 1]) : Number(process.env.PORT || 4777);
  const start = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port") || process.env.TOKENWISE_REPO || process.cwd();
  startServer({ repo: start, port }).then((url) => { startAutoUpdater(); return url; }).then((url) => console.log(`tokenwise studio: ${url}  (repo: ${repo})`));
}
