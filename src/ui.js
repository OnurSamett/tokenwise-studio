#!/usr/bin/env node
// tokenwise studio web UI + API. Usage: tokenwise-studio-ui [repo-path] [--port 4777]
// Binds to 127.0.0.1 only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Jobs } from "./jobs.js";
import { Chats } from "./orchestrator.js";
import { normalize } from "./events.js";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--port");
const port = pi >= 0 ? Number(argv[pi + 1]) : Number(process.env.PORT || 4777);
const repo = path.resolve(argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port") || process.env.TOKENWISE_REPO || process.cwd());
const jobs = new Jobs(repo);
const chats = new Chats(jobs);
const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");

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

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const from = Number(url.searchParams.get("from") || 0);
  const m = url.pathname.match(/^\/api\/(\w+)(?:\/([\w-]+))?$/);
  try {
    if (url.pathname === "/") return send(res, 200, fs.readFileSync(htmlPath, "utf8"), "text/html; charset=utf-8");
    if (url.pathname === "/logo.png" || url.pathname === "/favicon.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      return res.end(fs.readFileSync(path.join(path.dirname(htmlPath), "..", "assets", "logo.png")));
    }
    if (!m) return send(res, 404, { error: "not found" });
    const [, what, id] = m;
    if (req.method === "GET") {
      if (what === "state") return send(res, 200, { repo, chats: chats.list(), jobs: jobs.list() });
      if (what === "chatlog") return send(res, 200, chatTimeline(id, from));
      if (what === "log") return send(res, 200, jobTimeline(id, from));
      if (what === "diff") return send(res, 200, { files: splitDiff(jobs.diff(id)) });
    }
    if (req.method === "POST") {
      const b = await readBody(req);
      if (what === "chat") return send(res, 200, chats.send(b));
      if (what === "stop") return send(res, 200, chats.stop(id));
      if (what === "merge") return send(res, 200, jobs.merge(id, b.files));
      if (what === "discard") return send(res, 200, jobs.discard(id));
      if (what === "delegate") return send(res, 200, jobs.start({ ...b, parent: null }));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
}).listen(port, "127.0.0.1", () => console.log(`tokenwise studio: http://127.0.0.1:${port}  (repo: ${repo})`));
