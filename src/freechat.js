#!/usr/bin/env node
// Free-tier OpenAI-compatible chat APIs as a read-only fallback worker (plain chat, no tools).
// Providers are tried in order; a rate limit or server error on one moves on to the next.
//   NVIDIA (build.nvidia.com)  NVIDIA_API_KEY
//   OpenRouter ":free" models  OPENROUTER_API_KEY
//   Groq                       GROQ_API_KEY
//   Mistral (free tier)        MISTRAL_API_KEY
//   any OpenAI-compatible API  TOKENWISE_FREE_BASE + TOKENWISE_FREE_KEY (+ TOKENWISE_FREE_MODEL)
// Order: TOKENWISE_FREE_PROVIDERS (default "nvidia,openrouter,groq,mistral,custom").
// Per-provider model override: TOKENWISE_<NAME>_MODEL (e.g. TOKENWISE_NVIDIA_MODEL); TOKENWISE_FREE_MODEL for the first one.
// Ranking hint: TOKENWISE_FREE_HINT reorders ranked candidates without dropping fallbacks.
// Never prints or logs an API key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `rank`: preferred model patterns, best first. Models not matching any pattern are kept as a last resort.
const KNOWN = {
  nvidia: { env: "NVIDIA_API_KEY", base: "https://integrate.api.nvidia.com/v1",
    rank: [/kimi-k3/i, /mistral-large-4/i, /deepseek-v4/i, /glm-5/i, /nemotron-3-ultra/i, /step-?5/i, /minimax-m3/i, /kimi-k2/i, /laguna/i, /gpt-oss-120b/i, /nemotron-3-super/i, /qwen3/i, /gpt-oss-20b/i] },
  openrouter: { env: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1", onlyFree: true,
    rank: [/kimi-k2/i, /deepseek/i, /glm/i, /qwen3.*coder/i, /gpt-oss-120b/i, /qwen/i, /llama/i] },
  groq: { env: "GROQ_API_KEY", base: "https://api.groq.com/openai/v1", rank: [/gpt-oss-120b/i, /kimi/i, /qwen/i, /llama-3\.3-70b|llama-4/i, /gpt-oss/i] },
  mistral: { env: "MISTRAL_API_KEY", base: "https://api.mistral.ai/v1", rank: [/mistral-large/i, /mistral-medium/i, /devstral|codestral/i] },
};

/** Configured providers in priority order: [{ name, base, key, prefer, onlyFree }]. */
export function freeProviders() {
  const order = (process.env.TOKENWISE_FREE_PROVIDERS || "nvidia,openrouter,groq,mistral,custom").split(",").map((s) => s.trim());
  const out = [];
  for (const name of order) {
    if (name === "custom") {
      if (process.env.TOKENWISE_FREE_BASE && process.env.TOKENWISE_FREE_KEY && /^[\x21-\x7e]+$/.test(process.env.TOKENWISE_FREE_KEY)) out.push({ name: "custom", base: process.env.TOKENWISE_FREE_BASE.replace(/\/$/, ""), key: process.env.TOKENWISE_FREE_KEY, rank: [] });
      continue;
    }
    const k = KNOWN[name];
    if (k && process.env[k.env]) {
      // A key with spaces/newlines/control characters would end up inside an error message: refuse it instead.
      if (!/^[\x21-\x7e]+$/.test(process.env[k.env])) { process.stderr.write(`${k.env} contains invalid characters; skipping ${name}\n`); continue; }
      out.push({ name, ...k, key: process.env[k.env] });
    }
  }
  return out;
}
export const freeProvider = () => freeProviders()[0] || null;

const picked = new Map();
const DOWN_TTL_MS = 4 * 60 * 60 * 1000;
const PROBE_TTL_MS = 60 * 60 * 1000;
const probeTimeoutMs = () => {
  const n = Number(process.env.TOKENWISE_FREE_PROBE_TIMEOUT_MS);
  return n > 0 ? n : 8_000;
};
const healthFile = () => path.join(os.homedir(), ".tokenwise-studio", "free-health.json");
const healthKey = (provider, model) => `${provider}:${model}`;

