// Free models: latency-aware ranking, fast fallback on a stalled model, streaming, and model-label propagation.
// All network access is a stubbed fetch; nothing here calls a real API.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chatCompletion, clearFreeCache, normalizeMessage, splitReasoning, freeProviders, modelLatency, pickModels, recordModelHealth, runFreeChat, selectReady,
} from "../src/freechat.js";
import { runFreeAgent } from "../src/freeagent.js";
import { Jobs } from "../src/jobs.js";
import { normalize } from "../src/events.js";

const KEYS = ["HOME", "NVIDIA_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "TOKENWISE_FREE_PROVIDERS",
  "TOKENWISE_FREE_MODEL", "TOKENWISE_FREE_HINT", "TOKENWISE_NVIDIA_MODEL", "TOKENWISE_FREE_PROBE_TIMEOUT_MS", "TOKENWISE_FREE_BASE", "TOKENWISE_FREE_KEY"];
const CATALOG = ["nvidia/nemotron-3-ultra-550b-a55b", "mistralai/mistral-large-4-1t-a52b", "nvidia/nemotron-3.5-bolt-e4b", "stepfun-ai/step-5-preview"];
const TOP = CATALOG[0], SECOND = CATALOG[1], THIRD = CATALOG[2];
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; }, async text() { return JSON.stringify(body); } });
const sseRes = (chunks, { delayMs = 0 } = {}) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      for (const ch of chunks) { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); c.enqueue(enc.encode(ch)); }
      c.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body };
};
const hangUntilAbort = (init) => new Promise((_, reject) => {
  const fail = () => reject(init.signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
  if (init.signal?.aborted) return fail();
  init.signal?.addEventListener("abort", fail, { once: true });
});

async function withStub(env, stub, fn) {
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const prevFetch = globalThis.fetch;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-speed-"));
  for (const k of KEYS) delete process.env[k];
  process.env.HOME = home;
  process.env.NVIDIA_API_KEY = "nvapi-test-placeholder";
  process.env.TOKENWISE_FREE_PROVIDERS = "nvidia";
  process.env.TOKENWISE_FREE_PROBE_TIMEOUT_MS = "60";
  Object.assign(process.env, env || {});
  clearFreeCache();
  globalThis.fetch = stub;
  try { return await fn(home); } finally {
    globalThis.fetch = prevFetch;
    clearFreeCache();
    for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const catalogRes = () => jsonRes(200, { data: CATALOG.map((id) => ({ id })) });

test("ranking keeps the TB 4.0 order but demotes a model whose measured latency is over 15s (TTL 6h)", async () => {
  await withStub({}, async (url) => (url.endsWith("/models") ? catalogRes() : jsonRes(200, {})), async () => {
    const p = freeProviders()[0];
    assert.equal((await pickModels(p, true))[0], TOP);
    recordModelHealth("nvidia", TOP, true, "ok", Date.now(), 22_000);
    assert.equal(modelLatency("nvidia", TOP), 22_000);
    const ranked = await pickModels(p, true);
    assert.notEqual(ranked[0], TOP);
    assert.equal(ranked[0], SECOND);
    // the slow model is still a last-resort candidate, not dropped
    assert.ok((await pickModels(p, true, { forcedModel: TOP })).includes(TOP));
    // an expired measurement no longer demotes
    recordModelHealth("nvidia", TOP, true, "ok", Date.now() - 7 * 3600_000, 22_000);
    assert.equal(modelLatency("nvidia", TOP), null);
    assert.equal((await pickModels(p, true))[0], TOP);
  });
});

test("selectReady probes the top 3 in parallel, takes the first fast one and drops a timed-out model", async () => {
  let inFlight = 0, maxInFlight = 0;
  const probed = [];
  await withStub({}, async (url, init) => {
    if (url.endsWith("/models")) return catalogRes();
    const body = JSON.parse(init.body);
    probed.push(body.model);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (body.model === TOP) return await hangUntilAbort(init); // stalls: probe timeout
      await new Promise((r) => setTimeout(r, 15));
      return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
    } finally { inFlight--; }
  }, async () => {
    const p = freeProviders()[0];
    const models = await pickModels(p, true);
    const sel = await selectReady(p, models);
    assert.equal(maxInFlight, 3, "the three candidates are probed at the same time");
    assert.deepEqual(probed.slice().sort(), models.slice().sort());
    assert.equal(sel.models[0], SECOND);
    assert.ok(!sel.models.includes(TOP), "timed-out model is dropped");
    assert.equal(sel.skipped[0].model, TOP);
    assert.match(sel.skipped[0].message, /timed out/);
    assert.ok(sel.latency[SECOND] >= 0);
    assert.ok(modelLatency("nvidia", SECOND) !== null, "latency cached in free-health.json");
  });
});

test("a fresh, fast cache makes no probe call at all", async () => {
  let calls = 0;
  await withStub({}, async (url) => { if (url.endsWith("/models")) return catalogRes(); calls++; return jsonRes(200, {}); }, async () => {
    const p = freeProviders()[0];
    const models = await pickModels(p, true);
    for (const m of models) recordModelHealth("nvidia", m, true, "ok", Date.now(), 300);
    const sel = await selectReady(p, models);
    assert.equal(calls, 0);
    assert.deepEqual(sel.models, models);
    assert.equal(sel.latency[models[0]], 300);
  });
});

test("chatCompletion streams text, tool calls and usage, and reports first-token latency", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.js\\"}"}}]}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
  ];
  await withStub({}, async (url, init) => { assert.equal(JSON.parse(init.body).stream, true); return sseRes(chunks); }, async () => {
    const p = freeProviders()[0];
    const data = await chatCompletion(p, { model: TOP, messages: [{ role: "user", content: "x" }], tools: [] });
    const m = data.choices[0].message;
    assert.equal(m.content, "Hello");
    assert.equal(m.tool_calls[0].function.name, "read_file");
    assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { path: "a.js" });
    assert.deepEqual(data.usage, { prompt_tokens: 7, completion_tokens: 3 });
    assert.ok(data._latency.firstMs >= 0 && data._latency.totalMs >= data._latency.firstMs);
  });
});

