// Chat export (Markdown / JSON) and plain-folder backups. Never includes thinking, base64 data or .env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize } from "./events.js";
import { resolveUpload } from "./uploads.js";

const STATE = { running: "working", done: "ready", failed: "failed", merged: "applied", undone: "undone", discarded: "discarded", moved: "moved on" };
const AGENT = { codex: "Codex", claude: "Claude", gemini: "Gemini", local: "Local", free: "Free API" };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Drop inline image data and long base64 runs from text. */
export function scrub(s) {
  return String(s ?? "")
    .replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=_-]+/g, "[image data omitted]")
    .replace(/[A-Za-z0-9+/]{400,}={0,2}/g, "[binary data omitted]");
}

const slug = (s) => String(s || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";

/** Everything about one chat as plain data: turns with replies, notices and worker jobs. */
export function chatData(jobs, chats, id) {
  const c = chats.get(id);
  const { entries } = chats.log(id);
  const all = jobs.list().filter((j) => j.parent === id);
  const turns = c.turns.map((t, i) => {
    const end = c.turns[i + 1]?.started;
    const mine = all.filter((j) => j.created >= t.started && (!end || j.created < end));
    return {
      user: scrub(t.user), images: t.images || [], agent: t.agent || "claude", model: t.model, effort: t.effort,
      started: t.started, finished: t.finished, cost: t.cost ?? null, tokens: t.tokens ?? null,
      replies: [], notices: [],
      jobs: mine.map((j) => ({
        id: j.id, title: scrub(j.title), agent: j.agent, model: j.model, effort: j.effort, write: !!j.write, status: j.status,
        created: j.created, finished: j.finished, tokens: j.tokens ?? null,
        files: j.files || [], applied: j.status === "merged" ? (j.applied || j.files || []) : [],
        result: j.final ? scrub(String(j.final)).slice(0, 2000) : null,
      })),
    };
  });
  for (const e of entries) {
    const t = turns[e.turn];
    if (!t || e.stream === "user") continue;
    for (const it of normalize(e.agent || "claude", e, jobs.repo)) {
      if (it.kind === "say" && it.text) t.replies.push(scrub(it.text));
      else if ((it.kind === "notice" || it.kind === "compact") && it.text) t.notices.push(scrub(it.text));
    }
  }
  turns.forEach((t, i) => { if (!t.replies.length && c.turns[i].reply) t.replies.push(scrub(c.turns[i].reply)); });
  return {
    app: "tokenwise studio", project: path.basename(jobs.repo), exportedAt: new Date().toISOString(),
    chat: { id: c.id, title: c.title, created: c.created, status: c.status, model: c.model, effort: c.effort, cost: c.cost ?? null },
    turns,
  };
}

export function toMarkdown(d) {
  const L = [];
  const quote = (s) => String(s).split("\n").map((l) => `> ${l}`).join("\n");
  L.push(`# ${d.chat.title}`, "");
  L.push(`- Project: ${d.project}`, `- Chat: ${d.chat.id}, started ${d.chat.created}`);
  if (d.chat.model) L.push(`- Orchestrator: ${cap(d.chat.model)}${d.chat.effort ? `, ${d.chat.effort} effort` : ""}`);
  L.push(`- Exported: ${d.exportedAt}`, "");
  d.turns.forEach((t, i) => {
    L.push(`## Turn ${i + 1} (${t.started})`, "", "**You**", "", quote(t.user || "(no text)"));
    for (const im of t.images) L.push(">", `> Image: ${im}`);
    L.push("", `**Orchestrator** (${AGENT[t.agent] || t.agent} ${cap(t.model || "")}${t.effort ? `, ${t.effort}` : ""})`, "");
    L.push(t.replies.length ? t.replies.join("\n\n") : "(no reply)", "");
    for (const n of t.notices) L.push(`_Notice: ${n}_`, "");
    if (t.jobs.length) {
      L.push("**Worker jobs**", "");
      for (const j of t.jobs) {
        L.push(`- ${AGENT[j.agent] || j.agent} ${cap(j.model || "")} (${j.effort || "default"} effort), ${STATE[j.status] || j.status}${j.write ? ", write" : ", read-only"}: ${j.title}`);
        if (j.applied.length) L.push(`  - Applied files: ${j.applied.map((f) => `\`${f}\``).join(", ")}`);
        else if (j.files.length) L.push(`  - Changed files (not applied): ${j.files.map((f) => `\`${f}\``).join(", ")}`);
      }
      L.push("");
    }
  });
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** { name, md, json } for one chat; name is a file stem. */
export function exportChat(jobs, chats, id) {
  const d = chatData(jobs, chats, id);
  return { name: `${d.chat.created.slice(0, 10)}-${slug(d.chat.title)}-${d.chat.id}`, data: d, md: toMarkdown(d), json: JSON.stringify(d, null, 2) + "\n" };
}

/** Write Markdown and JSON for one chat (or all chats) into `out`. Returns the written paths. */
export function writeExports(jobs, chats, { id, out }) {
  const ids = id ? [chats.get(id).id] : chats.list().map((c) => c.id);
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  for (const cid of ids) {
    const x = exportChat(jobs, chats, cid);
    for (const [ext, body] of [["md", x.md], ["json", x.json]]) { const f = path.join(out, `${x.name}.${ext}`); fs.writeFileSync(f, body); files.push(f); }
  }
  return files;
}

const SECRET = /^\.env|\.pem$|\.key$|^id_(rsa|ed25519)/i;

/** Plain-folder copy of every chat to ~/.tokenwise-studio/backups/<project>/<timestamp>/ (layout mirrors .tokenwise-studio). */
export function backupAll(jobs, chats, { root = path.join(os.homedir(), ".tokenwise-studio", "backups") } = {}) {
  const project = path.basename(jobs.repo).replace(/[^\w.-]+/g, "_") || "project";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let dest = path.join(root, project, stamp);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(root, project, `${stamp}-${n}`);
  const mk = (...p) => fs.mkdirSync(path.join(dest, ...p), { recursive: true });
  mk("chats"); mk("jobs"); mk("exports"); mk("uploads");
  const list = chats.list(), ids = new Set(list.map((c) => c.id));
  let n = { chats: list.length, jobs: 0, uploads: 0, skippedUploads: 0 };
  for (const c of list) {
    for (const ext of ["json", "jsonl"]) { const f = chats.f(c.id, ext); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, "chats", `${c.id}.${ext}`)); }
    writeExports(jobs, chats, { id: c.id, out: path.join(dest, "exports") });
  }
  const refs = new Set(list.flatMap((c) => c.turns.flatMap((t) => t.images || [])));
  for (const j of jobs.list()) {
    if (!ids.has(j.parent)) continue;
    fs.copyFileSync(jobs.file(j.id, "job"), path.join(dest, "jobs", `${j.id}.json`)); n.jobs++;
    for (const im of j.images || []) refs.add(im);
  }
  for (const rel of refs) {
    try {
      const r = resolveUpload(jobs.repo, rel); // refuses symlinks, non-images and files over 10 MB
      if (SECRET.test(path.basename(r.abs))) throw new Error("secret name");
      const sub = path.relative(path.join(jobs.repo, ".tokenwise-studio", "uploads"), r.abs);
      fs.mkdirSync(path.dirname(path.join(dest, "uploads", sub)), { recursive: true });
      fs.copyFileSync(r.abs, path.join(dest, "uploads", sub)); n.uploads++;
    } catch { n.skippedUploads++; }
  }
  return { path: dest, ...n };
}