function loadHealth() {
  try {
    const raw = JSON.parse(fs.readFileSync(healthFile(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function saveHealth(map) {
  try {
    const file = healthFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
  } catch {}
}

/** True when a model was marked down (404 / not found / timeout) within the last 4h. */
export function isModelDown(provider, model, now = Date.now()) {
  const entry = loadHealth()[healthKey(provider, model)];
  return !!(entry && entry.status === "down" && Number(entry.downUntil) > now);
}

/** True when a model has not passed a probe/call within the last hour. */
export function needsProbe(provider, model, now = Date.now()) {
  const entry = loadHealth()[healthKey(provider, model)];
  return !(entry && entry.status === "ok" && Number(entry.checkedAt) > now - PROBE_TTL_MS);
}

/** Persist model health ("ok" or 4h "down") in ~/.tokenwise-studio/free-health.json. */
export function recordModelHealth(provider, model, ok, reason = "", now = Date.now()) {
  const map = loadHealth();
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(map)) {
    if (!v || (Number(v.checkedAt) || 0) < cutoff && (Number(v.downUntil) || 0) <= now) delete map[k];
  }
  map[healthKey(provider, model)] = ok
    ? { status: "ok", checkedAt: now }
    : { status: "down", checkedAt: now, downUntil: now + DOWN_TTL_MS, reason: String(reason || "").slice(0, 120) };
  saveHealth(map);
}

export const isTimeoutError = (err) =>
  err?.name === "TimeoutError" || err?.name === "AbortError" || /\btimed?\s*out\b/i.test(String(err?.message || ""));

/** True for model-level unavailability (404, "not found", or timeout), never auth/rate-limit errors. */
export function isDownError(err) {
  const status = Number(err?.status) || 0;
  if (status === 401 || status === 403 || status === 429) return false;
  if (status === 404) return true;
  if (isTimeoutError(err)) return true;
  return /not found/i.test(String(err?.message || ""));
}

/** Clear in-memory /models and listFreeModels caches (useful in tests). */
export function clearFreeCache() {
  picked.clear();
  freeList = null;
  freeListAt = 0;
}

/** All usable chat models for this provider, best first (cached per provider, skipping down-cached models). */
// Benchmarks (benchmarks.json next to this file): models with a Terminal-Bench score go first, best first.
let BENCH = null;
function terminalScore(id) {
  if (BENCH === null) {
    try { BENCH = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "benchmarks.json"), "utf8")).models || []; }
    catch { BENCH = []; }
  }
  const m = BENCH.find((b) => b.agent === "free" && b.match && new RegExp(b.match, "i").test(id));
  if (!m) return null;
  // Terminal-Bench 4.0 (official, independently run) comes first, using the score of the variant actually served
  // (servedTerminalBench40) when it differs. Models without a TB 4.0 result follow, ordered by the older,
  // mostly vendor-reported TB 2.1, then TB 3.0 (scaled, it's much harder).
  const tb4 = typeof m.servedTerminalBench40 === "number" ? m.servedTerminalBench40 : m.terminalBench40;
  if (typeof tb4 === "number") return 1000 + tb4;
  return typeof m.terminalBench21 === "number" ? m.terminalBench21 : typeof m.terminalBench30 === "number" ? 50 + m.terminalBench30 : null;
}

async function rankedModels(p) {
  const cacheKey = `${p.name}|${p.base}`;
  let all = picked.get(cacheKey);
  if (!all) {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw Object.assign(new Error(`models list failed (HTTP ${res.status})`), { status: res.status });
    const body = await res.json();
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .filter((m) => !p.onlyFree || (m?.pricing?.prompt === "0" && m?.pricing?.completion === "0") || String(m?.id).endsWith(":free"))
      .map((m) => String(m.id))
      // Skip embedding / vision / speech / safety models.
      .filter((id) => !/embed|rerank|guard|safety|vision|-vl\b|-vl-|vlm|tts|whisper|asr|ocr|parse|reward/i.test(id));
    const score = (id) => { const i = p.rank.findIndex((re) => re.test(id)); return i < 0 ? p.rank.length : i; };
    const size = (id) => Number((id.match(/(\d+(?:\.\d+)?)b\b/i) || [])[1] || 0);
    const tb = (id) => terminalScore(id);
    ids.sort((a, b) => {
      // Coding-oriented candidates first. Only models present in the live API catalog can be chosen.
      const checked = (id) => p.name !== "nvidia" ? 4 : /^moonshotai\/kimi-k3\.1-pro$/i.test(id) ? 0 : /^nvidia\/nemotron-3-ultra-550b-a55b$/i.test(id) ? 1 : /^mistralai\/mistral-large-4-1t-a52b$/i.test(id) ? 2 : /^nvidia\/nemotron-3\.5-bolt-e4b$/i.test(id) ? 3 : 4;
      if (checked(a) !== checked(b)) return checked(a) - checked(b);
      const ta = tb(a), tbb = tb(b);
      if (ta !== null || tbb !== null) { if (ta === null) return 1; if (tbb === null) return -1; if (tbb !== ta) return tbb - ta; }
      return score(a) - score(b) || size(b) - size(a);
    });
    if (!ids.length) throw new Error(`no usable model found on ${p.name}`);
    picked.set(cacheKey, ids);
    all = ids;
  }
  const now = Date.now();
  const alive = all.filter((id) => !isModelDown(p.name, id, now));
  if (!alive.length) throw new Error(`no usable model found on ${p.name}`);
  return alive;
}

function applyHint(ids, hint) {
  const raw = String(hint || "").trim().toLowerCase();
  if (!raw || raw === "auto") return ids;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nh = norm(raw);
  const matches = (id) => {
    const low = id.toLowerCase();
    return low.includes(raw) || (nh.length > 0 && norm(low).includes(nh));
  };
  const head = [], tail = [];
  for (const id of ids) (matches(id) ? head : tail).push(id);
  return [...head, ...tail];
}

export function forcedModelFor(p, first = false) {
  return (process.env[`TOKENWISE_${p.name.toUpperCase()}_MODEL`] || (first ? process.env.TOKENWISE_FREE_MODEL : "") || "").trim() || null;
}

/** Up to 3 candidate models for this provider, best first (forced goes first with ranked fallbacks; hint reorders ranked ids). */
export async function pickModels(p, first = false, { hint = process.env.TOKENWISE_FREE_HINT } = {}) {
  const forced = forcedModelFor(p, first);
  let ranked = [];
  if (forced) {
    try { ranked = await rankedModels(p); } catch {}
  } else {
    ranked = await rankedModels(p);
  }
  ranked = applyHint(ranked, hint);
  if (forced) return [forced, ...ranked.filter((id) => id !== forced)].slice(0, 3);
  return ranked.slice(0, 3);
}
export const pickModel = async (p, first) => (await pickModels(p, first))[0];

/** Probe a model with max_tokens=1 and an 8s timeout; records ok or 4h down in free-health.json. */
export async function probeModel(p, model, { timeoutMs = probeTimeoutMs() } = {}) {
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const t = (await res.text?.().catch(() => "")) || "";
      const clean = String(t).replace(/\s+/g, " ").slice(0, 200);
      throw Object.assign(
        new Error(res.status === 429 ? `rate limit reached on ${p.name}` : `HTTP ${res.status} from ${p.name}: ${clean}`),
        { status: res.status },
      );
    }
    await res.text?.().catch(() => "");
    recordModelHealth(p.name, model, true, "ok");
    return true;
  } catch (err) {
    if (isDownError(err)) {
      const reason = isTimeoutError(err) ? `probe timed out after ${Math.round(timeoutMs / 1000)}s` : (err?.message || `HTTP ${err?.status || 0}`);
      recordModelHealth(p.name, model, false, reason);
    }
    throw err;
  }
}

