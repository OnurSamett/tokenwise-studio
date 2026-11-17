import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  AGY_MCP_NAME,
  MCP_SERVER_PATH,
  agyMcpAddArgs,
  agyMcpRemoveArgs,
  readAgyMcpState,
  syncGeminiMcp,
} from "../src/antigravity.js";
import { doSetup, doUninstall } from "../src/cli.js";
import { recordCooldown } from "../src/cooldowns.js";
import { clearDoctorCache } from "../src/doctor.js";
import { normalize } from "../src/events.js";
import { available } from "../src/fallback.js";
import {
  READ_TOOLS,
  WRITE_TOOLS,
  getFreeOrchestratorTools,
  runFreeOrchestrator,
} from "../src/freeagent.js";
import { Jobs } from "../src/jobs.js";
import {
  createOrchestratorTools,
  getOrchToolSpecs,
  prepareDelegateArgs,
  resolveChatId,
} from "../src/mcp.js";
import {
  Chats,
  buildGuide,
  buildPrompt,
  geminiCommand,
  modelToOrchAgent,
  nextOrchestrator,
  pickOrchestrator,
} from "../src/orchestrator.js";
import { DEFAULTS, loadSettings, saveSettings } from "../src/settings.js";
import { teamGuide, teamOptions } from "../src/team.js";
import { handler, initServer } from "../src/ui.js";

const tmp = (prefix = "tw-orch-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const envKeys = [
    "HOME",
    "TOKENWISE_NOTIFY",
    "TOKENWISE_ALLOW_FREE",
    "TOKENWISE_ALLOW_GEMINI_ORCH",
    "TOKENWISE_FREE_MODE",
    "TOKENWISE_ORCH_FORCE",
    "TOKENWISE_ORCH_FALLBACK",
    "NVIDIA_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
  ];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const home = tmp("tw-home-");
  process.env.HOME = home;
  process.env.TOKENWISE_NOTIFY = "0";
  for (const k of envKeys.slice(2)) delete process.env[k];
  clearDoctorCache();
  const cleanup = () => {
    clearDoctorCache();
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  };
  try {
    const res = fn(home);
    if (res && typeof res.then === "function") return res.finally(cleanup);
    cleanup();
    return res;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function initGitRepo() {
  const repo = tmp("tw-repo-");
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, "app.js"), "export const x = 1;\n");
  git("add", "README.md", "app.js");
  git("commit", "-m", "init");
  return repo;
}

function installFakeWorkerBin(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const codexScript = [
    `#!${process.execPath}`,
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "login" && args[1] === "status") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }',
    'if (args[0] === "debug" && args[1] === "models") { process.stdout.write(JSON.stringify({ models: [{ slug: "gpt-5-codex-sol", visibility: "list", priority: 1 }, { slug: "gpt-5-codex-terra", visibility: "list", priority: 2 }, { slug: "gpt-5-codex-luna", visibility: "list", priority: 3 }] })); process.exit(0); }',
    "const cdIdx = args.indexOf('--cd');",
    "const cwd = cdIdx >= 0 ? args[cdIdx + 1] : process.cwd();",
    "const isWrite = args.includes('workspace-write');",
    "if (isWrite) { fs.writeFileSync(path.join(cwd, 'app.js'), 'export const x = 2;\\n'); }",
    'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Updated app.js to export x = 2." } }) + "\\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 15 } }) + "\\n");',
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "codex"), codexScript, { mode: 0o755 });

  const claudeScript = [
    `#!${process.execPath}`,
    "const args = process.argv.slice(2);",
    'if (args[0] === "auth" && args[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }',
    'process.stdout.write(JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }) + "\\n");',
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "claude"), claudeScript, { mode: 0o755 });

  const agyScript = [
    `#!${process.execPath}`,
    "const args = process.argv.slice(2);",
    'if (args[0] === "models" || (args[0] === "agent" && args[1] === "models")) { process.stdout.write("gemini-2.5-hydrogen-medium\\ngemini-2.5-hydrogen-low\\ngemini-2.5-argon-high\\n"); process.exit(0); }',
    'process.stdout.write(JSON.stringify({ type: "result", content: "gemini reply", usage: { input_tokens: 120, output_tokens: 45 } }) + "\\n");',
  ].join("\n");
  const agyPath = path.join(binDir, "agy");
  fs.writeFileSync(agyPath, agyScript, { mode: 0o755 });
  return { agyPath };
}

