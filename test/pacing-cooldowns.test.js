import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  COOLDOWN_DEFAULT_MS,
  parseResetTime,
  resolveCooldownUntil,
  recordCooldown,
  clearCooldown,
  getCooldown,
  inCooldown,
  activeCooldowns,
  formatHHMM,
} from "../src/cooldowns.js";
import { recordGeminiRun, geminiUsage } from "../src/gemini-usage.js";
import { DEFAULTS, loadSettings, saveSettings } from "../src/settings.js";
import { clearDoctorCache } from "../src/doctor.js";
import { limits } from "../src/limits.js";
import {
  RATE_LIMIT,
  available,
  nextAgent,
  claudePacing,
  preferredWorkers,
  recordProviderCooldown,
} from "../src/fallback.js";
import { teamOptions, teamGuide } from "../src/team.js";
import { Jobs } from "../src/jobs.js";
import { Chats, buildGuide, pickOrchestrator } from "../src/orchestrator.js";
import { handler, initServer } from "../src/ui.js";
import { t, translateReason } from "../ui/i18n.js";

const tmp = (prefix = "tw-pace-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const envKeys = ["HOME", "TOKENWISE_NOTIFY", "TOKENWISE_ALLOW_FREE", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "CUSTOM_FREE_API_KEY"];
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
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-m", "init");
  return repo;
}

function writeClaudeRateEvent(projHome, { fiveHourPct = null, fiveHourResetsSec = null, weekPct = null, weekResetsSec = null } = {}) {
  const chatsDir = path.join(projHome, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  const unifiedWindows = {};
  if (fiveHourPct != null) {
    unifiedWindows.five_hour = {
      utilization: fiveHourPct / 100,
      ...(fiveHourResetsSec != null ? { resetsAt: fiveHourResetsSec } : {}),
    };
  }
  if (weekPct != null) {
    unifiedWindows.seven_day = {
      utilization: weekPct / 100,
      ...(weekResetsSec != null ? { resetsAt: weekResetsSec } : {}),
    };
  }
  const inner = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows } });
  const outer = JSON.stringify({ t: Date.now(), stream: "out", line: inner });
  fs.writeFileSync(path.join(chatsDir, "test-chat.jsonl"), outer + "\n");
}

function installFakeClis(binDir, { claudeBehavior = "ok", codexBehavior = "ok", agyBehavior = "ok" } = {}) {
  fs.mkdirSync(binDir, { recursive: true });

  const claudeScript = [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "auth" && args[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }',
    claudeBehavior === "ratelimit"
      ? 'process.stderr.write("You have hit your limit, resets 5:20am (UTC)\\n"); process.exit(1);'
      : claudeBehavior === "ratelimit-plain"
        ? 'process.stderr.write("Rate limit reached 429\\n"); process.exit(1);'
        : 'process.stdout.write(JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }) + "\\n");',
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "claude"), claudeScript, { mode: 0o755 });

  const codexScript = [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "login" && args[1] === "status") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }',
    'if (args[0] === "debug" && args[1] === "models") { process.stdout.write(JSON.stringify({ models: [{ slug: "gpt-5-codex-sol", visibility: "list", priority: 1 }, { slug: "gpt-5-codex-terra", visibility: "list", priority: 2 }, { slug: "gpt-5-codex-luna", visibility: "list", priority: 3 }] })); process.exit(0); }',
    codexBehavior === "ratelimit"
      ? 'process.stderr.write("Usage limit exceeded, try again in 45m\\n"); process.exit(1);'
      : 'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 8 } }) + "\\n");',
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "codex"), codexScript, { mode: 0o755 });

  const agyScript = [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "models" || (args[0] === "agent" && args[1] === "models")) { process.stdout.write("gemini-2.5-hydrogen-medium\\ngemini-2.5-hydrogen-low\\ngemini-2.5-argon-high\\n"); process.exit(0); }',
    agyBehavior === "429"
      ? 'process.stderr.write("HTTP 429 RESOURCE_EXHAUSTED retry after 15m\\n"); process.exit(1);'
      : 'process.stdout.write(JSON.stringify({ type: "result", content: "ok", usage: { input_tokens: 300, output_tokens: 120 } }) + "\\n");',
  ].join("\n");
  const agyPath = path.join(binDir, "agy");
  fs.writeFileSync(agyPath, agyScript, { mode: 0o755 });

  const geminiScript = [
    `#!${process.execPath}`,
    agyBehavior === "429"
      ? 'process.stderr.write("HTTP 429 RESOURCE_EXHAUSTED retry after 15m\\n"); process.exit(1);'
      : 'process.stdout.write(JSON.stringify({ type: "result", content: "ok", usage: { input_tokens: 300, output_tokens: 120 } }) + "\\n");',
  ].join("\n");
  fs.writeFileSync(path.join(binDir, "gemini"), geminiScript, { mode: 0o755 });
  return { agyPath };
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