/** Probe a ranked model if it has not been probed ok within the last hour. */
export async function ensureModelReady(p, model, { forced = false, timeoutMs = probeTimeoutMs() } = {}) {
  if (forced || !needsProbe(p.name, model)) return true;
  try {
    return await probeModel(p, model, { timeoutMs });
  } catch (err) {
    // Some models reject max_tokens=1 with HTTP 400 without being unavailable; let the real call decide.
    if (Number(err?.status) === 400 && !isDownError(err)) return true;
    throw err;
  }
}

let freeList = null, freeListAt = 0;
/** Selectable free models: up to 8 ranked per configured provider, as [{ id: "provider:model", provider, model }]. Cached 10 min, never throws. */
export async function listFreeModels() {
  try {
    const now = Date.now();
    if (freeList && now - freeListAt < 10 * 60_000) {
      return freeList.filter((m) => !isModelDown(m.provider, m.model, now));
    }
    const out = [];
    for (const p of freeProviders()) {
      try { for (const model of (await rankedModels(p)).slice(0, 8)) out.push({ id: `${p.name}:${model}`, provider: p.name, model }); } catch {}
    }
    if (out.length) { freeList = out; freeListAt = now; }
    return out;
  } catch { return []; }
}

const KEYS = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "TOKENWISE_FREE_KEY"].map((k) => process.env[k]).filter(Boolean)
  // raw key, its JSON-escaped form, and every line fragment, so a malformed key can't leak through an error message
  .flatMap((v) => [v, JSON.stringify(v).slice(1, -1), ...v.split(/[\r\n\t]+/)]).filter((v) => v.length > 6);
