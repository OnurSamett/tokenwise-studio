#!/usr/bin/env node
// Free-tier OpenAI-compatible chat (OpenRouter ":free" models or Groq). Plain chat, no tools, read-only.
// Never prints or logs the API key.
import { pathToFileURL } from "node:url";

export function freeProvider() {
  if (process.env.OPENROUTER_API_KEY) {
    return { name: "openrouter", base: "https://openrouter.ai/api/v1", key: process.env.OPENROUTER_API_KEY };
  }
  if (process.env.GROQ_API_KEY) {
    return { name: "groq", base: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY };
  }
  return null;
}

let cached = null;

export async function pickModel(p) {
  if (process.env.TOKENWISE_FREE_MODEL) return process.env.TOKENWISE_FREE_MODEL;
  if (cached && cached.name === p.name) return cached.model;
  const res = await fetch(`${p.base}/models`, {
    headers: { Authorization: `Bearer ${p.key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Object.assign(new Error(`models list failed (HTTP ${res.status})`), { status: res.status });
  const body = await res.json();
  let list = Array.isArray(body?.data) ? body.data : [];
  let model;
  if (p.name === "openrouter") {
    list = list.filter((m) => (m?.pricing?.prompt === "0" && m?.pricing?.completion === "0") || String(m?.id).endsWith(":free"));
    const pref = /gpt-oss|qwen|deepseek|llama/i;
    const ctx = (m) => Number(m.context_length) || 0;
    const preferred = list.filter((m) => pref.test(m.id));
    const pool = preferred.length ? preferred : list;
    pool.sort((a, b) => ctx(b) - ctx(a));
    model = pool[0]?.id;
  } else {
    const pref = /gpt-oss|llama|qwen/i;
    model = (list.find((m) => pref.test(m.id)) || list[0])?.id;
  }
  if (!model) throw new Error(`no free model found on ${p.name}`);
  cached = { name: p.name, model };
  return model;
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s.trim();
}

async function main() {
  const p = freeProvider();
  if (!p) {
    out({ type: "free.error", status: 0, message: "no free provider: set OPENROUTER_API_KEY or GROQ_API_KEY" });
    process.exit(2);
  }
  const task = process.argv[2] ?? (await readStdin());
  if (!task) {
    out({ type: "free.error", status: 0, message: "empty task" });
    process.exit(1);
  }
  try {
    const model = await pickModel(p);
    out({ type: "free.init", provider: p.name, model });
    const res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: "You are a careful read-only assistant. Answer the task concisely. You cannot see any files except what is in the task." },
          { role: "user", content: task },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const t = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      const message = res.status === 429 ? "rate limit reached on free tier, try later or another worker" : `HTTP ${res.status}: ${t}`;
      out({ type: "free.error", status: res.status, message });
      process.exit(1);
    }
    const data = await res.json();
    out({ type: "free.message", text: data?.choices?.[0]?.message?.content ?? "" });
    out({ type: "free.usage", usage: { prompt_tokens: data?.usage?.prompt_tokens ?? 0, completion_tokens: data?.usage?.completion_tokens ?? 0 } });
  } catch (e) {
    const status = Number(e?.status) || 0;
    const message = e?.name === "TimeoutError" ? "request timed out after 120s" : String(e?.message || e).slice(0, 200);
    out({ type: "free.error", status, message: status === 429 ? "rate limit reached on free tier" : message });
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