function fakeSpawn(lines, exitCode = 0) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      for (const l of lines) child.stdout.write(l + "\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode);
    });
    return child;
  };
}

test("parseResetTime and resolveCooldownUntil parse reset hints, limits fallback, and 30m default", () => {
  const now = Date.UTC(2026, 4, 10, 3, 10, 0); // 03:10:00 UTC

  // Error text: explicit UTC clock reset
  const utcReset = parseResetTime("You've hit your limit · resets 5:20am (UTC)", now);
  assert.equal(utcReset, Date.UTC(2026, 4, 10, 5, 20, 0));

  // Rolls forward to next day when clock time already passed today in UTC
  const nextDayUtc = parseResetTime("Limit reached, resets 2:15am (UTC)", now);
  assert.equal(nextDayUtc, Date.UTC(2026, 4, 11, 2, 15, 0));

  // Local clock format ("resets 5:20am" / "resets at 17:20")
  const localAm = parseResetTime("Usage limit exceeded, resets 5:20am", now);
  assert.ok(localAm && localAm > now);
  const dAm = new Date(localAm);
  assert.equal(dAm.getHours(), 5);
  assert.equal(dAm.getMinutes(), 20);

  const local24 = parseResetTime("Rate limit reached · resets at 17:20", now);
  assert.ok(local24 && local24 > now);
  const d24 = new Date(local24);
  assert.equal(d24.getHours(), 17);
  assert.equal(d24.getMinutes(), 20);

  // Relative durations
  assert.equal(parseResetTime("Please try again in 1h 30m", now), now + 90 * 60_000);
  assert.equal(parseResetTime("Quota resets in 15m", now), now + 15 * 60_000);

  // JSON resets_at epoch seconds
  const epochSec = Math.floor((now + 42 * 60_000) / 1000);
  assert.equal(parseResetTime(`{"resets_at": ${epochSec}}`, now), epochSec * 1000);

  // resolveCooldownUntil priority: error text > limitsData resetsAt > 30m default
  const limitsData = {
    claude: {
      fiveHour: { pct: 95, resetsAt: now + 75 * 60_000 },
      week: { pct: 40, resetsAt: now + 48 * 3600_000 },
    },
  };
  const fromErr = resolveCooldownUntil("claude", { text: "resets 5:20am (UTC)", limitsData, now });
  assert.equal(fromErr.source, "error");
  assert.equal(fromErr.until, Date.UTC(2026, 4, 10, 5, 20, 0));

  const fromLim = resolveCooldownUntil("claude", { text: "429 too many requests", limitsData, now });
  assert.equal(fromLim.source, "limits");
  assert.equal(fromLim.until, now + 75 * 60_000);

  const fromDef = resolveCooldownUntil("gemini", { text: "429 too many requests", limitsData, now });
  assert.equal(fromDef.source, "default");
  assert.equal(fromDef.until, now + COOLDOWN_DEFAULT_MS);
});

