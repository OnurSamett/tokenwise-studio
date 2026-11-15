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
export function freeProviders({ providers: providerFilter } = {}) {
  const rawOrder = providerFilter || process.env.TOKENWISE_FREE_PROVIDERS || "nvidia,openrouter,groq,mistral,custom";
  const order = rawOrder.split(",").map((s) => s.trim()).filter(Boolean);
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
// Measured latency stays valid for 6h; a model slower than SLOW_MS to answer a tiny probe is demoted behind faster ones.
const LATENCY_TTL_MS = 6 * 60 * 60 * 1000;
export const SLOW_MS = Number(process.env.TOKENWISE_FREE_SLOW_MS) > 0 ? Number(process.env.TOKENWISE_FREE_SLOW_MS) : 15_000;
const MAX_PARALLEL_PROBES = 3;
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

/** Last measured probe latency (ms) of a model, or null when unknown or older than 6h. */
export function modelLatency(provider, model, now = Date.now()) {
  const e = loadHealth()[healthKey(provider, model)];
  return e && e.status === "ok" && Number.isFinite(e.latencyMs) && Number(e.latencyMs) >= 0 && Number(e.latencyAt) > now - LATENCY_TTL_MS ? Number(e.latencyMs) : null;
}
const isSlow = (provider, model, now = Date.now()) => { const l = modelLatency(provider, model, now); return l !== null && l > SLOW_MS; };

/** Persist model health ("ok" or 4h "down") plus the measured latency in ~/.tokenwise-studio/free-health.json. */
export function recordModelHealth(provider, model, ok, reason = "", now = Date.now(), latencyMs = null) {
  const map = loadHealth();
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(map)) {
    if (!v || (Number(v.checkedAt) || 0) < cutoff && (Number(v.downUntil) || 0) <= now) delete map[k];
  }
  const prev = map[healthKey(provider, model)];
  const lat = Number.isFinite(latencyMs) ? { latencyMs: Math.round(latencyMs), latencyAt: now }
    : prev?.status === "ok" && Number.isFinite(prev.latencyMs) ? { latencyMs: prev.latencyMs, latencyAt: prev.latencyAt } : {};
  map[healthKey(provider, model)] = ok
    ? { status: "ok", checkedAt: now, ...lat }
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
  // Keep the quality order, but models measured slower than SLOW_MS go behind the responsive ones.
  return [...alive.filter((id) => !isSlow(p.name, id, now)), ...alive.filter((id) => isSlow(p.name, id, now))];
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

export function forcedModelFor(p, first = false, explicitForced = null) {
  if (explicitForced) return String(explicitForced).trim() || null;
  return (process.env[`TOKENWISE_${p.name.toUpperCase()}_MODEL`] || (first ? process.env.TOKENWISE_FREE_MODEL : "") || "").trim() || null;
}

/** Up to 3 candidate models for this provider, best first (forced goes first with ranked fallbacks; hint reorders ranked ids). */
export async function pickModels(p, first = false, { hint = process.env.TOKENWISE_FREE_HINT, forcedModel = null } = {}) {
  const forced = forcedModelFor(p, first, forcedModel);
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

/** Probe a model with max_tokens=1 (8s timeout); records ok + measured latency or 4h down in free-health.json. Resolves to true. */
export async function probeModel(p, model, { timeoutMs = probeTimeoutMs() } = {}) {
  await timedProbe(p, model, timeoutMs);
  return true;
}

async function timedProbe(p, model, timeoutMs) {
  const t0 = Date.now();
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
    const ms = Date.now() - t0;
    recordModelHealth(p.name, model, true, "ok", Date.now(), ms);
    return ms;
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

/**
 * Pick the order to try `models` in. Candidates that need a probe (max 3) are probed IN PARALLEL; the
 * first-ranked one that answers fast wins immediately (the others finish in the background and only
 * update the health cache). Down/timed-out models are dropped, models slower than SLOW_MS go last.
 * A forced model is returned first without any probe. Never makes a call when the head is freshly probed and fast.
 * Returns { models, latency: {model: ms}, skipped: [{ model, status, message, slow? }] }.
 */
export async function selectReady(p, models, { forced = null, timeoutMs = probeTimeoutMs() } = {}) {
  const latency = {}, skipped = [];
  const known = (m) => modelLatency(p.name, m);
  if (forced) {
    for (const m of models) { const l = known(m); if (l !== null) latency[m] = l; }
    return { models, latency, skipped };
  }
  const window = models.slice(0, MAX_PARALLEL_PROBES);
  const pending = new Map();
  for (const m of window) {
    if (needsProbe(p.name, m)) {
      pending.set(m, timedProbe(p, m, timeoutMs).then((ms) => ({ ok: true, ms }), (err) => ({ ok: false, err })));
    }
  }
  const good = [], slow = [];
  let winner = false;
  for (const m of window) {
    if (winner && pending.has(m)) { good.push(m); continue; } // already have a fast head: leave this probe running in the background
    if (!pending.has(m)) {
      const l = known(m);
      if (l !== null) latency[m] = l;
      (l !== null && l > SLOW_MS ? slow : good).push(m);
      if (l === null || l <= SLOW_MS) winner = true;
      continue;
    }
    const r = await pending.get(m);
    if (r.ok) {
      latency[m] = r.ms;
      if (r.ms > SLOW_MS) { slow.push(m); skipped.push({ model: m, status: 0, message: `slow (${(r.ms / 1000).toFixed(1)}s to answer a probe)`, slow: true }); }
      else { good.push(m); winner = true; }
    } else {
      const status = Number(r.err?.status) || 0;
      if (status === 400 && !isDownError(r.err)) { good.push(m); winner = true; continue; }
      if (isDownError(r.err)) {
        skipped.push({ model: m, status, message: isTimeoutError(r.err) ? `probe to ${p.name} timed out` : String(r.err?.message || r.err).slice(0, 200) });
        continue;
      }
      good.push(m); // rate limit / auth: the real call reports it and the caller skips the provider
      winner = true;
    }
  }
  return { models: [...good, ...slow, ...models.slice(window.length)], latency, skipped };
}

/**
 * Separate a model's internal reasoning from its visible answer. Handles <think>…</think>, harmony channels
 * ("<|channel|>analysis<|message|>…<|end|>", "<|start|>assistant<|channel|>final<|message|>…", only "final" is the answer)
 * and stray "<channel|>" / "<|channel|>" markers (text before the last one is reasoning). Returns { content, reasoning }.
 */
export function splitReasoning(raw) {
  let text = String(raw ?? "");
  const think = [];
  if (!text) return { content: "", reasoning: "" };
  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, r) => { if (r.trim()) think.push(r.trim()); return ""; });
  const close = text.search(/<\/think>/i); // opening tag omitted by the model
  if (close >= 0) { if (text.slice(0, close).trim()) think.push(text.slice(0, close).trim()); text = text.slice(close + 8); }
  if (/<\|channel\|>/.test(text)) {
    const re = /(?:<\|start\|>\s*assistant\s*)?<\|channel\|>\s*([A-Za-z_]+)[^<]*?(?:<\|constrain\|>[^<]*?)?<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|return\|>|<\|call\|>|<\|start\|>|<\|channel\|>|$)/g;
    const finals = [];
    let m, any = false;
    while ((m = re.exec(text))) { any = true; const body = m[2].trim(); if (body) (m[1].toLowerCase() === "final" ? finals : think).push(body); }
    if (any) text = finals.join("\n\n");
  }
  const stray = [...text.matchAll(/<\|?channel\|>/g)].pop();
  if (stray) {
    const before = text.slice(0, stray.index).trim(), after = text.slice(stray.index + stray[0].length).trim();
    if (after) { if (before) think.push(before); text = after; } else text = before;
  }
  text = text.replace(/<\|(?:end|return|call|start|message|constrain)\|>(?:\s*assistant)?/g, "").trim();
  return { content: text, reasoning: think.join("\n\n") };
}