const out = (o) => process.stdout.write(KEYS.reduce((s, k) => s.split(k).join("***"), JSON.stringify(o)) + "\n");
async function readStdin() { let s = ""; for await (const c of process.stdin) s += c; return s.trim(); }

async function ask(p, model, task, timeoutMs = 120_000) {
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: false,
      messages: [
        { role: "system", content: "You are a careful read-only assistant. Answer the task concisely. You cannot see any files except what is in the task." },
        { role: "user", content: task },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw Object.assign(new Error(res.status === 429 ? `rate limit reached on ${p.name}` : `HTTP ${res.status} from ${p.name}: ${t}`), { status: res.status });
  }
  return res.json();
}

export async function runFreeChat(task, { emit = out, probeTimeout } = {}) {
  const providers = freeProviders();
  if (!providers.length) {
    const message = "no free provider: set NVIDIA_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY or MISTRAL_API_KEY";
    emit({ type: "free.error", status: 0, message });
    return { ok: false, exitCode: 2, status: 0, message };
  }
  if (!task) {
    emit({ type: "free.error", status: 0, message: "empty task" });
    return { ok: false, exitCode: 1, status: 0, message: "empty task" };
  }

  let last = null;
  for (const [i, p] of providers.entries()) {
    let models;
    try { models = await pickModels(p, i === 0); }
    catch (e) { last = { status: Number(e?.status) || 0, message: String(e?.message || e).slice(0, 200) }; emit({ type: "free.skip", provider: p.name, status: last.status, message: last.message }); continue; }
    const forced = forcedModelFor(p, i === 0);
    for (const [j, model] of models.entries()) {
      const hasNext = j < models.length - 1 || i < providers.length - 1;
      const callTimeoutMs = hasNext ? 60_000 : 120_000;
      try {
        await ensureModelReady(p, model, { forced: forced === model, timeoutMs: probeTimeout });
        emit({ type: "free.init", provider: p.name, model });
        const data = await ask(p, model, task, callTimeoutMs);
        recordModelHealth(p.name, model, true, "ok");
        const text = data?.choices?.[0]?.message?.content ?? "";
        const usage = { prompt_tokens: data?.usage?.prompt_tokens ?? 0, completion_tokens: data?.usage?.completion_tokens ?? 0 };
        emit({ type: "free.message", text });
        emit({ type: "free.usage", usage });
        return { ok: true, exitCode: 0, provider: p.name, model, text, usage };
      } catch (e) {
        const status = Number(e?.status) || 0;
        const timedOut = isTimeoutError(e);
        const message = timedOut ? `request to ${p.name} timed out after ${Math.round(callTimeoutMs / 1000)}s` : String(e?.message || e).slice(0, 200);
        if (isDownError(e)) recordModelHealth(p.name, model, false, message);
        last = { status, message };
        emit({ type: "free.skip", provider: p.name, model, status, message });
        // Bad key or rate limit: the whole provider is out, move on. Missing/unavailable model: try its next model.
        if (status === 401 || status === 403 || status === 429) break;
      }
    }
  }
  const message = last?.status === 429 || /rate limit/i.test(last?.message || "") ? `rate limit reached on every free provider (${last.message})` : last?.message;
  emit({ type: "free.error", status: last?.status || 0, message });
  return { ok: false, exitCode: 1, status: last?.status || 0, message };
}

async function main() {
  const task = process.argv[2] ?? (await readStdin());
  const res = await runFreeChat(task);
  if (!res.ok) process.exit(res.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