test("cooldown persistence skips providers in available()/nextAgent() and clears cleanly", () => {
  withTempHome((home) => {
    const binDir = path.join(home, "bin");
    const { agyPath } = installFakeClis(binDir);
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevNv = process.env.NVIDIA_API_KEY;
    const prevGr = process.env.GROQ_API_KEY;
    const prevMi = process.env.MISTRAL_API_KEY;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    process.env.TOKENWISE_AGY = agyPath;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    clearDoctorCache();

    try {
      const projHome = path.join(home, "proj-home");
      fs.mkdirSync(projHome, { recursive: true });
      const now = Date.now();

      assert.equal(available("codex", { write: true }, projHome), true);
      assert.equal(available("claude", { write: true }, projHome), true);
      assert.equal(available("gemini", { write: true }, projHome), true);

      // Put codex in cooldown with error reset time
      const entry = recordCooldown("codex", { text: "try again in 25m", now });
      assert.equal(entry.source, "error");
      assert.ok(inCooldown("codex", now));
      assert.equal(available("codex", { write: true }, projHome), false);
      // Should not shorten known error reset cooldown with a smaller 30m default if remaining > 30m
      const longEntry = recordCooldown("codex", { text: "try again in 90m", now });
      const keepLong = recordCooldown("codex", { text: "429 rate limit", now });
      assert.equal(keepLong.until, longEntry.until);

      // nextAgent skips codex and picks gemini
      assert.equal(nextAgent({ tried: [], write: true, home: projHome }), "gemini");

      // Expired cooldown makes codex available again
      assert.equal(inCooldown("codex", longEntry.until + 1000), false);
      assert.ok(activeCooldowns(now).codex);

      clearCooldown("codex");
      assert.equal(getCooldown("codex"), null);
      assert.equal(available("codex", { write: true }, projHome), true);
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY; else process.env.TOKENWISE_AGY = prevAgy;
      if (prevOr !== undefined) process.env.OPENROUTER_API_KEY = prevOr;
      if (prevNv !== undefined) process.env.NVIDIA_API_KEY = prevNv;
      if (prevGr !== undefined) process.env.GROQ_API_KEY = prevGr;
      if (prevMi !== undefined) process.env.MISTRAL_API_KEY = prevMi;
      clearDoctorCache();
    }
  });
});

