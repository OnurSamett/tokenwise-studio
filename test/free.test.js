import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearFreeCache,
  freeProviders,
  isModelDown,
  listFreeModels,
  needsProbe,
  pickModels,
  probeModel,
  recordModelHealth,
  runFreeChat,
} from "../src/freechat.js";
import { runFreeAgent } from "../src/freeagent.js";
import { command, parseFreeModel, resolve } from "../src/workers.js";
import { prepareDelegateArgs, createOrchestratorTools, detectCommandTask } from "../src/mcp.js";
import { Jobs } from "../src/jobs.js";
import { buildGuide } from "../src/orchestrator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (prefix = "tw-free-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const ENV_KEYS = [
  "HOME",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOKENWISE_FREE_BASE",
  "TOKENWISE_FREE_KEY",
  "TOKENWISE_FREE_PROVIDERS",
  "TOKENWISE_FREE_MODEL",
  "TOKENWISE_FREE_HINT",
  "TOKENWISE_NVIDIA_MODEL",
  "TOKENWISE_OPENROUTER_MODEL",
  "TOKENWISE_GROQ_MODEL",
  "TOKENWISE_MISTRAL_MODEL",
  "TOKENWISE_FREE_PROBE_TIMEOUT_MS",
];

async function withEnvAndFetch(overrides, fetchStub, fn) {
  const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevFetch = globalThis.fetch;
  const home = tmp("tw-free-home-");

  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  process.env.NVIDIA_API_KEY = "nvapi-test-placeholder";
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  clearFreeCache();
  if (fetchStub) globalThis.fetch = fetchStub;

  try {
    return await fn(home);
  } finally {
    globalThis.fetch = prevFetch;
    clearFreeCache();
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

const NVIDIA_CATALOG = [
  "nvidia/nemotron-3.5-bolt-e4b",
  "deepseek-ai/deepseek-v4.1-flash",
  "mistralai/mistral-large-4-1t-a52b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "stepfun-ai/step-5-preview",
];

test("alias -> hint: workers.js, mcp.js, and pickModels treat bare aliases as ranking hints and keep fallbacks", async () => {
  await withEnvAndFetch({}, async (url) => {
    if (url.endsWith("/models")) return jsonRes(200, { data: NVIDIA_CATALOG.map((id) => ({ id })) });
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    // 1. workers.js parse/resolve/command on bare alias "deepseek"
    assert.deepEqual(parseFreeModel("deepseek"), { kind: "hint", provider: null, hint: "deepseek", model: "auto" });
    const spec = resolve({ agent: "free", model: "deepseek", effort: "medium" });
    assert.equal(spec.model, "auto");
    assert.equal(spec.hint, "deepseek");

    const cmdHint = command(spec, { task: "explain code", cwd: "/tmp", write: false });
    assert.equal(cmdHint.env.TOKENWISE_FREE_HINT, "deepseek");
    assert.equal(cmdHint.env.TOKENWISE_FREE_MODEL, "");

    // Direct command() call without resolve() also treats bare alias as hint
    const cmdDirect = command({ agent: "free", model: "deepseek", effort: "medium" }, { task: "explain code", cwd: "/tmp", write: false });
    assert.equal(cmdDirect.env.TOKENWISE_FREE_HINT, "deepseek");
    assert.equal(cmdDirect.env.TOKENWISE_FREE_MODEL, "");

    // Provider-prefixed bare alias "nvidia:deepseek" becomes hint on nvidia
    const cmdNvidiaAlias = command({ agent: "free", model: "nvidia:deepseek", effort: "medium" }, { task: "explain code", cwd: "/tmp", write: false });
    assert.equal(cmdNvidiaAlias.env.TOKENWISE_FREE_HINT, "deepseek");
    assert.equal(cmdNvidiaAlias.env.TOKENWISE_FREE_PROVIDERS, "nvidia");

    // Full "provider:org/model" remains an explicit forced model
    const cmdFull = command({ agent: "free", model: "nvidia:mistralai/mistral-large-4-1t-a52b", effort: "medium" }, { task: "explain code", cwd: "/tmp", write: false });
    assert.equal(cmdFull.env.TOKENWISE_NVIDIA_MODEL, "mistralai/mistral-large-4-1t-a52b");
    assert.equal(cmdFull.env.TOKENWISE_FREE_HINT, undefined);

    // 2. mcp.js prepareDelegateArgs validates & converts bare alias to hint
    const prepAlias = prepareDelegateArgs({ agent: "free", model: "deepseek", task: "inspect files" });
    assert.equal(prepAlias.model, "auto");
    assert.equal(prepAlias.hint, "deepseek");
    const prepFull = prepareDelegateArgs({ agent: "free", model: "nvidia:mistralai/mistral-large-4-1t-a52b", task: "inspect files" });
    assert.equal(prepFull.model, "nvidia:mistralai/mistral-large-4-1t-a52b");
    assert.equal(prepFull.hint, undefined);
    assert.throws(() => prepareDelegateArgs({ agent: "free", model: "openai:gpt-4", task: "inspect files" }), /provider/);
    assert.throws(() => prepareDelegateArgs({ agent: "free", model: "bad model!", task: "inspect files" }), /free model/);

    // 3. Default 22906de coding/tool-use ranking preserved when no hint is set
    const p = freeProviders()[0];
    const defaultTop = await pickModels(p, true);
    assert.deepEqual(defaultTop, [
      "nvidia/nemotron-3-ultra-550b-a55b",
      "mistralai/mistral-large-4-1t-a52b",
      "nvidia/nemotron-3.5-bolt-e4b",
    ]);

    // 4. Hint reorders ranked ids while keeping top 3 fallbacks
    process.env.TOKENWISE_FREE_HINT = "deepseek";
    const hintedTop = await pickModels(p, true);
    assert.deepEqual(hintedTop, [
      "deepseek-ai/deepseek-v4.1-flash",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "mistralai/mistral-large-4-1t-a52b",
    ]);
  });
});

test("forced 404 -> falls through to ranked fallback and marks forced model down in free-health.json", async () => {
  const calls = [];
  await withEnvAndFetch(
    { TOKENWISE_NVIDIA_MODEL: "moonshotai/kimi-k2.6", TOKENWISE_FREE_PROVIDERS: "nvidia" },
    async (url, init) => {
      if (url.endsWith("/models")) {
        return jsonRes(200, { data: NVIDIA_CATALOG.map((id) => ({ id })) });
      }
      const body = JSON.parse(init.body);
      calls.push({ model: body.model, max_tokens: body.max_tokens });
      if (body.model === "moonshotai/kimi-k2.6") {
        return jsonRes(404, { status: 404, title: "Not Found", detail: "Function 'abc': Not found for account" });
      }
      if (body.max_tokens === 1) {
        return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
      }
      return jsonRes(200, {
        choices: [{ message: { content: "fallback answer" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
    async (home) => {
      const p = freeProviders()[0];
      // Forced goes first, ranked fallbacks follow (deduped, top 3)
      const candidates = await pickModels(p, true);
      assert.deepEqual(candidates, [
        "moonshotai/kimi-k2.6",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "mistralai/mistral-large-4-1t-a52b",
      ]);

      // Dedupe when forced is already in ranked list
      process.env.TOKENWISE_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
      assert.deepEqual(await pickModels(p, true), [
        "nvidia/nemotron-3-ultra-550b-a55b",
        "mistralai/mistral-large-4-1t-a52b",
        "nvidia/nemotron-3.5-bolt-e4b",
      ]);

      // Restore dead forced model and run freechat
      process.env.TOKENWISE_NVIDIA_MODEL = "moonshotai/kimi-k2.6";
      const events = [];
      const res = await runFreeChat("hello", { emit: (e) => events.push(e) });
      assert.equal(res.ok, true);
      assert.equal(res.model, "nvidia/nemotron-3-ultra-550b-a55b");
      assert.equal(res.text, "fallback answer");
      assert.ok(events.some((e) => e.type === "free.skip" && e.model === "moonshotai/kimi-k2.6" && e.status === 404));

      // Forced model is now marked down for 4h on disk; ranked fallback was probed ok
      assert.equal(isModelDown("nvidia", "moonshotai/kimi-k2.6"), true);
      assert.equal(isModelDown("nvidia", "nvidia/nemotron-3-ultra-550b-a55b"), false);
      assert.equal(needsProbe("nvidia", "nvidia/nemotron-3-ultra-550b-a55b"), false);
      const health = JSON.parse(fs.readFileSync(path.join(home, ".tokenwise-studio", "free-health.json"), "utf8"));
      assert.equal(health["nvidia:moonshotai/kimi-k2.6"].status, "down");
      assert.equal(health["nvidia:nvidia/nemotron-3-ultra-550b-a55b"].status, "ok");

      // A forced model is called directly (no probe) and its fallbacks are not probed up front either (fewer calls)
      assert.deepEqual(calls, [
        { model: "moonshotai/kimi-k2.6", max_tokens: undefined },
        { model: "nvidia/nemotron-3-ultra-550b-a55b", max_tokens: undefined },
      ]);

      // freeagent also falls through from forced 404 to next model (and skips re-probing nemotron within 1h)
      calls.length = 0;
      const agentEvents = [];
      const agentRes = await runFreeAgent({ task: "say hi", emit: (e) => agentEvents.push(e) });
      assert.equal(agentRes.ok, true);
      assert.equal(agentRes.model, "nvidia/nemotron-3-ultra-550b-a55b");
      assert.ok(agentEvents.some((e) => e.type === "free.skip" && e.model === "moonshotai/kimi-k2.6" && e.status === 404));
      assert.deepEqual(calls, [
        { model: "moonshotai/kimi-k2.6", max_tokens: undefined },
        { model: "nvidia/nemotron-3-ultra-550b-a55b", max_tokens: undefined },
      ]);
    },
  );
});

test("down cache skip: models marked down within 4h are skipped in ranking and listFreeModels, and return after 4h", async () => {
  await withEnvAndFetch(
    { TOKENWISE_FREE_PROVIDERS: "nvidia" },
    async (url) => {
      if (url.endsWith("/models")) return jsonRes(200, { data: NVIDIA_CATALOG.map((id) => ({ id })) });
      throw new Error(`unexpected fetch ${url}`);
    },
    async () => {
      const now = Date.now();
      recordModelHealth("nvidia", "nvidia/nemotron-3-ultra-550b-a55b", false, "HTTP 404", now);
      recordModelHealth("nvidia", "deepseek-ai/deepseek-v4.1-flash", false, "timeout", now);

      const p = freeProviders()[0];
      const top = await pickModels(p, true);
      assert.deepEqual(top, [
        "mistralai/mistral-large-4-1t-a52b",
        "nvidia/nemotron-3.5-bolt-e4b",
        "stepfun-ai/step-5-preview",
      ]);

      const listed = await listFreeModels();
      assert.equal(listed.some((m) => m.model === "nvidia/nemotron-3-ultra-550b-a55b"), false);
      assert.equal(listed.some((m) => m.model === "deepseek-ai/deepseek-v4.1-flash"), false);
      assert.equal(listed[0].model, "mistralai/mistral-large-4-1t-a52b");

      // Auth / rate-limit errors must NOT mark models down
      assert.equal(isModelDown("nvidia", "mistralai/mistral-large-4-1t-a52b"), false);

      // Expired down entry (>4h ago) is eligible again
      const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
      recordModelHealth("nvidia", "nvidia/nemotron-3-ultra-550b-a55b", false, "HTTP 404", fiveHoursAgo);
      assert.equal(isModelDown("nvidia", "nvidia/nemotron-3-ultra-550b-a55b", now), false);
      assert.equal((await pickModels(p, true))[0], "nvidia/nemotron-3-ultra-550b-a55b");
    },
  );
});

test("probe timeout marks down and moves to next ranked candidate; 429 does not mark down", async () => {
  const timeoutsSeen = [];
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    timeoutsSeen.push(ms);
    return origTimeout(ms);
  };

  try {
    await withEnvAndFetch(
      { TOKENWISE_FREE_PROVIDERS: "nvidia", TOKENWISE_FREE_PROBE_TIMEOUT_MS: "25" },
      async (url, init) => {
        if (url.endsWith("/models")) {
          return jsonRes(200, {
            data: [
              { id: "nvidia/nemotron-3-ultra-550b-a55b" },
              { id: "mistralai/mistral-large-4-1t-a52b" },
            ],
          });
        }
        const body = JSON.parse(init.body);
        if (body.model === "nvidia/nemotron-3-ultra-550b-a55b") {
          // Hang until AbortSignal.timeout fires
          return await new Promise((_, reject) => {
            if (init.signal?.aborted) return reject(init.signal.reason || Object.assign(new Error("aborted"), { name: "TimeoutError" }));
            init.signal?.addEventListener("abort", () => {
              reject(init.signal.reason || Object.assign(new Error("aborted"), { name: "TimeoutError" }));
            }, { once: true });
          });
        }
        if (body.max_tokens === 1) {
          return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
        }
        return jsonRes(200, {
          choices: [{ message: { content: "mistral ok" } }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        });
      },
      async () => {
        const p = freeProviders()[0];
        await assert.rejects(() => probeModel(p, "nvidia/nemotron-3-ultra-550b-a55b"), (e) => e?.name === "TimeoutError");
        assert.equal(isModelDown("nvidia", "nvidia/nemotron-3-ultra-550b-a55b"), true);

        // Next run skips the timed-out model, probes mistral, and uses 180s (no more candidates queued after mistral)
        timeoutsSeen.length = 0;
        const events = [];
        const res = await runFreeChat("hello", { emit: (e) => events.push(e) });
        assert.equal(res.ok, true);
        assert.equal(res.model, "mistralai/mistral-large-4-1t-a52b");
        assert.equal(timeoutsSeen.includes(25), true);
        assert.equal(timeoutsSeen.includes(180_000), true);
      },
    );

    // When another candidate is queued, per-call timeout drops to 90s
    await withEnvAndFetch(
      { TOKENWISE_FREE_PROVIDERS: "nvidia", TOKENWISE_FREE_PROBE_TIMEOUT_MS: "25" },
      async (url, init) => {
        if (url.endsWith("/models")) {
          return jsonRes(200, {
            data: [
              { id: "nvidia/nemotron-3-ultra-550b-a55b" },
              { id: "mistralai/mistral-large-4-1t-a52b" },
            ],
          });
        }
        const body = JSON.parse(init.body);
        if (body.max_tokens === 1) return jsonRes(200, { choices: [{ message: { content: "ok" } }] });
        return jsonRes(200, { choices: [{ message: { content: "nemotron ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
      async () => {
        timeoutsSeen.length = 0;
        const res = await runFreeChat("hello", { emit: () => {} });
        assert.equal(res.ok, true);
        assert.equal(timeoutsSeen.includes(90_000), true);
        assert.equal(timeoutsSeen.includes(180_000), false);
      },
    );

    // 429 on probe must NOT mark the model down
    await withEnvAndFetch(
      { TOKENWISE_FREE_PROVIDERS: "nvidia", TOKENWISE_FREE_PROBE_TIMEOUT_MS: "25" },
      async () => jsonRes(429, { error: "rate limit" }),
      async () => {
        const p = freeProviders()[0];
        await assert.rejects(() => probeModel(p, "mistralai/mistral-large-4-1t-a52b"), (e) => e?.status === 429);
        assert.equal(isModelDown("nvidia", "mistralai/mistral-large-4-1t-a52b"), false);
      },
    );
  } finally {
    AbortSignal.timeout = origTimeout;
  }
});

test("orchestrator GUIDE and MCP delegate description specify auto or nvidia:<id> for free workers", () => {
  for (const mode of ["ask", "auto-apply", "plan-only"]) {
    const g = buildGuide(mode);
    assert.match(g, /free/);
    assert.match(g, /model="auto"/);
    assert.match(g, /nvidia:<id>/);
  }
  const mcpSrc = fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8");
  assert.match(mcpSrc, /model='auto'/);
  assert.match(mcpSrc, /nvidia:<id>/);
});

test("mcp.js rejects command-running tasks delegated to free or local workers and suggests job_test or another agent", () => {
  const badTasks = [
    "Run npm test and report failures",
    "Run the unit tests in this repo",
    "Execute pytest -q on the test suite",
    "Install dependencies before editing",
    "Build the project and verify output",
    "Run cargo test on workspace",
    "Run go test ./...",
    "Run rojo build to check the place file",
    "Lint src with selene",
    "Format scripts with stylua",
  ];
  for (const agent of ["free", "local"]) {
    for (const task of badTasks) {
      assert.ok(detectCommandTask(task), `expected detectCommandTask to match: ${task}`);
      assert.throws(
        () => prepareDelegateArgs({ agent, model: agent === "free" ? "auto" : "local", task }),
        /job_test.*another agent/i,
      );
    }
    // Non-command tasks and explicit negative disclaimers are allowed
    assert.doesNotThrow(() =>
      prepareDelegateArgs({ agent, model: agent === "free" ? "auto" : "local", task: "Inspect test/free.test.js and summarize the assertions" }),
    );
    assert.doesNotThrow(() =>
      prepareDelegateArgs({ agent, model: agent === "free" ? "auto" : "local", task: "Update src/math.js to fix rounding. Do not run tests." }),
    );
  }
  // Paid agents may receive command-running tasks
  assert.doesNotThrow(() =>
    prepareDelegateArgs({ agent: "codex", model: "sol", task: "Run npm test and fix failures" }),
  );

  // delegate handler returns isError with clear guidance
  const repo = tmp("tw-mcp-free-cmd-");
  try {
    const jobs = new Jobs(repo);
    const tools = createOrchestratorTools({ jobs, parent: null, permissionMode: "ask" });
    return tools.callTool("delegate", { agent: "free", model: "auto", task: "Run npm test and fix errors", write: true }).then((res) => {
      assert.equal(res.isError, true);
      assert.match(res.text, /cannot run commands/i);
      assert.match(res.text, /job_test/);
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("runFreeAgent caps free workers at 25 tool steps", async () => {
  const repo = tmp("tw-free-cap-");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  try {
    let calls = 0;
    const events = [];
    const res = await runFreeAgent({
      task: "Inspect files",
      root: repo,
      emit: (e) => events.push(e),
      chatFn: async () => {
        calls++;
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: `c${calls}`, function: { name: "list_dir", arguments: '{"path":"."}' } }],
            },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        };
      },
    });
    assert.equal(res.ok, false);
    assert.equal(calls, 25);
    assert.match(res.message, /stopped after 25 tool steps/i);
    assert.equal(events.filter((e) => e.type === "free.tool").length, 25);

    // Also caps burst tool calls within a single model response at 25 tool steps
    let burstExecuted = 0;
    const burstRes = await runFreeAgent({
      task: "Inspect files",
      root: repo,
      emit: (e) => { if (e.type === "free.tool") burstExecuted++; },
      chatFn: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: Array.from({ length: 30 }, (_, i) => ({
              id: `b${i}`,
              function: { name: "list_dir", arguments: '{"path":"."}' },
            })),
          },
        }],
      }),
    });
    assert.equal(burstRes.ok, false);
    assert.equal(burstExecuted, 25);
    assert.match(burstRes.message, /stopped after 25 tool steps/i);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("runFreeAgent stops early when the same failing tool call repeats 3 times", async () => {
  const repo = tmp("tw-free-repeat-");
  fs.writeFileSync(path.join(repo, "code.js"), "const x = 1;\n");
  try {
    let turn = 0;
    const events = [];
    const res = await runFreeAgent({
      task: "Edit code.js",
      write: true,
      root: repo,
      emit: (e) => events.push(e),
      chatFn: async () => {
        turn++;
        // Alternate key order on the 2nd call to verify canonical argument matching
        const args = turn === 2
          ? JSON.stringify({ new_text: "const x = 2;", old_text: "missing", path: "code.js" })
          : JSON.stringify({ path: "code.js", old_text: "missing", new_text: "const x = 2;" });
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: `f${turn}`, function: { name: "replace_in_file", arguments: args } }],
            },
          }],
        };
      },
    });
    assert.equal(res.ok, false);
    assert.equal(turn, 3);
    assert.match(res.message, /repeated 3 times/i);
    assert.equal(events.filter((e) => e.type === "free.tool" && e.error).length, 3);

    // Two failures followed by a different successful call and final answer must NOT stop early
    let seq = 0;
    const okRes = await runFreeAgent({
      task: "Edit code.js",
      write: true,
      root: repo,
      emit: () => {},
      chatFn: async () => {
        seq++;
        if (seq <= 2) {
          return {
            choices: [{
              message: {
                content: null,
                tool_calls: [{ id: `r${seq}`, function: { name: "read_file", arguments: '{"path":"missing.js"}' } }],
              },
            }],
          };
        }
        if (seq === 3) {
          return {
            choices: [{
              message: {
                content: null,
                tool_calls: [{ id: `r${seq}`, function: { name: "read_file", arguments: '{"path":"code.js"}' } }],
              },
            }],
          };
        }
        return { choices: [{ message: { content: "done" } }] };
      },
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.text, "done");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
