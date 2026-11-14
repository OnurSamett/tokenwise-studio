import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { DEFAULTS, loadSettings, saveSettings } from "../src/settings.js";
import {
  COMPACT_MIN_TURNS,
  COMPACT_NOTICE,
  SUMMARY_MAX_CHARS,
  buildSummaryPrompt,
  compactChat,
  contextTokens,
  deterministicSummary,
  shouldCompact,
} from "../src/compact.js";
import { clearDoctorCache } from "../src/doctor.js";
import { Jobs } from "../src/jobs.js";
import { Chats, buildPrompt } from "../src/orchestrator.js";
import { normalize } from "../src/events.js";
import { handler, initServer } from "../src/ui.js";
import { translateNotice } from "../ui/i18n.js";

const tmp = (prefix = "tw-compact-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const home = tmp("tw-home-");
  process.env.HOME = home;
  const cleanup = () => {
    process.env.HOME = prevHome;
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

function fakeSpawn(eventsByCall = []) {
  const calls = [];
  const fn = (cmd, args) => {
    const idx = calls.length;
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("close", 1);
    const lines = eventsByCall[idx] || [
      { type: "system", subtype: "init", session_id: "sess-fresh-1", model: "opus" },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Continued cleanly." }], usage: { input_tokens: 500, output_tokens: 50 } } },
      { type: "result", subtype: "success", session_id: "sess-fresh-1", result: "Continued cleanly.", total_cost_usd: 0.01, usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } },
    ];
    child.stdout.on("end", () => setTimeout(() => child.emit("close", 0), 10));
    setTimeout(() => {
      for (const e of lines) child.stdout.write(JSON.stringify(e) + "\n");
      child.stdout.end();
      child.stderr.end();
    }, 10);
    return child;
  };
  return { spawn: fn, calls };
}

async function callHandler(method, urlPath, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
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

test("settings.js defaults and validates compactChats and compactThreshold", () => {
  assert.equal(DEFAULTS.compactChats, true);
  assert.equal(DEFAULTS.compactThreshold, 120_000);

  withTempHome(() => {
    const s0 = loadSettings();
    assert.equal(s0.compactChats, true);
    assert.equal(s0.compactThreshold, 120_000);

    const s1 = saveSettings({ compactChats: false, compactThreshold: 240_000 });
    assert.equal(s1.compactChats, false);
    assert.equal(s1.compactThreshold, 240_000);
    assert.equal(loadSettings().compactThreshold, 240_000);

    saveSettings({ compactThreshold: 60_000 });
    saveSettings({ compactThreshold: 400_000 });

    assert.throws(() => saveSettings({ compactChats: "yes" }), /compactChats must be true or false/);
    assert.throws(() => saveSettings({ compactThreshold: 59_999 }), /60000 and 400000/);
    assert.throws(() => saveSettings({ compactThreshold: 400_001 }), /60000 and 400000/);
    assert.throws(() => saveSettings({ compactThreshold: 120_000.5 }), /60000 and 400000/);
  });
});

test("contextTokens and shouldCompact threshold decision", () => {
  assert.equal(COMPACT_MIN_TURNS, 3);
  assert.equal(contextTokens(null), 0);
  // Only per-call context triggers; legacy Claude turns without context and Codex turns return 0.
  assert.equal(contextTokens({ agent: "claude", tokens: { input: 2000, cached: 125_000, output: 500, context: 127_000 } }), 127_000);
  assert.equal(contextTokens({ agent: "claude", tokens: { input: 2000, cached: 500_000, output: 500 } }), 0);
  assert.equal(contextTokens({ agent: "codex", tokens: { input: 250_000, cached: 200_000, output: 1000 } }), 0);

  // Fresh session (no sessionId and no codexThread) never compacts, even with high context.
  const freshChat = {
    sessionId: null,
    codexThread: null,
    turns: [
      { agent: "claude", user: "hi", reply: "hello", tokens: { input: 1000, cached: 199_000, output: 500, context: 200_000 } },
    ],
  };
  assert.equal(shouldCompact(freshChat, { compactChats: true, compactThreshold: 60_000 }), false);

  const chat = {
    sessionId: "sess-1",
    turns: [
      { agent: "claude", user: "hi", reply: "hello", tokens: { input: 1000, cached: 119_000, output: 0, context: 120_000 } },
    ],
  };
  // Exactly at threshold (120k) does not compact; strictly greater triggers.
  assert.equal(shouldCompact(chat, { compactChats: true, compactThreshold: 120_000 }), false);
  assert.equal(shouldCompact(chat, { compactChats: true, compactThreshold: 119_999 }), true);
  assert.equal(shouldCompact(chat, { compactChats: false, compactThreshold: 60_000 }), false);
  assert.equal(shouldCompact({ sessionId: "sess-1", turns: [] }, { compactChats: true, compactThreshold: 60_000 }), false);

  // Codex cumulative never triggers compaction.
  const codexChat = {
    codexThread: "thr-1",
    turns: [
      { agent: "codex", user: "hi", reply: "ok", tokens: { input: 250_000, cached: 200_000, output: 2000 } },
    ],
  };
  assert.equal(shouldCompact(codexChat, { compactChats: true, compactThreshold: 60_000 }), false);

  // Already compacted up through current turns: do not compact again before next turn completes.
  const already = {
    sessionId: "sess-2",
    turns: [{ agent: "claude", user: "hi", reply: "ok", tokens: { input: 150_000, cached: 0, output: 500, context: 150_000 } }],
    compaction: { summary: "s", throughTurn: 1 },
  };
  assert.equal(shouldCompact(already, { compactChats: true, compactThreshold: 120_000 }), false);

  // New turn after compaction without usage (e.g. aborted/failed) must not re-trigger pre-compaction turn.
  const failedAfter = {
    sessionId: "sess-2",
    turns: [
      { agent: "claude", user: "t1", reply: "ok", tokens: { input: 150_000, cached: 0, output: 500, context: 150_000 } },
      { agent: "claude", user: "t2", reply: null, tokens: null },
    ],
    compaction: { summary: "s", throughTurn: 1 },
  };
  assert.equal(shouldCompact(failedAfter, { compactChats: true, compactThreshold: 120_000 }), false);

  // Big real context after compaction does NOT trigger within 3 turns of last compaction.
  const oneAfter = {
    sessionId: "sess-2",
    turns: [
      { agent: "claude", user: "t1", reply: "ok", tokens: { context: 150_000 } },
      { agent: "claude", user: "t2", reply: "done", tokens: { context: 130_000 } },
    ],
    compaction: { summary: "s", throughTurn: 1 },
  };
  assert.equal(shouldCompact(oneAfter, { compactChats: true, compactThreshold: 120_000 }), false);

  const twoAfter = {
    ...oneAfter,
    turns: [...oneAfter.turns, { agent: "claude", user: "t3", reply: "done", tokens: { context: 140_000 } }],
  };
  assert.equal(shouldCompact(twoAfter, { compactChats: true, compactThreshold: 120_000 }), false);

  // At 3 new turns since last compaction, big real context triggers again.
  const threeAfter = {
    ...twoAfter,
    turns: [...twoAfter.turns, { agent: "claude", user: "t4", reply: "done", tokens: { context: 145_000 } }],
  };
  assert.equal(shouldCompact(threeAfter, { compactChats: true, compactThreshold: 120_000 }), true);
});

test("compactChat uses stubbed Haiku runner and enforces output cap", async () => {
  const chat = {
    title: "Add JWT auth",
    turns: [
      { agent: "claude", user: "Implement JWT middleware", reply: "Delegated middleware to Codex Sol and applied auth.js." },
    ],
  };
  const jobs = [
    { id: "j1", parent: "c1", title: "Write auth middleware", agent: "codex", model: "sol", write: true, status: "merged", files: ["src/auth.js"], applied: ["src/auth.js"], final: "Added verifyToken" },
  ];

  let seenPrompt = "";
  const r1 = await compactChat({
    chat,
    jobs,
    runner: async ({ prompt }) => {
      seenPrompt = prompt;
      return "## Goal\n- Add JWT auth\n## Decisions\n- Used HS256\n## Files touched\n- src/auth.js\n## Jobs and status\n- j1 merged\n## Open questions\n- Add refresh tokens?";
    },
  });
  assert.equal(r1.method, "haiku");
  assert.ok(seenPrompt.includes("Add JWT auth"));
  assert.ok(seenPrompt.includes("Write auth middleware"));
  assert.ok(seenPrompt.includes("src/auth.js"));
  assert.ok(r1.summary.includes("Add JWT auth"));

  // Output cap check
  const huge = "line\n".repeat(2000);
  const r2 = await compactChat({ chat, jobs, runner: async () => huge });
  assert.equal(r2.method, "haiku");
  assert.ok(r2.summary.length <= SUMMARY_MAX_CHARS);
  assert.ok(r2.summary.endsWith("…"));
});

test("compactChat falls back deterministically when Haiku is unavailable or returns empty", async () => {
  const chat = {
    title: "Refactor parser",
    turns: [
      { agent: "claude", user: "Split tokenizer out of parser.js", reply: "Created tokenizer.js via Codex and verified tests." },
      { agent: "codex", user: "Fix edge case for quotes", reply: "Updated escape handling in tokenizer.js." },
    ],
  };
  const jobs = [
    { id: "j1", title: "Extract tokenizer", agent: "codex", model: "sol", write: true, status: "merged", files: ["src/tokenizer.js"], applied: ["src/tokenizer.js"], final: "Extracted module" },
    { id: "j2", title: "Quote fix", agent: "codex", model: "terra", write: true, status: "done", files: ["src/tokenizer.js", "test/tokenizer.test.js"], final: "Ready for review" },
    { id: "j3", title: "Lint check", agent: "claude", model: "haiku", write: false, status: "failed", files: [], final: "Missing script" },
  ];

  for (const runner of [
    async () => { throw new Error("claude unavailable"); },
    async () => "   ",
  ]) {
    const res = await compactChat({ chat, jobs, runner });
    assert.equal(res.method, "deterministic");
    assert.ok(res.summary.includes("## Goal"));
    assert.ok(res.summary.includes("## Decisions"));
    assert.ok(res.summary.includes("## Files touched"));
    assert.ok(res.summary.includes("## Jobs and status"));
    assert.ok(res.summary.includes("## Open questions"));
    assert.ok(res.summary.includes("Refactor parser"));
    assert.ok(res.summary.includes("src/tokenizer.js"));
    assert.ok(res.summary.includes("test/tokenizer.test.js"));
    assert.ok(res.summary.includes("1 write job(s) ready for review/apply."));
    assert.ok(res.summary.includes("1 failed job(s)"));
  }

  // Direct deterministicSummary check with buildSummaryPrompt
  const det = deterministicSummary(chat, jobs);
  assert.ok(det.length <= SUMMARY_MAX_CHARS);
  assert.ok(buildSummaryPrompt(chat, jobs).includes("Extract tokenizer"));
});

test("buildPrompt injects compacted summary on fresh session and skips it once session resumes", () => {
  const chat = {
    sessionId: null,
    codexThread: null,
    compaction: { summary: "## Goal\n- Build feature X", throughTurn: 2 },
    turns: [
      { agent: "claude", user: "old 1", reply: "old reply 1" },
      { agent: "claude", user: "old 2", reply: "old reply 2" },
    ],
  };

  // Turn 2: fresh session right after compaction -> summary + new message, no raw old turns.
  const p2 = buildPrompt(chat, 2, "claude", "continue with tests");
  assert.ok(p2.includes("## Goal\n- Build feature X"));
  assert.ok(p2.includes("continue with tests"));
  assert.ok(!p2.includes("old reply 1"));

  // Turn 3: Claude now has a resumed session -> just the new message.
  chat.sessionId = "sess-new";
  chat.turns.push({ agent: "claude", user: "continue with tests", reply: "Added tests." });
  assert.equal(buildPrompt(chat, 3, "claude", "now run lint"), "now run lint");

  // Turn 3 on Codex (no codexThread yet) -> includes compacted summary + turn 2 since summary.
  const pCodex = buildPrompt(chat, 3, "codex", "now run lint");
  assert.ok(pCodex.includes("## Goal\n- Build feature X"));
  assert.ok(pCodex.includes("Added tests."));
  assert.ok(!pCodex.includes("old reply 1"));
  assert.ok(pCodex.includes("now run lint"));
});

test("Chats.send auto-compacts when threshold exceeded, drops old session, and logs notice", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-repo-");
    try {
      saveSettings({ compactChats: true, compactThreshold: 120_000 });
      const jobs = new Jobs(repo);
      const { spawn, calls } = fakeSpawn();
      let haikuCalls = 0;
      const chats = new Chats(jobs, {
        summarize: async () => {
          haikuCalls++;
          return "## Goal\n- Fix login\n## Decisions\n- Keep session token\n## Files touched\n- None\n## Jobs and status\n- None\n## Open questions\n- None";
        },
        spawn,
      });

      const cid = "20261114000000-auto";
      chats.save({
        id: cid,
        title: "Fix login",
        created: new Date().toISOString(),
        sessionId: "sess-old-bloated",
        codexThread: "thread-old-bloated",
        status: "idle",
        cost: 0.4,
        turns: [
          {
            user: "Investigate login bug",
            reply: "Found issue in auth.js",
            agent: "claude",
            model: "opus",
            effort: "medium",
            started: new Date().toISOString(),
            finished: new Date().toISOString(),
            cost: 0.4,
            tokens: { input: 2000, cached: 125_000, output: 500, context: 127_000 },
          },
        ],
      });

      chats.send({ id: cid, message: "Please fix it now", force: "claude" });
      for (let i = 0; i < 100 && chats.get(cid).status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 15));
      }
      // Wait briefly for fs.WriteStream flush on log.end().
      for (let i = 0; i < 20 && !chats.log(cid).entries.some((e) => e.stream === "meta"); i++) {
        await new Promise((r) => setTimeout(r, 15));
      }

      const updated = chats.get(cid);
      assert.equal(updated.status, "idle");
      assert.equal(haikuCalls, 1);
      assert.equal(updated.sessionId, "sess-fresh-1");
      assert.equal(updated.codexThread, null);
      assert.equal(updated.compaction.method, "haiku");
      assert.equal(updated.compaction.throughTurn, 1);

      // Verify spawned claude did NOT pass --resume and DID include the compacted summary in -p.
      assert.equal(calls.length, 1);
      const args = calls[0].args;
      assert.ok(!args.includes("--resume"), "should drop old sessionId and not pass --resume");
      const pIdx = args.indexOf("-p");
      assert.ok(pIdx >= 0);
      assert.ok(args[pIdx + 1].includes("Fix login"));
      assert.ok(args[pIdx + 1].includes("Please fix it now"));

      // Verify chat log recorded the visible notice with expandable summary.
      const { entries } = chats.log(cid);
      const items = entries.flatMap((e) => (e.stream === "user" ? [{ kind: "user", text: e.line }] : normalize(e.agent || "claude", e, repo)));
      const compactItem = items.find((i) => i.kind === "compact");
      assert.ok(compactItem);
      assert.equal(compactItem.text, COMPACT_NOTICE);
      assert.ok(compactItem.summary.includes("Keep session token"));
      assert.equal(translateNotice(compactItem.text, "tr"), "Token tasarrufu için önceki konuşma sıkıştırıldı");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("POST /api/compact/:id manually compacts chat and returns timeline notice", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-srv-repo-");
    try {
      initServer({
        repo,
        summarize: async () => { throw new Error("haiku offline"); },
      });
      const jobs = new Jobs(repo);
      const chats = new Chats(jobs);
      const cid = "20261114000000-man1";
      chats.save({
        id: cid,
        title: "Manual compact test",
        created: new Date().toISOString(),
        sessionId: "sess-manual-1",
        codexThread: null,
        status: "idle",
        cost: 0.05,
        turns: [
          {
            user: "Check config",
            reply: "Config looks valid.",
            agent: "claude",
            model: "sonnet",
            effort: "medium",
            started: new Date().toISOString(),
            finished: new Date().toISOString(),
            cost: 0.05,
            tokens: { input: 4000, cached: 1000, output: 200 },
          },
        ],
      });

      const sRes = await callHandler("POST", "/api/settings", { compactChats: false, compactThreshold: 180_000 });
      assert.equal(sRes.status, 200);
      assert.equal(sRes.body.settings.compactChats, false);
      assert.equal(sRes.body.settings.compactThreshold, 180_000);

      const res = await callHandler("POST", `/api/compact/${cid}`, {});
      assert.equal(res.status, 200);
      assert.equal(res.body.sessionId, null);
      assert.equal(res.body.compaction.method, "deterministic");
      assert.ok(res.body.compaction.summary.includes("Config looks valid."));

      // Second manual compact before any new turns is refused cleanly.
      const res2 = await callHandler("POST", `/api/compact/${cid}`, {});
      assert.equal(res2.status, 400);

      // Timeline contains the compact item.
      const logRes = await callHandler("GET", `/api/chatlog/${cid}`);
      assert.equal(logRes.status, 200);
      const compactItem = logRes.body.items.find((i) => i.kind === "compact");
      assert.ok(compactItem);
      assert.equal(compactItem.text, COMPACT_NOTICE);
      assert.equal(compactItem.method, "deterministic");
      assert.ok(compactItem.summary.includes("Manual compact test"));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

async function waitTurnDone(chats, cid) {
  for (let i = 0; i < 100 && chats.get(cid).status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  for (let i = 0; i < 20 && !chats.log(cid).entries.some((e) => e.stream === "meta"); i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("Claude tool-loop summed cache_read does not trigger compaction; last call context is used", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-repo-ctx-");
    try {
      saveSettings({ compactChats: true, compactThreshold: 120_000 });
      const jobs = new Jobs(repo);
      // Turn 1: 5 assistant calls each with ~50k context (summed result cache_read = 225k > 120k, but real context = 50k).
      // Turn 2: follows without triggering compaction.
      const { spawn } = fakeSpawn([
        [
          { type: "system", subtype: "init", session_id: "sess-loop-1" },
          { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Step 1" }], usage: { input_tokens: 1000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 4000, output_tokens: 50 } } },
          { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Step 2" }], usage: { input_tokens: 1200, cache_read_input_tokens: 44_000, cache_creation_input_tokens: 2000, output_tokens: 60 } } },
          { type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1500, cache_read_input_tokens: 46_000, cache_creation_input_tokens: 2500, output_tokens: 80 } } },
          { type: "result", subtype: "success", session_id: "sess-loop-1", result: "Done", total_cost_usd: 0.05, usage: { input_tokens: 3700, cache_creation_input_tokens: 8500, cache_read_input_tokens: 230_000, output_tokens: 190 } },
        ],
        [
          { type: "system", subtype: "init", session_id: "sess-loop-1" },
          { type: "assistant", message: { id: "m4", content: [{ type: "text", text: "Second reply" }], usage: { input_tokens: 1600, cache_read_input_tokens: 48_000, cache_creation_input_tokens: 1000, output_tokens: 40 } } },
          { type: "result", subtype: "success", session_id: "sess-loop-1", result: "Second reply", total_cost_usd: 0.02, usage: { input_tokens: 1600, cache_creation_input_tokens: 1000, cache_read_input_tokens: 48_000, output_tokens: 40 } },
        ],
      ]);
      let compactRuns = 0;
      const chats = new Chats(jobs, { summarize: async () => { compactRuns++; return "summary"; }, spawn });

      const c0 = chats.send({ message: "Inspect files", force: "claude" });
      await waitTurnDone(chats, c0.id);
      const after1 = chats.get(c0.id);
      assert.equal(after1.turns[0].tokens.context, 50_000);
      assert.equal(after1.turns[0].tokens.cached, 230_000);
      assert.equal(shouldCompact(after1, loadSettings()), false);

      chats.send({ id: c0.id, message: "Follow up", force: "claude" });
      await waitTurnDone(chats, c0.id);
      const after2 = chats.get(c0.id);
      assert.equal(compactRuns, 0);
      assert.equal(after2.compaction, undefined);
      assert.equal(after2.turns[1].tokens.context, 50_600);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("Codex orchestrator stores per-turn deltas, leaves context unset, and never triggers compaction", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-repo-codex-");
    const binDir = tmp("tw-bin-codex-");
    const prevPath = process.env.PATH;
    try {
      const fakeCodex = path.join(binDir, "codex");
      fs.writeFileSync(fakeCodex, [
        "#!/bin/sh",
        'if [ "$1" = "debug" ] && [ "$2" = "models" ]; then',
        '  echo \'{"models":[{"slug":"gpt-5.4-sol","visibility":"list","priority":1}]}\'',
        "else",
        "  echo 'Logged in'",
        "fi",
        "",
      ].join("\n"), { mode: 0o755 });
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
      clearDoctorCache();

      saveSettings({ compactChats: true, compactThreshold: 60_000 });
      const jobs = new Jobs(repo);
      const { spawn } = fakeSpawn([
        [
          { type: "thread.started", thread_id: "thr-codex-1" },
          { type: "item.completed", item: { type: "agent_message", text: "Turn 1 done" } },
          { type: "turn.completed", usage: { input_tokens: 90_000, cached_input_tokens: 70_000, output_tokens: 1000 } },
        ],
        [
          { type: "item.completed", item: { type: "agent_message", text: "Turn 2 done" } },
          { type: "turn.completed", usage: { input_tokens: 165_000, cached_input_tokens: 130_000, output_tokens: 1800 } },
        ],
        [
          { type: "item.completed", item: { type: "agent_message", text: "Turn 3 done" } },
          { type: "turn.completed", usage: { input_tokens: 210_000, cached_input_tokens: 170_000, output_tokens: 2300 } },
        ],
      ]);
      let compactRuns = 0;
      const chats = new Chats(jobs, { summarize: async () => { compactRuns++; return "summary"; }, spawn });

      const c0 = chats.send({ message: "First codex turn", force: "codex" });
      await waitTurnDone(chats, c0.id);
      const after1 = chats.get(c0.id);
      assert.equal(after1.codexThread, "thr-codex-1");
      assert.deepEqual(after1.turns[0].tokens, { input: 90_000, cached: 70_000, output: 1000 });
      assert.equal(after1.turns[0].tokens.context, undefined);
      assert.equal(shouldCompact(after1, loadSettings()), false);

      chats.send({ id: c0.id, message: "Second codex turn", force: "codex" });
      await waitTurnDone(chats, c0.id);
      const after2 = chats.get(c0.id);
      assert.deepEqual(after2.turns[1].tokens, { input: 75_000, cached: 60_000, output: 800 });
      assert.equal(after2.turns[1].tokens.context, undefined);
      assert.equal(shouldCompact(after2, loadSettings()), false);

      chats.send({ id: c0.id, message: "Third codex turn", force: "codex" });
      await waitTurnDone(chats, c0.id);
      const after3 = chats.get(c0.id);
      assert.deepEqual(after3.turns[2].tokens, { input: 45_000, cached: 40_000, output: 500 });
      assert.equal(compactRuns, 0);
      assert.equal(after3.compaction, undefined);
    } finally {
      process.env.PATH = prevPath;
      clearDoctorCache();
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