test("Jobs and Chats record cooldowns on RATE_LIMIT errors and clear on success", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;

    try {
      const { agyPath } = installFakeClis(binDir, { claudeBehavior: "ratelimit", agyBehavior: "429" });
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
      process.env.TOKENWISE_AGY = agyPath;
      clearDoctorCache();

      const jobs = new Jobs(repo);
      // 1) Claude worker fails with RATE_LIMIT ("resets 5:20am (UTC)"), noFallback -> records cooldown in ~/.tokenwise-studio/cooldowns.json
      const jClaude = jobs.start({ agent: "claude", model: "sonnet", effort: "low", write: false, noFallback: true, task: "check logs" });
      const doneClaude = await jobs.wait(jClaude.id, 10);
      assert.equal(doneClaude.status, "failed");
      const cdClaude = getCooldown("claude");
      assert.ok(cdClaude, "claude cooldown should be recorded");
      assert.equal(cdClaude.source, "error");
      assert.ok(fs.existsSync(path.join(home, ".tokenwise-studio", "cooldowns.json")));

      // 2) Starting another job on cooled-down Claude with fallback switches away to Codex before spawn
      const jSwitch = jobs.start({ agent: "claude", model: "sonnet", effort: "low", write: false, task: "check again" });
      assert.equal(jSwitch.agent, "codex");
      assert.match(jSwitch.movedFrom.reason, /^cooling down until \d{2}:\d{2}$/);
      await jobs.wait(jSwitch.id, 10);
      assert.equal(getCooldown("codex"), null);

      // 3) Gemini 429 records both cooldown and local gemini-usage counter
      const jGem = jobs.start({ agent: "gemini", model: "hydrogen", effort: "low", write: false, noFallback: true, task: "search repo" });
      const doneGem = await jobs.wait(jGem.id, 10);
      assert.equal(doneGem.status, "failed");
      assert.ok(getCooldown("gemini"), "gemini cooldown recorded on 429");
      const gAfter429 = geminiUsage();
      assert.equal(gAfter429.fiveHour.jobs, 1);
      assert.equal(gAfter429.cooldowns5h, 1);
      assert.ok(gAfter429.cooldown);

      // 4) Gemini success clears cooldown and adds token counters
      installFakeClis(binDir, { claudeBehavior: "ok", agyBehavior: "ok" });
      const jGemOk = jobs.start({ agent: "gemini", model: "hydrogen", effort: "low", write: false, noFallback: true, task: "search repo ok" });
      const doneGemOk = await jobs.wait(jGemOk.id, 10);
      assert.equal(doneGemOk.status, "done");
      assert.equal(getCooldown("gemini"), null);
      const gAfterOk = geminiUsage();
      assert.equal(gAfterOk.fiveHour.jobs, 2);
      assert.equal(gAfterOk.fiveHour.tokens, 420);
      assert.equal(gAfterOk.cooldown, null);

      // 5) Orchestrator Chats.send records cooldown on Codex RATE_LIMIT and clears on Codex success
      clearCooldown("codex");
      const chatsErr = new Chats(jobs, {
        spawn: fakeSpawn([JSON.stringify({ type: "turn.failed", error: { message: "rate limit reached 429" } })], 1),
      });
      const turnErr = chatsErr.send({ message: "hi codex", model: "sol", effort: "medium", force: "codex" });
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(getCooldown("codex"), "codex cooldown recorded on orchestrator rate limit");
      assert.equal(chatsErr.get(turnErr.id).status, "failed");

      // Explicit force=codex rejects cleanly with HH:MM while cooling down
      assert.throws(
        () => chatsErr.send({ message: "hi again", model: "sol", effort: "medium", force: "codex" }),
        /cooling down until \d{2}:\d{2}/
      );

      // Clear cooldown & verify success clears any stale cooldown
      clearCooldown("codex");
      const chatsOk = new Chats(jobs, {
        spawn: fakeSpawn([
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 15, output_tokens: 5 } }),
        ], 0),
      });
      chatsOk.send({ message: "hi codex ok", model: "sol", effort: "medium", force: "codex" });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(getCooldown("codex"), null);

      // pickOrchestrator skips Claude when Claude is in cooldown and Codex is ready
      recordCooldown("claude", { until: Date.now() + 20 * 60_000, reason: "hit limit" });
      const pick = pickOrchestrator(jobs.home, "opus", "high");
      assert.equal(pick.agent, "codex");
      assert.match(pick.reason, /^Claude cooling down until \d{2}:\d{2}$/);
      assert.match(translateReason(pick.reason, "tr"), /soğumada|\d{2}:\d{2}/);
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY; else process.env.TOKENWISE_AGY = prevAgy;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("settings validates saveClaudeForPlanning and pacingThreshold bounds and cross-check", () => {
  withTempHome(() => {
    const def = loadSettings();
    assert.equal(DEFAULTS.saveClaudeForPlanning, true);
    assert.equal(DEFAULTS.pacingThreshold, 70);
    assert.equal(def.saveClaudeForPlanning, true);
    assert.equal(def.pacingThreshold, 70);

    // Valid range 50..89 (and below limitThreshold)
    const s1 = saveSettings({ saveClaudeForPlanning: false, pacingThreshold: 55 });
    assert.equal(s1.saveClaudeForPlanning, false);
    assert.equal(s1.pacingThreshold, 55);

    assert.throws(() => saveSettings({ saveClaudeForPlanning: "yes" }), /true or false/);
    assert.throws(() => saveSettings({ pacingThreshold: 49 }), /between 50 and 89/);
    assert.throws(() => saveSettings({ pacingThreshold: 90 }), /between 50 and 89/);
    assert.throws(() => saveSettings({ limitThreshold: 80, pacingThreshold: 80 }), /below/);

    // Lowering limitThreshold auto-clamps pacingThreshold below it (when >= 51)
    const s2 = saveSettings({ saveClaudeForPlanning: true, limitThreshold: 65, pacingThreshold: 64 });
    const s3 = saveSettings({ limitThreshold: 60 });
    assert.equal(s3.limitThreshold, 60);
    assert.equal(s3.pacingThreshold, 59);
    assert.equal(s2.saveClaudeForPlanning, true);
  });
});