/** Copy of an assistant message with reasoning moved to reasoning_content (API field first) and the content cleaned. */
export function normalizeMessage(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const { content, reasoning } = splitReasoning(typeof msg.content === "string" ? msg.content : "");
  const api = [msg.reasoning_content, msg.reasoning, msg.thinking].find((v) => typeof v === "string" && v.trim()) || "";
  const all = [api.trim(), reasoning].filter(Boolean).join("\n\n");
  const out = { ...msg, content: typeof msg.content === "string" ? content : msg.content };
  if (all) out.reasoning_content = all;
  return out;
}

/**
 * One chat completion, streamed so a long answer never trips a total timeout: only "no first token within
 * firstTokenMs", "silent for idleMs" and the overall totalMs cap abort it (all surface as a TimeoutError).
 * Falls back to a plain JSON body when the server (or a test stub) does not stream.
 * Resolves to an OpenAI-shaped { choices:[{message}], usage, _latency:{ firstMs, totalMs } }.
 */
export async function chatCompletion(p, { model, messages, tools = null, extra = {} }, { firstTokenMs = 30_000, idleMs = 30_000, totalMs = 180_000, usageOpt = true } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  let reason = null, timer = null;
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { reason = why; ac.abort(); }, ms); };
  arm(Math.min(firstTokenMs, totalMs), "no first token");
  const signal = AbortSignal.any ? AbortSignal.any([ac.signal, AbortSignal.timeout(totalMs)]) : ac.signal;
  const timedOut = (e) => (reason ? Object.assign(new Error(`request to ${p.name} timed out (${reason})`), { name: "TimeoutError" }) : e);
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model, messages, ...(tools ? { tools, tool_choice: "auto" } : {}), ...extra, stream: true, ...(usageOpt ? { stream_options: { include_usage: true } } : {}) }),
      signal,
    });
    if (!res.ok) {
      const t = ((await res.text?.().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 200);
      // A provider that rejects stream_options: retry once without it (token usage is then simply not reported).
      if (usageOpt && (res.status === 400 || res.status === 422) && /stream_options|include_usage/i.test(t)) {
        clearTimeout(timer);
        return await chatCompletion(p, { model, messages, tools, extra }, { firstTokenMs, idleMs, totalMs, usageOpt: false });
      }
      throw Object.assign(new Error(res.status === 429 ? `rate limit reached on ${p.name}` : `HTTP ${res.status} from ${p.name}: ${t}`), { status: res.status });
    }
    const ct = String(res.headers?.get?.("content-type") || "");
    if (!/event-stream/i.test(ct) || !res.body?.getReader) {
      const data = await res.json();
      const ms = Date.now() - t0;
      if (data?.choices?.[0]?.message) data.choices[0].message = normalizeMessage(data.choices[0].message);
      return Object.assign(data && typeof data === "object" ? data : {}, { _latency: { firstMs: ms, totalMs: ms } });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const msg = { role: "assistant", content: "" };
    const calls = [];
    let usage = null, buf = "", firstMs = null;
    const onData = (json) => {
      if (json?.error) throw Object.assign(new Error(String(json.error?.message || json.error).slice(0, 200)), { status: Number(json.error?.code) || 0 });
      if (json?.usage) usage = json.usage;
      const d = json?.choices?.[0]?.delta;
      if (!d) return;
      if (firstMs === null) firstMs = Date.now() - t0;
      if (typeof d.content === "string") msg.content += d.content;
      const think = d.reasoning_content ?? d.reasoning;
      if (typeof think === "string") msg.reasoning_content = (msg.reasoning_content || "") + think;
      for (const tc of d.tool_calls || []) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        const c = calls[i] || (calls[i] = { id: tc.id || null, type: "function", function: { name: "", arguments: "" } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") c.function.arguments += tc.function.arguments;
      }
    };
    const line = (l) => {
      l = l.trim();
      if (!l.startsWith("data:")) return;
      const v = l.slice(5).trim();
      if (!v || v === "[DONE]") return;
      let json; try { json = JSON.parse(v); } catch { return; }
      onData(json);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(idleMs, "no data for " + Math.round(idleMs / 1000) + "s");
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    if (buf) line(buf);
    const calls2 = calls.filter(Boolean);
    if (calls2.length) msg.tool_calls = calls2.map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    if (!msg.content) msg.content = calls2.length ? null : "";
    return { choices: [{ message: normalizeMessage(msg) }], usage: usage || undefined, _latency: { firstMs: firstMs ?? Date.now() - t0, totalMs: Date.now() - t0 } };
  } catch (e) {
    throw timedOut(e);
  } finally {
    clearTimeout(timer);
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

async function ask(p, model, task, { totalMs = 180_000, firstTokenMs = 30_000 } = {}) {
  return chatCompletion(p, {
    model,
    messages: [
      { role: "system", content: "You are a careful read-only assistant. Answer the task concisely. You cannot see any files except what is in the task." },
      { role: "user", content: task },
    ],
  }, { totalMs, firstTokenMs });
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

  let last = null, fellFrom = null;
  for (const [i, p] of providers.entries()) {
    let models, sel;
    try {
      models = await pickModels(p, i === 0);
      const forced = forcedModelFor(p, i === 0);
      sel = await selectReady(p, models, { forced: forced && models.includes(forced) ? forced : null, timeoutMs: probeTimeout });
    } catch (e) { last = { status: Number(e?.status) || 0, message: String(e?.message || e).slice(0, 200) }; emit({ type: "free.skip", provider: p.name, status: last.status, message: last.message }); continue; }
    for (const sk of sel.skipped) {
      last = { status: sk.status, message: sk.message };
      fellFrom ||= { from: `${p.name}:${sk.model}`, reason: sk.message };
      emit({ type: "free.skip", provider: p.name, model: sk.model, status: sk.status, message: sk.message });
    }
    for (const [j, model] of sel.models.entries()) {
      const hasNext = j < sel.models.length - 1 || i < providers.length - 1;
      const totalMs = hasNext ? 90_000 : 180_000, firstTokenMs = hasNext ? 20_000 : 60_000;
      try {
        emit({ type: "free.init", provider: p.name, model, ...(sel.latency[model] != null ? { latencyMs: sel.latency[model] } : {}), ...(fellFrom ? { fellBackFrom: fellFrom.from, fellBackReason: fellFrom.reason } : {}) });
        const data = await ask(p, model, task, { totalMs, firstTokenMs });
        recordModelHealth(p.name, model, true, "ok");
        const m0 = normalizeMessage(data?.choices?.[0]?.message || {});
        const text = m0.content ?? "";
        if (m0.reasoning_content) emit({ type: "free.think", text: m0.reasoning_content });
        const usage = { prompt_tokens: data?.usage?.prompt_tokens ?? 0, completion_tokens: data?.usage?.completion_tokens ?? 0 };
        if (data?._latency) emit({ type: "free.latency", provider: p.name, model, ms: data._latency.firstMs });
        emit({ type: "free.message", text });
        emit({ type: "free.usage", usage });
        return { ok: true, exitCode: 0, provider: p.name, model, text, usage, latencyMs: data?._latency?.firstMs ?? sel.latency[model] ?? null, fellBackFrom: fellFrom?.from || null };
      } catch (e) {
        const status = Number(e?.status) || 0;
        const timedOut = isTimeoutError(e);
        const message = timedOut ? `request to ${p.name} timed out (${String(e?.message || "").match(/\(([^)]*)\)/)?.[1] || `${Math.round(totalMs / 1000)}s`})` : String(e?.message || e).slice(0, 200);
        if (isDownError(e)) recordModelHealth(p.name, model, false, message);
        last = { status, message };
        fellFrom ||= { from: `${p.name}:${model}`, reason: message };
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
