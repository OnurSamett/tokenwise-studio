#!/usr/bin/env node
// A small, locked-down tool-using agent loop on top of free OpenAI-compatible chat APIs (NVIDIA,
// OpenRouter, Groq, Mistral, custom). The model is UNTRUSTED: it can read the repo and, in write mode,
// edit files inside the job's own folder (a git worktree in tokenwise studio). It cannot run commands.
//
// Usage: freeagent.js [--write] "<task>"        (cwd = the folder the agent may touch)
// Output: JSON lines (free.init, free.tool, free.skip, free.message, free.usage, free.error).
//
// Safety:
// - One path policy for every tool: inside the working folder, no symlink in any existing path
//   component, no `.git` component, no secret files (.env, keys, tokens, credentials).
// - Writes and reads go through O_NOFOLLOW file descriptors; sizes are capped; only regular files are read.
// - No command execution, no regex from model input (search is a literal substring match).
// - Hard limits: max steps and a wall-clock limit for the whole run.
// Never prints an API key.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chatCompletion, normalizeMessage, forcedModelFor, freeProviders, isDownError, isTimeoutError, pickModels, recordModelHealth, selectReady } from "./freechat.js";
import { createOrchestratorTools, getOrchToolSpecs } from "./mcp.js";
import { loadSettings } from "./settings.js";
import { parseFreeModel } from "./workers.js";

const MAX_STEPS = Number(process.env.TOKENWISE_FREE_MAX_STEPS || 40);
const WORKER_MAX_STEPS = Number(process.env.TOKENWISE_FREE_WORKER_MAX_STEPS || process.env.TOKENWISE_FREE_MAX_STEPS || 25);
const MAX_MINUTES = Number(process.env.TOKENWISE_FREE_MAX_MINUTES) > 0 ? Number(process.env.TOKENWISE_FREE_MAX_MINUTES) : 15;
const MAX_READ = 2 << 20, MAX_WRITE = 1 << 20, MAX_SEARCH_FILE = 1_000_000, MAX_SEARCH_TOTAL = 50 << 20, MAX_HITS = 120;
const SKIP_DIRS = new Set([".git", "node_modules", ".tokenwise-studio", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target"]);
export const SECRET_FILE = [/^\.env(\..*)?$/i, /^\.envrc$/i, /^\.dev\.vars$/i, /\.(pem|key|p12|pfx|keystore|jks|tfvars|tfstate)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials)$/i, /^(credentials|secrets?)(\.\w+)?$/i];
// macOS file names are case-insensitive and Unicode-folding ("ſecrets" opens "secrets"), so compare a
// normalized form; and refuse non-ASCII path parts outright to close lookalike tricks.
export const norm = (name) => String(name).normalize("NFKC").toLowerCase();
export const isSecret = (name) => SECRET_FILE.some((re) => re.test(norm(name)));
export const BLOCKED_DIRS = new Set([".git", ".tokenwise-studio", ".docker", ".ssh", ".aws", ".gnupg"]);
// Never let an API key reach the output, even inside an error message.
const KEYS = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "TOKENWISE_FREE_KEY"].map((k) => process.env[k]).filter(Boolean)
  // raw key, its JSON-escaped form, and every line fragment, so a malformed key can't leak through an error message
  .flatMap((v) => [v, JSON.stringify(v).slice(1, -1), ...v.split(/[\r\n\t]+/)]).filter((v) => v.length > 6);
const redact = (t) => KEYS.reduce((s, k) => s.split(k).join("***"), String(t));
const out = (o) => process.stdout.write(redact(JSON.stringify(o)) + "\n");