test("pacing steers workers away from Claude only when orchestrator is Claude and honors Codex Sol/Terra/Luna", async () => {
  await withTempHome(async (home) => {
    const repo = initGitRepo();
    const binDir = path.join(home, "bin");
    const prevPath = process.env.PATH;
    const prevAgy = process.env.TOKENWISE_AGY;
    const { agyPath } = installFakeClis(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
    process.env.TOKENWISE_AGY = agyPath;
    clearDoctorCache();

    try {
      const jobs = new Jobs(repo);
      const futureSec = Math.floor((Date.now() + 2 * 3600_000) / 1000);
      writeClaudeRateEvent(jobs.home, { fiveHourPct: 76, fiveHourResetsSec: futureSec, weekPct: 40, weekResetsSec: futureSec + 86400 });

      saveSettings({ saveClaudeForPlanning: true, allowFree: false, pacingThreshold: 70, limitThreshold: 90, fallbackOrder: ["claude", "codex", "gemini", "free", "local"] });

      // Claude orchestrator: pacing active at 76%
      const paceClaude = claudePacing(jobs.home, { orchestratorAgent: "claude" });
      assert.deepEqual(paceClaude, { active: true, window: "5-hour", pct: 76, threshold: 70, hardThreshold: 90 });

      // Codex orchestrator (sol/terra/luna): Claude pacing is NOT active
      assert.equal(claudePacing(jobs.home, { orchestratorAgent: "codex" }), null);

      // nextAgent steers away from claude when codex/gemini available even if fallbackOrder starts with claude
      assert.equal(nextAgent({ tried: [], write: true, home: jobs.home }), "codex");
      const prefs = preferredWorkers(jobs.home, { write: true });
      assert.equal(prefs[0], "codex");
      assert.ok(prefs.indexOf("claude") > 0, `claude should follow non-claude workers: ${JSON.stringify(prefs)}`);

      // Falls back to claude if all non-local alternatives are tried
      assert.equal(nextAgent({ tried: ["codex", "gemini"], write: true, home: jobs.home }), "claude");

      // Prompts include QUOTA PACING when active
      const orchGuide = buildGuide("ask", { pacing: paceClaude, allowFree: true });
      assert.match(orchGuide, /QUOTA PACING \(Save Claude for planning\): Claude's 5-hour usage is at 76%/);
      assert.match(orchGuide, /codex, gemini, or free/);

      const tGuide = teamGuide({ mode: "auto", allow: { free: false } }, { pacing: paceClaude, allowFree: true });
      assert.match(tGuide, /Quota pacing is active/);
      assert.match(tGuide, /prefer codex or gemini/);

      // Codex orchestrator Chats.send must NOT pass QUOTA PACING for Claude to Codex orchestrator
      let capturedPrompt = "";
      const chats = new Chats(jobs, {
        spawn: (_cmd, args) => {
          capturedPrompt = args[args.length - 1] || "";
          return fakeSpawn([
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
          ])(_cmd, args);
        },
      });
      chats.send({ message: "plan refactor", model: "sol", effort: "medium", force: "codex" });
      await new Promise((r) => setTimeout(r, 80));
      assert.doesNotMatch(capturedPrompt, /QUOTA PACING/);

      // teamOptions respects orchestratorAgent
      const optsClaude = teamOptions([], { home: jobs.home, orchestratorAgent: "claude" });
      assert.equal(optsClaude.pacing.active, true);
      assert.equal(optsClaude.agents.claude.pacing, true);

      const optsCodex = teamOptions([], { home: jobs.home, orchestratorAgent: "codex" });
      assert.equal(optsCodex.pacing.active, false);
      assert.equal(optsCodex.agents.claude.pacing, false);

      // UI endpoints reflect pacing, cooldowns, Gemini card, and Codex orchestrator distinction
      initServer({ repo });
      recordCooldown("gemini", { text: "try again in 18m" });
      recordGeminiRun({ tokens: { input: 200, output: 50 }, rateLimited: true });

      const rOrchClaude = await callHandler("GET", "/api/orchestrator?model=opus&effort=high");
      assert.equal(rOrchClaude.status, 200);
      assert.equal(rOrchClaude.body.agent, "claude");
      assert.equal(rOrchClaude.body.pacing.active, true);

      for (const codexModel of ["sol", "terra", "luna"]) {
        const rOrchCodex = await callHandler("GET", `/api/orchestrator?model=${codexModel}&effort=medium`);
        assert.equal(rOrchCodex.status, 200);
        assert.equal(rOrchCodex.body.agent, "codex");
        assert.equal(rOrchCodex.body.pacing, null);
      }

      const rTeamCodex = await callHandler("GET", "/api/team?orch=sol");
      assert.equal(rTeamCodex.body.options.pacing.active, false);

      const rLimits = await callHandler("GET", "/api/limits");
      assert.equal(rLimits.status, 200);
      assert.equal(rLimits.body.claude.fiveHour.pct, 76);
      assert.equal(rLimits.body.gemini.approximate, true);
      assert.equal(rLimits.body.gemini.fiveHour.tokens, 250);
      assert.equal(rLimits.body.gemini.cooldowns24h, 1);
      assert.ok(rLimits.body.cooldowns.gemini);
      assert.match(t("limits.coolingDown", { time: formatHHMM(rLimits.body.cooldowns.gemini.until) }, "en"), /cooling down until \d{2}:\d{2}/);
      assert.match(t("limits.coolingDown", { time: "14:20" }, "tr"), /14:20/);
      assert.match(translateReason("cooling down until 14:20", "tr"), /14:20/);
    } finally {
      process.env.PATH = prevPath;
      if (prevAgy === undefined) delete process.env.TOKENWISE_AGY; else process.env.TOKENWISE_AGY = prevAgy;
      clearDoctorCache();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("geminiUsage aggregates 5h and 24h windows accurately and limits() omits gemini when unused", () => {
  withTempHome((home) => {
    const emptyProjHome = path.join(home, "empty-proj");
    fs.mkdirSync(emptyProjHome, { recursive: true });
    assert.equal(limits(emptyProjHome).gemini, null);

    const now = Date.now();
    recordGeminiRun({ tokens: 100, now: now - 30 * 60_000 }); // in 5h + 24h
    recordGeminiRun({ tokens: { input: 200, output: 100, cached: 50 }, rateLimited: true, now: now - 10 * 3600_000 }); // 24h only
    recordGeminiRun({ tokens: 999, now: now - 30 * 3600_000 }); // older than 24h

    const g = geminiUsage(now);
    assert.equal(g.approximate, true);
    assert.equal(g.fiveHour.jobs, 1);
    assert.equal(g.fiveHour.tokens, 100);
    assert.equal(g.day.jobs, 2);
    assert.equal(g.day.tokens, 400);
    assert.equal(g.cooldowns5h, 0);
    assert.equal(g.cooldowns24h, 1);

    const lim = limits(emptyProjHome);
    assert.ok(lim.gemini);
    assert.equal(lim.gemini.approximate, true);
  });
});