async function callHandler(method, urlPath, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", "sec-fetch-site": "same-origin", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
  let status = 200;
  let headers = {};
  const chunks = [];
  const res = {
    writeHead(code, h = {}) { status = code; headers = h; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
  };
  const pending = handler(req, res);
  if (method === "POST") req.end(JSON.stringify(bodyObj ?? {}));
  else req.end();
  await pending;
  const text = Buffer.concat(chunks).toString("utf8");
  return { status, headers, body: text ? JSON.parse(text) : null };
}

test("getFreeOrchestratorTools exposes read-only + orchestrator tools and never exposes write/edit tools", async () => {
  const writeToolNames = new Set(WRITE_TOOLS.map((t) => t.function.name));
  assert.ok(writeToolNames.has("write_file"));
  assert.ok(writeToolNames.has("replace_in_file"));

  for (const mode of ["ask", "auto-apply", "plan-only"]) {
    const tools = getFreeOrchestratorTools(mode);
    const names = tools.map((t) => t.function.name);
    for (const w of writeToolNames) {
      assert.ok(!names.includes(w), `write tool ${w} must not be exposed in mode ${mode}`);
    }
    for (const r of READ_TOOLS.map((t) => t.function.name)) {
      assert.ok(names.includes(r), `read tool ${r} must be exposed in mode ${mode}`);
    }
    for (const o of ["delegate", "job_wait", "job_status", "job_diff", "job_discard", "job_test", "project_map"]) {
      assert.ok(names.includes(o), `orchestrator tool ${o} must be exposed in mode ${mode}`);
    }
    if (mode === "plan-only") {
      assert.ok(!names.includes("job_merge"), "job_merge must be omitted in plan-only mode");
    } else {
      assert.ok(names.includes("job_merge"), `job_merge must be included in ${mode} mode`);
    }
  }
});

test("free orchestrator loop with stubbed chatFn: delegates job, waits, reviews diff, summarizes, blocks write tools, and keeps compact running history", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;
    const { agyPath } = installFakeWorkerBin(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    process.env.TOKENWISE_AGY = agyPath;
    process.env.NVIDIA_API_KEY = "nvapi-test-key";
    clearDoctorCache();

    try {
      saveSettings({ allowFree: true, permissionMode: "ask" });
      const jobs = new Jobs(repo);
      const events = [];
      let delegatedId = null;
      let step = 0;

      const stubChatFn = async ({ messages, tools }) => {
        step++;
        const toolNames = tools.map((t) => t.function.name);
        assert.ok(!toolNames.includes("write_file"));
        assert.ok(!toolNames.includes("replace_in_file"));

        if (step === 1) {
          // Also verify that calling write_file is rejected even if hallucinated by model
          return {
            provider: "NVIDIA",
            model: "deepseek-ai/deepseek-v3.2",
            usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
            msg: {
              role: "assistant",
              reasoning_content: "Planning the delegation and checking write guard.",
              content: "",
              tool_calls: [
                {
                  id: "tc_write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "app.js", content: "hacked" }),
                  },
                },
                {
                  id: "tc_del",
                  type: "function",
                  function: {
                    name: "delegate",
                    arguments: JSON.stringify({
                      agent: "codex",
                      model: "sol",
                      effort: "medium",
                      write: true,
                      role: "code",
                      title: "Update x in app.js",
                      task: "Change x to 2 in app.js and save the file.",
                    }),
                  },
                },
              ],
            },
          };
        }
        if (step === 2) {
          const writeToolReply = messages.find((m) => m.role === "tool" && m.tool_call_id === "tc_write");
          assert.match(writeToolReply.content, /error: tool write_file is not available in this mode/i);
          assert.equal(fs.readFileSync(path.join(repo, "app.js"), "utf8"), "export const x = 1;\n");

          const delReply = messages.find((m) => m.role === "tool" && m.tool_call_id === "tc_del");
          const parsed = JSON.parse(delReply.content);
          delegatedId = parsed.id;
          assert.ok(delegatedId);

          return {
            provider: "NVIDIA",
            model: "deepseek-ai/deepseek-v3.2",
            usage: { prompt_tokens: 140, completion_tokens: 25, total_tokens: 165 },
            msg: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "tc_wait",
                  type: "function",
                  function: {
                    name: "job_wait",
                    arguments: JSON.stringify({ id: delegatedId, timeout_s: 30 }),
                  },
                },
              ],
            },
          };
        }
        if (step === 3) {
          const waitReply = messages.find((m) => m.role === "tool" && m.tool_call_id === "tc_wait");
          const waited = JSON.parse(waitReply.content);
          assert.equal(waited.status, "done");

          return {
            provider: "NVIDIA",
            model: "deepseek-ai/deepseek-v3.2",
            usage: { prompt_tokens: 180, completion_tokens: 20, total_tokens: 200 },
            msg: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "tc_diff",
                  type: "function",
                  function: {
                    name: "job_diff",
                    arguments: JSON.stringify({ id: delegatedId }),
                  },
                },
              ],
            },
          };
        }
        const diffReply = messages.find((m) => m.role === "tool" && m.tool_call_id === "tc_diff");
        assert.match(diffReply.content, /\+export const x = 2;/);
        return {
          provider: "NVIDIA",
          model: "deepseek-ai/deepseek-v3.2",
          usage: { prompt_tokens: 210, completion_tokens: 35, total_tokens: 245 },
          msg: {
            role: "assistant",
            content: `Job ${delegatedId} updated app.js to export x = 2. Ready for your review.`,
          },
        };
      };

      const res = await runFreeOrchestrator({
        repo,
        jobs,
        chatId: "chat-test-1",
        agent: "free",
        model: "auto",
        guide: "System guide",
        prompt: "Update x to 2 in app.js",
        permissionMode: "ask",
        emit: (e) => events.push(e),
        chatFn: stubChatFn,
      });

      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);
      assert.match(res.text, /Ready for your review/);
      assert.equal(res.usage.prompt_tokens, 630);
      assert.equal(res.usage.completion_tokens, 110);
      assert.ok(events.some((e) => e.type === "free.init"));
      assert.ok(events.some((e) => e.type === "free.think"));
      assert.ok(events.some((e) => e.type === "free.tool" && e.name === "delegate"));
      assert.ok(events.some((e) => e.type === "free.tool" && e.name === "job_wait"));
      assert.ok(events.some((e) => e.type === "free.tool" && e.name === "job_diff"));
      assert.ok(events.some((e) => e.type === "free.message"));
      assert.ok(events.some((e) => e.type === "free.usage"));

      // Test Chats.send with agent="free" and verify compact running history across turns + chatEvents normalization
      const promptsSeen = [];
      let turnCall = 0;
      const chats = new Chats(jobs, {
        chatFn: async ({ messages }) => {
          turnCall++;
          const userMsg = messages.find((m) => m.role === "user")?.content || "";
          promptsSeen.push(userMsg);
          return {
            provider: "NVIDIA",
            model: "deepseek-ai/deepseek-v3.2",
            usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
            msg: {
              role: "assistant",
              content: turnCall === 1 ? "First turn summary from free orchestrator." : "Second turn summary using history.",
            },
          };
        },
      });

      const c1 = chats.send({ message: "First user question", model: "free", force: "free" });
      for (let i = 0; i < 40 && chats.get(c1.id).status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const after1 = chats.get(c1.id);
      assert.equal(after1.status, "idle");
      assert.equal(after1.turns[0].agent, "free");
      assert.equal(after1.turns[0].reply, "First turn summary from free orchestrator.");
      assert.equal(after1.turns[0].modelUsed, "stub-free-model"); // the model actually used is recorded on the turn
      assert.equal(after1.turns[0].provider, "nvidia");

      // Second turn on the same chat should include compact running history
      chats.send({ id: c1.id, message: "Follow-up question", model: "free", force: "free" });
      for (let i = 0; i < 40 && chats.get(c1.id).status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const after2 = chats.get(c1.id);
      assert.equal(after2.status, "idle");
      assert.equal(after2.turns[1].reply, "Second turn summary using history.");
      assert.equal(promptsSeen.length, 2);
      assert.match(promptsSeen[1], /Earlier in this chat \(handled by Free API\):/);
      assert.match(promptsSeen[1], /User: First user question/);
      assert.match(promptsSeen[1], /Assistant \(Free API\): First turn summary from free orchestrator\./);
      assert.match(promptsSeen[1], /New message:\nFollow-up question/);

      const rawLines = chats.log(c1.id, 0).entries;
      const parsedItems = rawLines.flatMap((entry) => normalize("free", entry, repo));
      assert.ok(parsedItems.some((it) => it.kind === "say" && it.text.includes("Second turn summary")));
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY;
      else process.env.TOKENWISE_AGY = prevAgy;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("local orchestrator runner works in-process with agent='local'", async () => {
  await withTempHome(async () => {
    const repo = initGitRepo();
    try {
      const jobs = new Jobs(repo);
      const events = [];
      const res = await runFreeOrchestrator({
        repo,
        jobs,
        chatId: "chat-local-1",
        agent: "local",
        model: "local",
        guide: "Guide",
        prompt: "List top-level files",
        permissionMode: "ask",
        emit: (e) => events.push(e),
        chatFn: async ({ tools }) => {
          assert.ok(tools.some((t) => t.function.name === "list_dir"));
          return {
            provider: "ollama",
            model: "qwen2.5-coder:7b",
            usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
            msg: { role: "assistant", content: "Local orchestrator reply." },
          };
        },
      });
      assert.equal(res.ok, true);
      assert.equal(res.exitCode, 0);
      assert.equal(res.text, "Local orchestrator reply.");
      assert.equal(events[0].type, "free.init");
      assert.equal(events[0].provider, "ollama");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("permission modes (ask, auto-apply, plan-only) and turnBudget are enforced in orchestrator tools", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    installFakeWorkerBin(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    clearDoctorCache();

    try {
      const jobs = new Jobs(repo);

      // 1. plan-only blocks write=true delegation and job_merge
      saveSettings({ permissionMode: "plan-only", turnBudget: 0 });
      const toolsPlan = createOrchestratorTools({ jobs, parent: "chat-perm", permissionMode: "plan-only" });
      const delWritePlan = await toolsPlan.callTool("delegate", {
        agent: "codex",
        model: "sol",
        write: true,
        task: "Try editing app.js in plan-only mode",
      });
      assert.equal(delWritePlan.isError, true);
      assert.match(delWritePlan.text, /write jobs are disabled in plan-only mode/);

      const mergePlan = await toolsPlan.callTool("job_merge", { id: "nonexistent" });
      assert.equal(mergePlan.isError, true);
      assert.match(mergePlan.text, /applying changes is disabled in plan-only mode/);

      // 2. ask mode allows write=true delegation and job_diff, but blocks job_merge
      saveSettings({ permissionMode: "ask", turnBudget: 0 });
      const toolsAsk = createOrchestratorTools({ jobs, parent: "chat-perm", permissionMode: "ask" });
      const delAsk = await toolsAsk.callTool("delegate", {
        agent: "codex",
        model: "sol",
        write: true,
        task: "Edit app.js in ask mode",
      });
      assert.equal(delAsk.isError, false);
      const jobId = JSON.parse(delAsk.text).id;
      const waitAsk = await toolsAsk.callTool("job_wait", { id: jobId, timeout_s: 30 });
      assert.equal(JSON.parse(waitAsk.text).status, "done");

      const mergeAsk = await toolsAsk.callTool("job_merge", { id: jobId });
      assert.equal(mergeAsk.isError, true);
      assert.match(mergeAsk.text, /applying changes is disabled in ask permission mode/);

      // 3. auto-apply mode allows job_merge to stage changes into the working tree
      saveSettings({ permissionMode: "auto-apply", turnBudget: 0 });
      const toolsAuto = createOrchestratorTools({ jobs, parent: "chat-perm", permissionMode: "auto-apply" });
      const mergeAuto = await toolsAuto.callTool("job_merge", { id: jobId });
      assert.equal(mergeAuto.isError, false);
      assert.equal(fs.readFileSync(path.join(repo, "app.js"), "utf8"), "export const x = 2;\n");

      // 4. turnBudget gate blocks new delegations at 100%
      saveSettings({ permissionMode: "ask", turnBudget: 10000 });
      const chatsDir = path.join(jobs.home, "chats");
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(
        path.join(chatsDir, "chat-budget.budget"),
        JSON.stringify({ started: new Date(Date.now() - 1000).toISOString(), orch: 10500 }),
      );
      const toolsBudget = createOrchestratorTools({ jobs, parent: "chat-budget", permissionMode: "ask" });
      const delOverBudget = await toolsBudget.callTool("delegate", {
        agent: "codex",
        model: "sol",
        write: false,
        task: "Should be blocked by turn budget",
      });
      assert.equal(delOverBudget.isError, true);
      assert.match(delOverBudget.text, /turn token budget is spent/);
    } finally {
      process.env.PATH = prevPath;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("orchestrator fallback chain order (claude -> codex -> gemini -> free -> local), custom order, and skips", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;
    const { agyPath } = installFakeWorkerBin(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    process.env.TOKENWISE_AGY = agyPath;
    process.env.NVIDIA_API_KEY = "nvapi-test-key";
    clearDoctorCache();

    try {
      const jobs = new Jobs(repo);
      assert.deepEqual(DEFAULTS.orchFallbackOrder, ["claude", "codex", "gemini", "free", "local"]);
      assert.equal(DEFAULTS.allowGeminiOrchestrator, true);
      assert.equal(DEFAULTS.freeMode, false);

      saveSettings({
        allowFree: true,
        allowGeminiOrchestrator: true,
        orchFallback: "auto",
        orchFallbackOrder: ["claude", "codex", "gemini", "free", "local"],
      });

      // 1. All healthy -> picks claude
      const p1 = pickOrchestrator(jobs.home, "opus", "high");
      assert.equal(p1.agent, "claude");
      assert.equal(p1.from, undefined);

      // 2. Claude cooling down -> falls back to codex
      recordCooldown("claude", { text: "try again in 30m" });
      const p2 = pickOrchestrator(jobs.home, "opus", "high");
      assert.equal(p2.agent, "codex");
      assert.equal(p2.from, "claude");
      assert.equal(p2.isLimit, true);

      // 3. Claude + Codex cooling down -> falls back to gemini (when allowGeminiOrchestrator is true)
      recordCooldown("codex", { text: "try again in 30m" });
      const p3 = pickOrchestrator(jobs.home, "opus", "high");
      assert.equal(p3.agent, "gemini");
      assert.equal(p3.model, "argon");
      assert.equal(p3.from, "claude");
      const p3Sonnet = pickOrchestrator(jobs.home, "sonnet", "medium");
      assert.equal(p3Sonnet.agent, "gemini");
      assert.equal(p3Sonnet.model, "hydrogen");

      // 4. When allowGeminiOrchestrator is false -> skips gemini and falls back to free
      saveSettings({ allowGeminiOrchestrator: false });
      const p4 = pickOrchestrator(jobs.home, "opus", "high");
      assert.equal(p4.agent, "free");
      assert.equal(p4.model, "auto");
      assert.equal(p4.from, "claude");

      // 5. Reordered fallback chain: ["claude", "free", "gemini", "codex", "local"] with allowGeminiOrchestrator=true
      saveSettings({
        allowGeminiOrchestrator: true,
        orchFallbackOrder: ["claude", "free", "gemini", "codex", "local"],
      });
      const nextFromClaude = nextOrchestrator("claude", jobs.home, { settings: loadSettings() });
      assert.equal(nextFromClaude.agent, "free");

      // 6. orchFallback = "ask" surfaces fallback target + from + reason in /api/orchestrator for askLimitChoice
      saveSettings({ orchFallback: "ask" });
      initServer({ repo });
      const rOrchAsk = await callHandler("GET", "/api/orchestrator?model=opus&effort=high");
      assert.equal(rOrchAsk.status, 200);
      assert.equal(rOrchAsk.body.agent, "free");
      assert.equal(rOrchAsk.body.from, "claude");
      assert.equal(rOrchAsk.body.isLimit, true);
      assert.match(rOrchAsk.body.reason, /Claude cooling down/);

      // 7. orchFallback = "off" keeps claude with no fallback
      saveSettings({ orchFallback: "off" });
      const pOff = pickOrchestrator(jobs.home, "opus", "high");
      assert.equal(pOff.agent, "claude");
      assert.equal(pOff.from, undefined);
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY;
      else process.env.TOKENWISE_AGY = prevAgy;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("Free mode forces orchestrator and workers to free/local and refuses delegations to paid agents", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;
    const { agyPath } = installFakeWorkerBin(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    process.env.TOKENWISE_AGY = agyPath;
    process.env.NVIDIA_API_KEY = "nvapi-test-key";
    clearDoctorCache();

    try {
      const jobs = new Jobs(repo);
      saveSettings({ freeMode: true, allowFree: false, defaultModel: "opus" });

      // 1. pickOrchestrator forces free even when orchModel is opus and allowFree was false
      const pick = pickOrchestrator(jobs.home, { model: "opus", effort: "high" });
      assert.equal(pick.agent, "free");
      assert.equal(pick.freeMode, true);

      // 2. available() marks codex, claude, gemini unavailable in Free mode and enables free
      assert.equal(available("claude", { write: false }, jobs.home), false);
      assert.equal(available("codex", { write: false }, jobs.home), false);
      assert.equal(available("gemini", { write: false }, jobs.home), false);
      assert.equal(available("free", { write: false }, jobs.home), true);

      // 3. prepareDelegateArgs refuses paid agents with a clear message to the orchestrator
      for (const paid of ["codex", "claude", "gemini"]) {
        assert.throws(
          () => prepareDelegateArgs({ agent: paid, task: "Write some code in app.js" }),
          /Free mode is on \(no plan usage\): paid worker/,
        );
      }
      const freeArgs = prepareDelegateArgs({ agent: "free", model: "auto", task: "Write some code" });
      assert.equal(freeArgs.agent, "free");

      // 4. In-process orchestrator delegate tool returns a clear error when paid agent is requested
      const orchTools = createOrchestratorTools({ jobs, parent: "chat-free-mode", permissionMode: "ask" });
      for (const paid of ["codex", "claude", "gemini"]) {
        const res = await orchTools.callTool("delegate", {
          agent: paid,
          task: "Attempt paid delegation while Free mode is on",
        });
        assert.equal(res.isError, true);
        assert.match(res.text, /Free mode is on \(no plan usage\)/);
      }

      // 5. Jobs.start also refuses paid agents directly in Free mode
      assert.throws(
        () => jobs.start({ agent: "codex", task: "Attempt paid job start in Free mode" }),
        /Free mode is on \(no plan usage\)/,
      );

      // 6. Chats.send refuses force: "claude" / "codex" / "gemini" in Free mode
      const chats = new Chats(jobs);
      assert.throws(
        () => chats.send({ message: "hello", force: "claude" }),
        /Free mode is on/,
      );

      // 7. buildGuide and teamGuide include FREE MODE instructions and force roles to free
      const guide = buildGuide("ask", { freeMode: true });
      assert.match(guide, /FREE MODE IS ON \(no plan usage\)/);
      const tGuide = teamGuide({ mode: "manual", roles: { code: { agent: "codex", model: "sol" } } });
      assert.match(tGuide, /Free mode is ON/);
      const tOpts = teamOptions([], { home: jobs.home, orchestratorAgent: "free" });
      assert.equal(tOpts.freeMode, true);
      assert.equal(tOpts.agents.codex.ready, false);
      assert.equal(tOpts.agents.claude.ready, false);
      assert.equal(tOpts.agents.gemini.ready, false);
      assert.equal(tOpts.agents.free.ready, true);
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY;
      else process.env.TOKENWISE_AGY = prevAgy;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("agy mcp add/remove argument building, syncGeminiMcp state, setup/uninstall flags, geminiCommand, and resolveChatId", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;
    const { agyPath } = installFakeWorkerBin(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    process.env.TOKENWISE_AGY = agyPath;
    clearDoctorCache();

    try {
      // 1. Argument builders
      assert.deepEqual(
        agyMcpAddArgs("/usr/local/bin/node", "/opt/tw/src/mcp.js", "tokenwise-studio"),
        ["mcp", "add", "tokenwise-studio", "/usr/local/bin/node", "/opt/tw/src/mcp.js"],
      );
      assert.deepEqual(
        agyMcpRemoveArgs("tokenwise-studio"),
        ["mcp", "remove", "tokenwise-studio"],
      );

      // 2. syncGeminiMcp runs add once and remembers it, then runs remove when disabled
      const calls = [];
      const runner = (bin, args) => {
        calls.push({ bin, args });
      };

      const on1 = syncGeminiMcp(true, { agyBin: agyPath, runner, homeDir: home });
      assert.equal(on1.ok, true);
      assert.equal(on1.action, "add");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ["mcp", "add", AGY_MCP_NAME, process.execPath, MCP_SERVER_PATH]);
      assert.equal(readAgyMcpState(home)?.enabled, true);

      // Calling syncGeminiMcp(true) again without force is a no-op
      const on2 = syncGeminiMcp(true, { agyBin: agyPath, runner, homeDir: home });
      assert.equal(on2.action, "noop");
      assert.equal(calls.length, 1);

      // Turning off runs `agy mcp remove tokenwise-studio`
      const off1 = syncGeminiMcp(false, { agyBin: agyPath, runner, homeDir: home });
      assert.equal(off1.ok, true);
      assert.equal(off1.action, "remove");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].args, ["mcp", "remove", AGY_MCP_NAME]);
      assert.equal(readAgyMcpState(home)?.enabled, false);

      // 3. setup --dry-run, setup, setup --no-gemini, and uninstall
      const logsDry = [];
      const dryCalls = [];
      await doSetup({
        args: ["--dry-run", "--no-app"],
        claudeInstalled: false,
        agyBin: agyPath,
        runner: (bin, args) => dryCalls.push({ bin, args }),
        log: (m) => logsDry.push(m),
        homeDir: home,
        skipDoctor: true,
      });
      assert.ok(logsDry.some((l) => l.includes("add tokenwise to Antigravity's MCP servers (Gemini can orchestrate)")));
      assert.ok(logsDry.some((l) => l.includes("mcp add tokenwise-studio")));
      assert.equal(dryCalls.length, 0);

      const logsNoGemini = [];
      const noGeminiCalls = [];
      await doSetup({
        args: ["--no-gemini", "--no-app"],
        claudeInstalled: false,
        agyBin: agyPath,
        runner: (bin, args) => noGeminiCalls.push({ bin, args }),
        log: (m) => logsNoGemini.push(m),
        homeDir: home,
        skipDoctor: true,
      });
      assert.equal(noGeminiCalls.length, 0);

      const setupCalls = [];
      await doSetup({
        args: ["--no-app"],
        claudeInstalled: false,
        agyBin: agyPath,
        runner: (bin, args) => setupCalls.push({ bin, args }),
        log: () => {},
        homeDir: home,
        skipDoctor: true,
      });
      assert.equal(setupCalls.length, 1);
      assert.deepEqual(setupCalls[0].args.slice(0, 3), ["mcp", "add", "tokenwise-studio"]);

      const uninstallCalls = [];
      const protectedApp = path.join(home, "Applications", "tokenwise studio.app");
      fs.mkdirSync(path.join(protectedApp, "Contents"), { recursive: true });
      fs.writeFileSync(path.join(protectedApp, "Contents", "Info.plist"), "<string>com.nolienlabs.tokenwise-studio</string>");
      doUninstall({
        args: ["--no-app"],
        claudeInstalled: false,
        agyBin: agyPath,
        runner: (bin, args) => uninstallCalls.push({ bin, args }),
        log: () => {},
        homeDir: home,
      });
      assert.equal(uninstallCalls.length, 1);
      assert.ok(fs.existsSync(protectedApp), "--no-app must preserve the installed app");
      assert.deepEqual(uninstallCalls[0].args, ["mcp", "remove", "tokenwise-studio"]);

      // 4. geminiCommand builds headless plan-mode stream-json command and embeds chat_id in prompt
      const gCmd = geminiCommand({ repo, chatId: "chat_abc_123", prompt: "Hello Gemini", guide: "Guide text", model: "hydrogen", effort: "medium" });
      assert.equal(gCmd.cmd, agyPath);
      assert.ok(gCmd.args.includes("-p"));
      assert.match(gCmd.args[gCmd.args.indexOf("-p") + 1], /chat_id: "chat_abc_123"/);
      assert.ok(gCmd.args.includes("--mode"));
      assert.equal(gCmd.args[gCmd.args.indexOf("--mode") + 1], "plan");
      assert.ok(gCmd.args.includes("--output-format"));
      assert.equal(gCmd.args[gCmd.args.indexOf("--output-format") + 1], "stream-json");
      assert.ok(gCmd.args.includes("--dangerously-skip-permissions"));
      assert.equal(gCmd.env.TOKENWISE_PARENT, "chat_abc_123");

      // 5. buildPrompt for gemini/free includes compact running history of prior turns
      const gPrompt = buildPrompt(
        { id: "chat_abc_123", turns: [{ agent: "gemini", user: "Earlier msg", reply: "Earlier answer" }] },
        1,
        "gemini",
        "New msg",
      );
      assert.match(gPrompt, /Earlier in this chat \(handled by Gemini\):/);
      assert.match(gPrompt, /User: Earlier msg/);
      assert.match(gPrompt, /Assistant \(Gemini\): Earlier answer/);

      // 6. resolveChatId validates format, env match, and chat file existence
      const projHome = path.join(repo, ".tokenwise-studio");
      fs.mkdirSync(path.join(projHome, "chats"), { recursive: true });
      fs.writeFileSync(path.join(projHome, "chats", "valid-chat-1.json"), "{}");

      assert.equal(resolveChatId(undefined, "env-chat-1", projHome), "env-chat-1");
      assert.equal(resolveChatId("env-chat-1", "env-chat-1", projHome), "env-chat-1");
      assert.throws(() => resolveChatId("other-chat", "env-chat-1", projHome), /does not match active chat/);
      assert.throws(() => resolveChatId("../bad", null, projHome), /invalid chat_id format/);
      assert.throws(() => resolveChatId("nonexistent-chat", null, projHome), /unknown chat_id/);
      assert.equal(resolveChatId("valid-chat-1", null, projHome), "valid-chat-1");

      // 7. UI /api/settings toggles allowGeminiOrchestrator and freeMode
      initServer({ repo });
      const rGet = await callHandler("GET", "/api/settings");
      assert.equal(rGet.status, 200);
      assert.equal(rGet.body.agyInstalled, true);
      assert.deepEqual(rGet.body.settings.orchFallbackOrder, ["claude", "codex", "gemini", "free", "local"]);

      const rPost = await callHandler("POST", "/api/settings", {
        freeMode: true,
        orchFallbackOrder: ["codex", "claude", "gemini", "free", "local"],
      });
      assert.equal(rPost.status, 200);
      assert.equal(rPost.body.settings.freeMode, true);
      assert.deepEqual(rPost.body.settings.orchFallbackOrder, ["codex", "claude", "gemini", "free", "local"]);

      assert.equal(modelToOrchAgent("hydrogen"), "gemini");
      assert.equal(modelToOrchAgent("argon"), "gemini");
      assert.equal(modelToOrchAgent("free"), "free");
      assert.equal(modelToOrchAgent("local"), "local");
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY;
      else process.env.TOKENWISE_AGY = prevAgy;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