test("a long streamed answer survives a total time that would have cut a non-streamed call, a stalled one is cut after the idle/first-token limit", async () => {
  await withStub({}, async (url, init) => {
    if (init.body.includes("slow-stall")) return hangUntilAbort(init);
    return sseRes(Array.from({ length: 6 }, (_, i) => `data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`), { delayMs: 25 });
  }, async () => {
    const p = freeProviders()[0];
    const ok = await chatCompletion(p, { model: TOP, messages: [] }, { firstTokenMs: 200, idleMs: 200, totalMs: 5_000 });
    assert.equal(ok.choices[0].message.content, "012345"); // 150ms of output with a 200ms idle limit
    const t0 = Date.now();
    await assert.rejects(() => chatCompletion(p, { model: TOP, messages: [{ role: "user", content: "slow-stall" }] }, { firstTokenMs: 60, totalMs: 5_000 }),
      (e) => e.name === "TimeoutError" && /no first token/.test(e.message));
    assert.ok(Date.now() - t0 < 1000);
  });
});

test("runFreeChat falls back from a model that never sends a token and reports where it fell back from, with latency", async () => {
  await withStub({}, async (url, init) => {
    if (url.endsWith("/models")) return catalogRes();
    const body = JSON.parse(init.body);
    if (body.max_tokens === 1) return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
    return sseRes(['data: {"choices":[{"delta":{"content":"fine"}}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n']);
  }, async () => {
    // top model measured as hanging earlier (down): it is skipped without any call
    recordModelHealth("nvidia", TOP, false, "probe timed out after 8s");
    const events = [];
    const res = await runFreeChat("hello", { emit: (e) => events.push(e) });
    assert.equal(res.ok, true);
    assert.equal(res.model, SECOND);
    const init = events.find((e) => e.type === "free.init");
    assert.equal(init.provider, "nvidia");
    assert.equal(init.model, SECOND);
    assert.ok(Number.isFinite(init.latencyMs));
    assert.ok(events.some((e) => e.type === "free.latency" && e.model === SECOND));
    assert.ok(Number.isFinite(res.latencyMs));
  });

  // a model that answers the probe but then stalls on the real call: fast fallback to the next one
  await withStub({}, async (url, init) => {
    if (url.endsWith("/models")) return catalogRes();
    const body = JSON.parse(init.body);
    if (body.max_tokens === 1) return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
    if (body.model === TOP) return hangUntilAbort(init);
    return jsonRes(200, { choices: [{ message: { content: "from second" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }, async () => {
    const real = AbortSignal.timeout;
    // shrink only the overall cap so the test stays quick; the first-token limit is exercised in the chatCompletion test above
    AbortSignal.timeout = (ms) => real(ms >= 90_000 ? 80 : ms);
    try {
      const events = [];
      const res = await runFreeChat("hello", { emit: (e) => events.push(e) });
      assert.equal(res.ok, true);
      assert.equal(res.model, SECOND);
      assert.equal(res.fellBackFrom, `nvidia:${TOP}`);
      const skip = events.find((e) => e.type === "free.skip" && e.model === TOP);
      assert.match(skip.message, /timed out/);
      assert.equal(events.filter((e) => e.type === "free.init").at(-1).fellBackFrom, `nvidia:${TOP}`);
    } finally { AbortSignal.timeout = real; }
  });
});

test("runFreeAgent announces the model actually used with latency and fallback info", async () => {
  const cwd = process.cwd();
  await withStub({}, async (url, init) => {
    if (url.endsWith("/models")) return catalogRes();
    const body = JSON.parse(init.body);
    if (body.max_tokens === 1) {
      if (body.model === TOP) return hangUntilAbort(init);
      return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
    }
    return jsonRes(200, { choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  }, async () => {
    const events = [];
    const res = await runFreeAgent({ task: "say hi", emit: (e) => events.push(e) });
    assert.equal(res.ok, true);
    assert.equal(res.model, SECOND);
    const init = events.find((e) => e.type === "free.init");
    assert.deepEqual([init.provider, init.model, init.fellBackFrom], ["nvidia", SECOND, `nvidia:${TOP}`]);
    assert.ok(Number.isFinite(init.latencyMs));
    assert.ok(events.some((e) => e.type === "free.skip" && e.model === TOP));
  });
  assert.equal(process.cwd(), cwd);
});

test("job records modelUsed / provider / latency from the log and keeps the requested model; events text shows them", () => {
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-speed-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-speed-repo-"));
  process.env.HOME = home;
  try {
    const jobs = new Jobs(repo);
    const j = jobs.save({ id: "20261114000000-f1", title: "t", agent: "free", model: "auto", effort: "low", status: "running", created: "2026-11-14T00:00:00.000Z" });
    const entry = (o) => JSON.stringify({ t: Date.now(), stream: "out", line: JSON.stringify(o) }) + "\n";
    fs.writeFileSync(jobs.file(j.id, "log"),
      entry({ type: "free.init", provider: "nvidia", model: SECOND, latencyMs: 640, fellBackFrom: `nvidia:${TOP}`, fellBackReason: "probe timed out" })
      + entry({ type: "free.latency", provider: "nvidia", model: SECOND, ms: 480 })
      + entry({ type: "free.usage", usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const u = jobs.usage(j.id);
    assert.equal(u.modelUsed, SECOND);
    assert.equal(u.provider, "nvidia");
    assert.equal(u.latencyMs, 480);
    assert.equal(u.fellBackFrom, `nvidia:${TOP}`);
    assert.equal(u.model, undefined, "job.model keeps the requested value");
    assert.deepEqual(u.tokens, { input: 10, cached: 0, output: 2 });

    const text = normalize("free", { stream: "out", line: JSON.stringify({ type: "free.init", provider: "nvidia", model: SECOND, latencyMs: 640, fellBackFrom: `nvidia:${TOP}` }) }, repo)[0].text;
    assert.match(text, /0\.6s/);
    assert.match(text, /fell back from nvidia:nvidia\/nemotron-3-ultra/);
    assert.deepEqual(normalize("free", { stream: "out", line: JSON.stringify({ type: "free.latency", model: SECOND, ms: 5 }) }, repo), []);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("splitReasoning keeps only the final answer and moves reasoning out (stray marker, harmony channels, <think>)", () => {
  const stray = splitReasoning("My review should focus on correctness.\nI will structure my response in two parts.<channel|>The tests pass: 183 of 183.");
  assert.equal(stray.content, "The tests pass: 183 of 183.");
  assert.match(stray.reasoning, /I will structure my response/);
  assert.equal(splitReasoning("plan<|channel|>Answer").content, "Answer");

  const harmony = splitReasoning("<|channel|>analysis<|message|>User wants a greeting.<|end|><|start|>assistant<|channel|>final<|message|>Hello there!<|return|>");
  assert.equal(harmony.content, "Hello there!");
  assert.equal(harmony.reasoning, "User wants a greeting.");
  const h2 = splitReasoning("<|start|>assistant<|channel|>final<|message|>Only final");
  assert.deepEqual([h2.content, h2.reasoning], ["Only final", ""]);

  const think = splitReasoning("<think>hmm, let me see</think>\n\nDone.");
  assert.deepEqual([think.content, think.reasoning], ["Done.", "hmm, let me see"]);
  assert.deepEqual(splitReasoning("reasoning without opener</think>Final"), { content: "Final", reasoning: "reasoning without opener" });
  assert.deepEqual(splitReasoning("plain answer"), { content: "plain answer", reasoning: "" });
  assert.deepEqual(splitReasoning(null), { content: "", reasoning: "" });
});

test("normalizeMessage prefers the API reasoning field and merges extracted reasoning; tool-call messages keep null content", () => {
  const m = normalizeMessage({ content: "x<channel|>Final", reasoning: "api thoughts" });
  assert.equal(m.content, "Final");
  assert.equal(m.reasoning_content, "api thoughts\n\nx");
  assert.equal(normalizeMessage({ content: null, tool_calls: [{}] }).content, null);
  assert.equal(normalizeMessage({ content: "ok", reasoning_content: "r" }).reasoning_content, "r");
});

test("free runs emit leaked reasoning as free.think and a clean free.message (streamed delta.reasoning_content and inline markers)", async () => {
  await withStub({}, async (url, init) => {
    if (url.endsWith("/models")) return catalogRes();
    if (JSON.parse(init.body).max_tokens === 1) return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
    return sseRes([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking A. "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"I will structure my response.<chan"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"nel|>The real answer."}}]}\n\n',
    ]);
  }, async () => {
    const chat = [];
    const r = await runFreeChat("q", { emit: (e) => chat.push(e) });
    assert.equal(r.text, "The real answer.");
    assert.equal(chat.find((e) => e.type === "free.message").text, "The real answer.");
    assert.match(chat.find((e) => e.type === "free.think").text, /thinking A\.[\s\S]*I will structure/);
    const ag = [];
    const r2 = await runFreeAgent({ task: "q", emit: (e) => ag.push(e) });
    assert.equal(r2.text, "The real answer.");
    assert.ok(ag.some((e) => e.type === "free.think"));
  });
});

test("splitReasoning bounds input and scans adversarial 140 KB inputs in under 50 ms", () => {
  // Warm the parser before measuring the adversarial cases.
  splitReasoning("<think>plan</think>answer");
  for (const input of ["<think>".repeat(20 * 1024), "<|channel|>" + "a".repeat(140 * 1024), "<|channel|>".repeat(13 * 1024)]) {
    const start = performance.now();
    splitReasoning(input);
    const ms = performance.now() - start;
    assert.ok(ms < 50, `reasoning scan took ${ms.toFixed(1)}ms`);
  }
  assert.equal(splitReasoning("x".repeat(600 * 1024)).content.length, 512 * 1024);
  assert.deepEqual(splitReasoning("İ<think>plan</think>answer"), { content: "İanswer", reasoning: "plan" });
  assert.deepEqual(splitReasoning("a<THINK>one</THINK>b<think>two</think>c"), { content: "abc", reasoning: "one\n\ntwo" });
});

test("chatCompletion rejects oversized SSE buffers and combined content, reasoning and tool arguments", async () => {
  const p = { name: "test", base: "https://stub", key: "x" };
  await withStub({}, async () => sseRes(["x".repeat(1024 * 1024 + 1)]), async () => {
    await assert.rejects(chatCompletion(p, { model: TOP, messages: [] }), /SSE buffer exceeds 1 MB/);
  });
  const event = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  const text = "x".repeat(256 * 1024);
  const chunks = [
    ...Array.from({ length: 6 }, () => event({ content: text })),
    ...Array.from({ length: 6 }, () => event({ reasoning_content: text })),
    ...Array.from({ length: 5 }, () => event({ tool_calls: [{ index: 0, function: { arguments: text } }] })),
  ];
  await withStub({}, async () => sseRes(chunks), async () => {
    await assert.rejects(chatCompletion(p, { model: TOP, messages: [] }), /completion exceeds 4 MB/);
  });
  await withStub({}, async () => sseRes(Array.from({ length: 9 }, () => event({ content: "é".repeat(256 * 1024) }))), async () => {
    await assert.rejects(chatCompletion(p, { model: TOP, messages: [] }), /completion exceeds 4 MB/);
  });
});

test("free.think emission is capped at 64 KB", async () => {
  await withStub({}, async (url, init) => {
    if (url.endsWith('/models')) return catalogRes();
    if (JSON.parse(init.body).max_tokens === 1) return jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
    return sseRes([`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer', reasoning_content: 'r'.repeat(80 * 1024) } }] })}\n\n`]);
  }, async () => {
    const events = [];
    const result = await runFreeChat('q', { emit: (e) => events.push(e) });
    assert.equal(result.text, 'answer');
    assert.equal(events.find((e) => e.type === 'free.think').text.length, 64 * 1024);
  });
});
