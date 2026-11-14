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
import { Jobs } from "./jobs.js";
import { Chats } from "./orchestrator.js";
import { normalize } from "./events.js";
import { limits } from "./limits.js";
import { doctor } from "./doctor.js";
import { loadTeam, saveTeam, teamOptions, geminiFamilies } from "./team.js";
import { CATALOG } from "./models.js";
import { listFreeModels } from "./freechat.js";


const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");
let repo, jobs, chats; // current project; replaced by POST /api/project

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
  repo = p; jobs = new Jobs(repo); chats = new Chats(jobs);
  remember(repo);
}
const state = () => ({ repo, project: { path: repo, name: path.basename(repo) }, recents: recents(), chats: chats.list(), jobs: jobs.list(),
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
    if (e.stream === "user") { items.push({ t: e.t, kind: "user", text: e.line, turn: e.turn }); continue; }
    for (const it of normalize("claude", e, repo)) items.push({ t: e.t, turn: e.turn, ...it });
  }
  return { items, next };
}

function splitDiff(raw) {
  if (!raw) return [];
  return raw.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git")).map((patch) => {
    const m = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const add = (patch.match(/^\+(?!\+\+)/gm) || []).length, del = (patch.match(/^-(?!--)/gm) || []).length;
    return { path: m ? m[2] : "?", add, del, patch };
  });
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

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

const handler = async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url, "http://x");
  const from = Number(url.searchParams.get("from") || 0);
  const m = url.pathname.match(/^\/api\/(\w+)(?:\/([\w-]+))?$/);
  try {
    if (url.pathname === "/") return send(res, 200, fs.readFileSync(htmlPath, "utf8"), "text/html; charset=utf-8");
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
      if (what === "state") return send(res, 200, state());
      if (what === "staged") return send(res, 200, { files: staged() });
      if (what === "doctor") return send(res, 200, doctor());
      if (what === "team") return send(res, 200, { team: loadTeam(jobs.home), options: teamOptions(await listFreeModels()) });
      if (what === "models") {
        const d = doctor(), ok = (a) => !!(d[a] && d[a].installed && d[a].signedIn);
        return send(res, 200, {
          catalog: CATALOG,
          available: { codex: ["luna", "terra", "sol", "astra"], claude: ["haiku", "sonnet", "opus"], gemini: geminiFamilies(), free: (await listFreeModels()).map((m) => m.id) },
          ready: { codex: ok("codex"), claude: ok("claude"), gemini: ok("gemini"), free: ok("free") },
        });
      }
      if (what === "limits") return send(res, 200, limits(jobs.home));
      if (what === "chatlog") return send(res, 200, chatTimeline(id, from));
      if (what === "log") return send(res, 200, jobTimeline(id, from));
      if (what === "diff") return send(res, 200, { files: splitDiff(jobs.diff(id)) });
    }
    if (req.method === "POST") {
      const b = await readBody(req);
      if (what === "team") return send(res, 200, { team: saveTeam(jobs.home, b) });
      if (what === "chat") return send(res, 200, chats.send(b));
      if (what === "stop") return send(res, 200, chats.stop(id));
      if (what === "merge") return send(res, 200, jobs.merge(id, b.files));
      if (what === "discard") return send(res, 200, jobs.discard(id));
      if (what === "rename") return send(res, 200, chats.rename(id, b.title));
      if (what === "delete") return send(res, 200, chats.remove(id));
      if (what === "commit") {
        const message = String(b.message || "").trim();
        if (!message) throw new Error("commit message is empty");
        const files = staged();
        if (!files.length) throw new Error("nothing is staged");
        gitIn("commit", "-m", message);
        return send(res, 200, { ok: true, sha: gitIn("rev-parse", "--short", "HEAD").trim(), files: files.length });
      }
      if (what === "project") {
        const p = path.resolve(String(b.path || "").replace(/^~(?=$|[\\/])/, os.homedir()));
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`);
        openProject(p);
        return send(res, 200, state());
      }
      if (what === "delegate") return send(res, 200, jobs.start({ ...b, parent: null }));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
};

export function startServer({ repo: start, port = 4777 } = {}) {
  openProject(path.resolve(start || process.cwd()));
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf("--port");
  const port = pi >= 0 ? Number(argv[pi + 1]) : Number(process.env.PORT || 4777);
  const start = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port") || process.env.TOKENWISE_REPO || process.cwd();
  startServer({ repo: start, port }).then((url) => console.log(`tokenwise studio: ${url}  (repo: ${repo})`));
}
