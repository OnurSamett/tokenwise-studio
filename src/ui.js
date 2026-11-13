#!/usr/bin/env node
// Local web UI for tokenwise-studio. Usage: tokenwise-studio-ui [repo-path] [--port 4777]
// Binds to 127.0.0.1 only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Jobs } from "./jobs.js";
import { textOf } from "./workers.js";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--port");
const port = pi >= 0 ? Number(argv[pi + 1]) : Number(process.env.PORT || 4777);
const repo = path.resolve(argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port") || process.env.TOKENWISE_REPO || process.cwd());
const jobs = new Jobs(repo);
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html"), "utf8");

function readLog(id, from = 0) {
  const f = jobs.file(id, "log");
  if (!fs.existsSync(f)) return { lines: [], next: 0 };
  const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const lines = all.slice(from).map((l) => {
    try {
      const e = JSON.parse(l);
      let text = e.line;
      if (e.stream === "out") { try { text = textOf(JSON.parse(e.line)) ?? null; } catch {} }
      return text == null ? null : { t: e.t, stream: e.stream, text: String(text).slice(0, 4000) };
    } catch { return null; }
  }).filter(Boolean);
  return { lines, next: all.length };
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/api\/(\w+)(?:\/([\w-]+))?$/);
  try {
    if (url.pathname === "/") return send(res, 200, html, "text/html; charset=utf-8");
    if (!m) return send(res, 404, { error: "not found" });
    const [, what, id] = m;
    if (req.method === "GET" && what === "jobs") return send(res, 200, { repo, jobs: jobs.list() });
    if (req.method === "GET" && what === "log") return send(res, 200, readLog(id, Number(url.searchParams.get("from") || 0)));
    if (req.method === "GET" && what === "diff") return send(res, 200, { diff: jobs.diff(id) });
    if (req.method === "POST" && what === "merge") return send(res, 200, jobs.merge(id));
    if (req.method === "POST" && what === "discard") return send(res, 200, jobs.discard(id));
    if (req.method === "POST" && what === "delegate") return send(res, 200, jobs.start(await body(req)));
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
}).listen(port, "127.0.0.1", () => console.log(`tokenwise-studio UI: http://127.0.0.1:${port}  (repo: ${repo})`));