// ---------- path policy (used by every tool) ----------
const ROOT = fs.realpathSync(process.cwd());
// Returns the absolute path, or throws. `file: true` additionally blocks secret file names.
function safePath(p, { file = false, root = ROOT } = {}) {
  const abs = path.resolve(root, String(p || "."));
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error(`path outside the working folder: ${p}`);
  const parts = rel ? rel.split(path.sep) : [];
  if (parts.some((x) => /[^\x20-\x7e]/.test(x))) throw new Error(`non-ASCII path names are not allowed: ${p}`);
  if (parts.some((x) => BLOCKED_DIRS.has(norm(x)))) throw new Error(`access to this folder is not allowed: ${p}`);
  if (file && parts.length && isSecret(parts[parts.length - 1])) throw new Error(`secret files are not accessible: ${p}`);
  // Every existing component, including the last, must not be a symbolic link.
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === "ENOENT") break; throw new Error(`cannot access ${p}: ${e.code || e.message}`); }
    if (st.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${p}`);
  }
  return abs;
}
const relp = (abs, root = ROOT) => path.relative(root, abs) || ".";

// Read a regular file (never a FIFO, device, directory or symlink) through an O_NOFOLLOW descriptor.
function readText(abs, max, root = ROOT) {
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error(`not a regular file: ${relp(abs, root)}`);
  if (st.size > max) throw new Error(`file too large (${st.size} bytes, limit ${max}): ${relp(abs, root)}`);
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
}
// Write through an O_NOFOLLOW descriptor after re-checking the (possibly just created) parent folder.
function writeText(abs, content, root = ROOT) {
  if (Buffer.byteLength(content) > MAX_WRITE) throw new Error(`content too large (limit ${MAX_WRITE} bytes)`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  safePath(path.dirname(abs), { root });
  try { if (!fs.lstatSync(abs).isFile()) throw new Error(`not a regular file: ${relp(abs, root)}`); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(abs, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
}

// ---------- tools ----------
function listDir(p = ".", root = ROOT) {
  const abs = safePath(p, { root });
  const items = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !SKIP_DIRS.has(d.name)).slice(0, 300);
  return items.map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n") || "(empty)";
}
function readFile(p, start, end, root = ROOT) {
  const lines = readText(safePath(p, { file: true, root }), MAX_READ, root).split("\n");
  const a = Math.max(1, Number(start) || 1), b = Math.min(lines.length, Number(end) || lines.length);
  const text = lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join("\n");
  return text.length > 60000 ? text.slice(0, 60000) + "\n…(truncated; ask for a line range)" : text;
}
// Literal, case-insensitive substring search (no regex from model input).
function search(pattern, p = ".", root = ROOT) {
  const needle = String(pattern ?? "").toLowerCase();
  if (!needle) throw new Error("empty search pattern");
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= MAX_HITS || scanned >= MAX_SEARCH_TOTAL) return;
      if (SKIP_DIRS.has(d.name) || d.isSymbolicLink()) continue;
      const f = path.join(dir, d.name);
      if (d.isDirectory()) { walk(f); continue; }
      if (!d.isFile() || isSecret(d.name)) continue;
      let text;
      try {
        const size = fs.lstatSync(f).size;
        if (size > MAX_SEARCH_FILE) continue;
        scanned += size;
        text = readText(f, MAX_SEARCH_FILE, root);
      } catch { continue; }
      text.split("\n").forEach((l, i) => { if (hits.length < MAX_HITS && l.toLowerCase().includes(needle)) hits.push(`${relp(f, root)}:${i + 1}: ${l.slice(0, 200)}`); });
    }
  };
  walk(safePath(p, { root }));
  return hits.join("\n") || "(no matches)";
}
function writeFile(p, content, root = ROOT) {
  const abs = safePath(p, { file: true, root });
  writeText(abs, String(content), root);
  return `wrote ${relp(abs, root)} (${String(content).length} chars)`;
}
function replaceInFile(p, oldText, newText, root = ROOT) {
  const abs = safePath(p, { file: true, root });
  const s = readText(abs, MAX_READ, root);
  const n = s.split(String(oldText)).length - 1;
  if (n === 0) throw new Error("old_text not found; read the file again and copy the exact text");
  if (n > 1) throw new Error(`old_text appears ${n} times; include more surrounding lines to make it unique`);
  writeText(abs, s.replace(String(oldText), () => String(newText)), root);
  return `edited ${relp(abs, root)}`;
}

const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const READ_TOOLS = [
  fn("list_dir", "List files and folders (relative path, default '.').", { path: { type: "string" } }, []),
  fn("read_file", "Read a text file with line numbers; optionally a line range.", { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
  fn("search", "Search file contents for a literal text (case-insensitive substring, not a regex) under a folder.", { pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
];
export const WRITE_TOOLS = [
  fn("replace_in_file", "Replace one exact, unique snippet in a file. Prefer this for edits.", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["path", "old_text", "new_text"]),
  fn("write_file", "Create or overwrite a whole file.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
];
export function getFreeOrchestratorTools(permissionMode = "ask") {
  return [...READ_TOOLS, ...getOrchToolSpecs(permissionMode)];
}
function callTool(name, a, root = ROOT) {
  switch (name) {
    case "list_dir": return listDir(a.path, root);
    case "read_file": return readFile(a.path, a.start_line, a.end_line, root);
    case "search": return search(a.pattern, a.path, root);
    case "replace_in_file": return replaceInFile(a.path, a.old_text, a.new_text, root);
    case "write_file": return writeFile(a.path, a.content, root);
    default: throw new Error(`unknown tool ${name}`);
  }
}

function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
}
const toolEvent = (name, a) => {
  if (name === "delegate") {
    const label = String(a.title || a.task || "").split("\n")[0].slice(0, 140);
    return {
      name,
      kind: "delegate",
      text: `${a.agent} ${a.model || ""} · ${a.effort || "default"}${a.write ? " · writes" : ""}: ${label}`,
    };
  }
  if (name === "project_map") {
    return { name, kind: "tool", text: "project map" + (a.prefix ? ` ${a.prefix}` : a.name ? ` ${a.name}` : "") };
  }
  if (typeof name === "string" && name.startsWith("job_")) {
    const idPart = a.id || (Array.isArray(a.ids) ? a.ids.join(",") : "");
    return { name, kind: "tool", text: `${name.replace("_", " ")}${idPart ? ` ${idPart}` : ""}` };
  }
  const mapped = {
    list_dir: { kind: "search", text: `list ${a.path || "."}` },
    read_file: { kind: "read", text: a.path },
    search: { kind: "search", text: `search ${a.pattern}` },
    replace_in_file: { kind: "edit", text: `edit ${a.path}` },
    write_file: { kind: "edit", text: `write ${a.path}` },
  }[name] || { kind: "tool", text: name };
  return { name, ...mapped };
};

// ---------- the loop ----------
// Streamed (see chatCompletion): a stalled model is dropped after firstTokenMs without a token, a long answer is never cut by the total cap.
async function chat(p, model, messages, tools, timeoutMs = 180_000, firstTokenMs = 30_000) {
  return chatCompletion(p, { model, messages, tools }, { totalMs: timeoutMs, firstTokenMs });
}

const skipMsg = (p, e, what = "request") => {
  if (!isTimeoutError(e)) return String(e?.message || e).slice(0, 200);
  const why = String(e?.message || "").match(/\(([^)]*)\)/)?.[1];
  return `${what} to ${p.name} timed out${why ? ` (${why})` : ""}`;
};

/** Candidate [provider, model, isForced] list; each provider's top models are probed in parallel (max 3) and ordered by measured latency. */
async function buildFreePairs({ providers, emit, probeTimeout, pick }) {
  const pairs = [], latency = new Map();
  let fellFrom = null;
  for (const [i, p] of providers.entries()) {
    try {
      const { list, forced } = await pick(p, i);
      const sel = await selectReady(p, list, { forced: forced && list.includes(forced) ? forced : null, timeoutMs: probeTimeout });
      for (const sk of sel.skipped) {
        fellFrom ||= { from: `${p.name}:${sk.model}`, reason: sk.message };
        emit({ type: "free.skip", provider: p.name, model: sk.model, status: sk.status, message: sk.message });
      }
      for (const m of sel.models) { pairs.push([p, m, forced === m]); if (sel.latency[m] != null) latency.set(`${p.name}:${m}`, sel.latency[m]); }
    } catch (e) {
      emit({ type: "free.skip", provider: p.name, status: Number(e?.status) || 0, message: String(e?.message || e).slice(0, 200) });
    }
  }
  return { pairs, latency, fellFrom };
}

export async function runFreeAgent({ task, write = false, emit = out, probeTimeout, maxSteps, chatFn = null, root = ROOT } = {}) {
  const workRoot = fs.realpathSync(root);
  const workerMaxSteps = Number(maxSteps) > 0 ? Number(maxSteps) : WORKER_MAX_STEPS;
  const providers = freeProviders();
  if (!providers.length && !chatFn) {
    const message = "no free provider: set NVIDIA_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY or MISTRAL_API_KEY";
    emit({ type: "free.error", status: 0, message });
    return { ok: false, exitCode: 2, status: 0, message };
  }
  if (!task) {
    emit({ type: "free.error", status: 0, message: "empty task" });
    return { ok: false, exitCode: 1, status: 0, message: "empty task" };
  }

  const tools = write ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  const messages = [
    { role: "system", content: `You are a careful coding worker. Your working folder is the project root; use relative paths. Use the tools to look at the code before answering${write ? ", then make the smallest correct change. You cannot run commands or tests" : ". You cannot change files or run commands"}. Do exactly the task, nothing more. When done, reply with a short summary (what you found or changed${write ? ", and which test command the user should run to verify it" : ""}).` },
    { role: "user", content: task },
  ];
  // Candidate (provider, model, isForced) tuples in order; the conversation is portable, so a rate limit
  // or unavailable model mid-task just continues on the next candidate.
  const pairs = [];
  const latency = new Map();
  let fellFrom = null;
  if (chatFn) {
    pairs.push([{ name: "stub", base: "http://stub.local/v1", key: "stub" }, "stub-free-model", true]);
  } else {
    const built = await buildFreePairs({
      providers, emit, probeTimeout,
      pick: async (p, i) => {
        const forced = forcedModelFor(p, i === 0);
        return { list: process.env.TOKENWISE_FREE_STRICT_MODEL === "1" && forced ? [forced] : await pickModels(p, i === 0), forced };
      },
    });
    pairs.push(...built.pairs);
    for (const [key, v] of built.latency) latency.set(key, v);
    fellFrom = built.fellFrom;
  }
  const firstOk = new Set();
  if (!pairs.length) {
    emit({ type: "free.error", status: 0, message: "no usable free model" });
    return { ok: false, exitCode: 1, status: 0, message: "no usable free model" };
  }

  let k = 0, usage = { prompt_tokens: 0, completion_tokens: 0 }, announced = -1, last = null;
  let toolSteps = 0;
  const failCounts = new Map();
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  const checkTimeUp = () => {
    if (Date.now() < deadline) return null;
    const message = `stopped after the ${MAX_MINUTES} minute time limit`;
    emit({ type: "free.usage", usage });
    emit({ type: "free.error", status: 0, message });
    return { ok: false, exitCode: 1, status: 0, message, usage };
  };
  for (let step = 0; step < workerMaxSteps; step++) {
    const expired = checkTimeUp();
    if (expired) return expired;
    if (k >= pairs.length) break;
    const [p, model, isForced] = pairs[k];
    if (announced !== k) {
      emit({ type: "free.init", provider: p.name, model, agent: true, write, ...(latency.has(`${p.name}:${model}`) ? { latencyMs: latency.get(`${p.name}:${model}`) } : {}), ...(fellFrom ? { fellBackFrom: fellFrom.from, fellBackReason: fellFrom.reason } : {}) });
      announced = k;
    }
    const hasNext = k + 1 < pairs.length;
    let data;
    try {
      const timeoutMs = Math.max(1000, Math.min(hasNext ? 90_000 : 180_000, deadline - Date.now()));
      data = chatFn
        ? (chatFn.length >= 3 ? await chatFn(p, model, messages, tools, timeoutMs, step) : await chatFn({ provider: p, model, messages, tools, timeoutMs, step }))
        : await chat(p, model, messages, tools, timeoutMs, hasNext ? 20_000 : 60_000);
      if (!chatFn) recordModelHealth(p.name, model, true, "ok");
      if (!firstOk.has(k)) { firstOk.add(k); if (data?._latency) emit({ type: "free.latency", provider: p.name, model, ms: data._latency.firstMs }); }
    } catch (e) {
      const status = Number(e?.status) || 0;
      const message = skipMsg(p, e);
      if (!chatFn && isDownError(e)) recordModelHealth(p.name, model, false, message);
      last = { status, message };
      fellFrom ||= { from: `${p.name}:${model}`, reason: message };
      emit({ type: "free.skip", provider: p.name, model, status, message });
      // Bad key or rate limit: skip this provider's other models too.
      if (status === 401 || status === 403 || status === 429) { const name = p.name; while (k < pairs.length && pairs[k][0].name === name) k++; } else k++;
      step--; continue;
    }
    usage.prompt_tokens += data?.usage?.prompt_tokens || 0;
    usage.completion_tokens += data?.usage?.completion_tokens || 0;
    const msg = normalizeMessage(data?.choices?.[0]?.message || data?.message || data?.msg || data || {});
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) emit({ type: "free.think", text: msg.reasoning_content.trim().slice(0, 64 * 1024) });
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const text = msg.content || "";
      emit({ type: "free.message", text });
      emit({ type: "free.usage", usage });
      return { ok: true, exitCode: 0, provider: p.name, model, text, usage };
    }
    messages.push({ role: "assistant", content: msg.content || null, tool_calls: calls });
    for (const c of calls) {
      const expired2 = checkTimeUp();
      if (expired2) return expired2;
      if (!c || typeof c !== "object") continue;
      if (toolSteps >= workerMaxSteps) {
        const message = `stopped after ${workerMaxSteps} tool steps without finishing`;
        emit({ type: "free.usage", usage });
        emit({ type: "free.error", status: 0, message });
        return { ok: false, exitCode: 1, status: 0, message, usage };
      }
      toolSteps++;
      let a = {};
      if (typeof c.function?.arguments === "string") {
        try { a = JSON.parse(c.function.arguments || "{}"); } catch {}
      } else if (c.function?.arguments && typeof c.function.arguments === "object") {
        a = c.function.arguments;
      }
      if (!a || typeof a !== "object" || Array.isArray(a)) a = {};
      const name = c.function?.name;
      const failKey = `${name || ""}:${stableJson(a)}`;
      let result;
      try {
        if (!tools.some((t) => t.function.name === name)) throw new Error(`tool ${name} is not available in this mode`);
        result = callTool(name, a, workRoot);
        failCounts.delete(failKey);
        emit({ type: "free.tool", ...toolEvent(name, a) });
      } catch (e) {
        const repeats = (failCounts.get(failKey) || 0) + 1;
        failCounts.set(failKey, repeats);
        result = `ERROR: ${e.message}`;
        emit({ type: "free.tool", ...toolEvent(name, a), error: e.message });
        if (repeats >= 3) {
          const message = `stopped early: failing tool call ${name} repeated 3 times (${e.message})`;
          emit({ type: "free.usage", usage });
          emit({ type: "free.error", status: 0, message });
          return { ok: false, exitCode: 1, status: 0, message, usage };
        }
      }
      messages.push({ role: "tool", tool_call_id: c.id || name, content: String(result) });
    }
  }
  emit({ type: "free.usage", usage });
  const message = last ? (last.status === 429 || /rate limit/i.test(last.message) ? `rate limit reached on every free provider (${last.message})` : last.message) : `stopped after ${workerMaxSteps} tool steps without finishing`;
  emit({ type: "free.error", status: last?.status || 0, message });
  return { ok: false, exitCode: 1, status: last?.status || 0, message, usage };
}

/**
 * In-process orchestrator loop for "free" and "local" orchestrators.
 * Exposes read-only repo tools (list_dir, read_file, search) + in-process MCP orchestrator tools
 * (delegate, job_wait, job_status, job_diff, job_merge [respecting permissionMode], job_discard, job_test, project_map).
 * Never exposes write/edit tools.
 */
export async function runFreeOrchestrator({
  repo,
  jobs,
  chatId = null,
  agent = "free",
  model = "auto",
  guide = "",
  prompt = "",
  permissionMode = null,
  emit = out,
  onUsage = null,
  chatFn = null,
  signal = null,
  probeTimeout,
} = {}) {
  const root = fs.realpathSync(repo || jobs?.repo || process.cwd());
  const effPerm = permissionMode || loadSettings().permissionMode;
  const tools = getFreeOrchestratorTools(effPerm);
  const mcp = createOrchestratorTools({ jobs, parent: chatId, permissionMode: effPerm });

  const sysContent = guide || "You are the orchestrating agent in tokenwise studio.";
  const messages = [
    { role: "system", content: sysContent },
    { role: "user", content: String(prompt || "") },
  ];

  const isLocal = agent === "local";
  const pairs = [], latency = new Map();
  let fellFrom = null;
  const firstOk = new Set();
  if (isLocal) {
    const baseRaw = (process.env.TOKENWISE_OLLAMA_BASE || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
    const base = baseRaw.endsWith("/v1") ? baseRaw : `${baseRaw}/v1`;
    const localModel = model && model !== "local" && model !== "auto" && model !== "free"
      ? model
      : (process.env.TOKENWISE_LOCAL_MODEL || "gpt-oss:20b");
    pairs.push([{ name: "ollama", base, key: process.env.OLLAMA_API_KEY || "ollama" }, localModel, true]);
  } else {
    const parsed = parseFreeModel(model === "free" ? "auto" : model);
    const providerFilter = parsed.provider || undefined;
    const forcedModel = (parsed.kind === "provider_model" || parsed.kind === "id") ? parsed.id : null;
    const hint = parsed.kind === "hint" ? parsed.hint : undefined;
    const providers = freeProviders({ providers: providerFilter });
    if (chatFn) {
      const p0 = providers[0] || { name: parsed.provider || "nvidia", base: "http://stub.local/v1", key: "stub" };
      pairs.push([p0, forcedModel || "stub-free-model", true]);
    } else if (!providers.length) {
      const message = "no free provider: set NVIDIA_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY or MISTRAL_API_KEY";
      emit({ type: "free.error", status: 0, message });
      return { ok: false, exitCode: 2, status: 0, message };
    } else {
      const built = await buildFreePairs({
        providers, emit, probeTimeout,
        pick: async (p, i) => {
          const explicitForced = i === 0 ? forcedModel : null;
          return { list: await pickModels(p, i === 0, { hint, forcedModel: explicitForced }), forced: forcedModelFor(p, i === 0, explicitForced) };
        },
      });
      pairs.push(...built.pairs);
      for (const [key, v] of built.latency) latency.set(key, v);
      fellFrom = built.fellFrom;
    }
  }

  if (!pairs.length) {
    const message = isLocal ? "no usable local model" : "no usable free model";
    emit({ type: "free.error", status: 0, message });
    return { ok: false, exitCode: 1, status: 0, message };
  }

  const callChat = async (p, m, msgs, tls, timeoutMs, step, firstTokenMs) => {
    if (chatFn) {
      if (chatFn.length >= 3) return await chatFn(p, m, msgs, tls, timeoutMs, step);
      return await chatFn({ provider: p, model: m, messages: msgs, tools: tls, timeoutMs, step, signal });
    }
    return await chat(p, m, msgs, tls, timeoutMs, firstTokenMs);
  };

  let k = 0, usage = { prompt_tokens: 0, completion_tokens: 0 }, announced = -1, last = null;
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  const checkStoppedOrExpired = () => {
    if (signal?.aborted) {
      return { ok: false, stopped: true, exitCode: 130, status: 0, message: "stopped by user", usage };
    }
    if (Date.now() < deadline) return null;
    const message = `stopped after the ${MAX_MINUTES} minute time limit`;
    emit({ type: "free.usage", usage });
    emit({ type: "free.error", status: 0, message });
    return { ok: false, exitCode: 1, status: 0, message, usage };
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const stopRes = checkStoppedOrExpired();
    if (stopRes) return stopRes;
    if (k >= pairs.length) break;
    const [p, curModel, isForced] = pairs[k];
    if (announced !== k) {
      emit({ type: "free.init", provider: p.name, model: curModel, agent: true, orchestrator: true, write: false, ...(latency.has(`${p.name}:${curModel}`) ? { latencyMs: latency.get(`${p.name}:${curModel}`) } : {}), ...(fellFrom ? { fellBackFrom: fellFrom.from, fellBackReason: fellFrom.reason } : {}) });
      announced = k;
    }

    const hasNext = k + 1 < pairs.length;
    let data;
    try {
      data = await callChat(p, curModel, messages, tools, Math.max(1000, Math.min(hasNext ? 90_000 : 180_000, deadline - Date.now())), step, hasNext ? 20_000 : 60_000);
      if (!isLocal && !chatFn) recordModelHealth(p.name, curModel, true, "ok");
      if (!firstOk.has(k)) { firstOk.add(k); if (data?._latency) emit({ type: "free.latency", provider: p.name, model: curModel, ms: data._latency.firstMs }); }
    } catch (e) {
      const status = Number(e?.status) || 0;
      const message = skipMsg(p, e);
      if (!isLocal && !chatFn && isDownError(e)) recordModelHealth(p.name, curModel, false, message);
      last = { status, message };
      fellFrom ||= { from: `${p.name}:${curModel}`, reason: message };
      emit({ type: "free.skip", provider: p.name, model: curModel, status, message });
      if (status === 401 || status === 403 || status === 429) { const name = p.name; while (k < pairs.length && pairs[k][0].name === name) k++; } else k++;
      step--; continue;
    }

    const stepIn = data?.usage?.prompt_tokens || 0;
    const stepOut = data?.usage?.completion_tokens || 0;
    if (stepIn || stepOut) {
      usage.prompt_tokens += stepIn;
      usage.completion_tokens += stepOut;
      if (onUsage) { try { onUsage({ ...usage }); } catch {} }
    }

    const msg = normalizeMessage(data?.choices?.[0]?.message || data?.message || data?.msg || data || {});
    const thinkText = msg.reasoning_content;
    if (typeof thinkText === "string" && thinkText.trim()) {
      emit({ type: "free.think", text: thinkText.trim().slice(0, 64 * 1024) });
    }
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const text = String(msg.content || "");
      emit({ type: "free.usage", provider: p.name, model: curModel, usage: { ...usage } });
      emit({ type: "free.message", text });
      return { ok: true, exitCode: 0, provider: p.name, model: curModel, text, usage };
    }

    if (typeof msg.content === "string" && msg.content.trim()) {
      emit({ type: "free.message", text: msg.content.trim() });
    }
    messages.push({ role: "assistant", content: msg.content || null, tool_calls: calls });

    for (const c of calls) {
      const stopRes2 = checkStoppedOrExpired();
      if (stopRes2) return stopRes2;
      if (!c || typeof c !== "object") continue;
      let a = {};
      if (typeof c.function?.arguments === "string") {
        try { a = JSON.parse(c.function.arguments || "{}"); } catch {}
      } else if (c.function?.arguments && typeof c.function.arguments === "object") {
        a = c.function.arguments;
      }
      if (!a || typeof a !== "object" || Array.isArray(a)) a = {};
      const name = c.function?.name;
      let result;
      try {
        if (!tools.some((t) => t.function.name === name)) {
          throw new Error(`tool ${name} is not available in this mode`);
        }
        if (name === "list_dir" || name === "read_file" || name === "search") {
          result = callTool(name, a, root);
          emit({ type: "free.tool", ...toolEvent(name, a) });
        } else {
          const r = await mcp.callTool(name, a);
          result = r.text;
          if (r.isError) {
            emit({ type: "free.tool", ...toolEvent(name, a), error: r.text });
          } else {
            emit({ type: "free.tool", ...toolEvent(name, a) });
          }
        }
      } catch (e) {
        result = `ERROR: ${e.message}`;
        emit({ type: "free.tool", ...toolEvent(name, a), error: e.message });
      }
      messages.push({ role: "tool", tool_call_id: c.id || name, content: String(result) });
    }
  }

  const message = last
    ? (last.status === 429 || /rate limit/i.test(last.message)
      ? `rate limit reached on every ${isLocal ? "local" : "free"} provider (${last.message})`
      : last.message)
    : `stopped after ${MAX_STEPS} steps without finishing`;
  if (usage.prompt_tokens || usage.completion_tokens) emit({ type: "free.usage", usage: { ...usage } });
  emit({ type: "free.error", status: last?.status || 0, message });
  return { ok: false, exitCode: 1, status: last?.status || 0, message, usage };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const task = argv.filter((x) => x !== "--write").join(" ").trim();
  const res = await runFreeAgent({ task, write });
  if (!res.ok) process.exit(res.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { out({ type: "free.error", status: 0, message: redact(String(e?.message || e)).slice(0, 200) }); process.exit(1); });
}
