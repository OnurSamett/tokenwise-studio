import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { Jobs } from "../src/jobs.js";
import { Chats } from "../src/orchestrator.js";
import { available, nextAgent } from "../src/fallback.js";
import { PRESETS, saveTeam, teamOptions } from "../src/team.js";
import { turnTotal } from "../src/budget.js";
import { COMPACT_NOTICE, clip } from "../src/compact.js";
import { normalize } from "../src/events.js";
import { handler, initServer } from "../src/ui.js";

const tmp = (prefix = "tw-jobs-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const prevNotify = process.env.TOKENWISE_NOTIFY;
  const home = tmp("tw-home-");
  process.env.HOME = home;
  process.env.TOKENWISE_NOTIFY = "0";
  const cleanup = () => {
    process.env.HOME = prevHome;
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY;
    else process.env.TOKENWISE_NOTIFY = prevNotify;
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

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForFile(file, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) return raw;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
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

test("discard kills worker process group and close after discard does not touch deleted worktree", async () => {
  await withTempHome(async () => {
    const repo = initGitRepo();
    const binDir = tmp("tw-bin-");
    const pidFile = path.join(binDir, "pids.json");
    const prevPath = process.env.PATH;
    const prevPidFile = process.env.TW_TEST_PID_FILE;
    let grandchildPid = null;

    try {
      // Fake `claude` worker: spawns a grandchild in the same process group, traps SIGTERM
      // and waits 80ms before exiting so discard() removes the worktree before close fires.
      const fakeClaude = path.join(binDir, "claude");
      fs.writeFileSync(fakeClaude, [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        'const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'fs.writeFileSync(process.env.TW_TEST_PID_FILE, JSON.stringify({ pid: process.pid, sub: sub.pid }));',
        'process.on("SIGTERM", () => { setTimeout(() => process.exit(143), 80); });',
        'setInterval(() => {}, 1000);',
      ].join("\n"), { mode: 0o755 });

      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
      process.env.TW_TEST_PID_FILE = pidFile;

      const jobs = new Jobs(repo);
      const job = jobs.start({
        agent: "claude",
        model: "haiku",
        effort: "low",
        write: true,
        noFallback: true,
        task: "make a change in worktree",
      });

      const info = JSON.parse(await waitForFile(pidFile));
      grandchildPid = info.sub;
      assert.ok(pidAlive(info.pid));
      assert.ok(pidAlive(grandchildPid));
      assert.equal(fs.existsSync(job.cwd), true);

      const discarded = jobs.discard(job.id);
      assert.equal(discarded.status, "discarded");
      assert.equal(fs.existsSync(job.cwd), false);

      // Process-group SIGTERM should kill the untrapped grandchild even while the leader delays exit.
      const deadline = Date.now() + 2000;
      while (pidAlive(grandchildPid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(pidAlive(grandchildPid), false, "grandchild process in worker group should be killed");

      // Wait for leader close handler (runs after worktree was already deleted).
      const finalJob = await jobs.wait(job.id, 5);
      assert.equal(finalJob.status, "discarded");
      assert.equal(finalJob.diffStat, null);
      assert.deepEqual(finalJob.files, []);
      assert.equal(fs.existsSync(job.cwd), false);
    } finally {
      if (grandchildPid && pidAlive(grandchildPid)) {
        try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      }
      process.env.PATH = prevPath;
      if (prevPidFile === undefined) delete process.env.TW_TEST_PID_FILE;
      else process.env.TW_TEST_PID_FILE = prevPidFile;
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("images role is restricted to codex with no fallback and teamOptions matches AGENTS", () => {
  withTempHome(() => {
    const repo = tmp("tw-imgrole-");
    try {
      for (const ag of ["claude", "gemini", "free", "local"]) {
        assert.equal(available(ag, { write: true, role: "images" }), false);
      }
      assert.equal(nextAgent({ tried: ["codex"], write: true, role: "images" }), null);

      const jobs = new Jobs(repo);
      for (const ag of ["claude", "gemini", "free", "local"]) {
        assert.throws(
          () => jobs.start({ agent: ag, role: "images", task: "draw an app icon" }),
          /image generation needs Codex/,
        );
      }

      // Cheap preset uses gemini hydrogen low for research (not free).
      assert.deepEqual(PRESETS.cheap.research, { agent: "gemini", model: "hydrogen", effort: "low" });

      // team.js validation rejects local and non-codex images agents consistently with teamOptions().
      const opts = teamOptions();
      assert.equal(opts.agents.local, undefined);
      assert.deepEqual(opts.roles.find((r) => r.id === "images")?.supportedAgents, ["codex"]);
      assert.throws(
        () => saveTeam(jobs.home, { mode: "manual", roles: { ...PRESETS.balanced, images: { agent: "gemini" } } }),
        /agent must be one of codex/,
      );
      assert.throws(
        () => saveTeam(jobs.home, { mode: "manual", roles: { ...PRESETS.balanced, code: { agent: "local" } } }),
        /agent must be one of/,
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("Jobs.list and Chats.list cache JSON by mtime and invalidate on mtime change", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-cache-");
    try {
      const jobs = new Jobs(repo);
      const chats = new Chats(jobs);

      const job = jobs.save({
        id: "20261114000000-j1",
        title: "alpha",
        agent: "codex",
        model: "sol",
        effort: "medium",
        write: false,
        status: "done",
        created: "2026-11-14T00:00:00.000Z",
      });
      const chat = chats.save({
        id: "20261114000000-c1",
        title: "alpha",
        created: "2026-11-14T00:00:00.000Z",
        sessionId: null,
        turns: [],
        cost: 0,
      });

      // Pin whole-second mtime before populating cache so APFS sub-ms precision doesn't drift on restore.
      const jFile = jobs.file(job.id, "job");
      const cFile = chats.f(chat.id, "json");
      const t0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
      fs.utimesSync(jFile, t0, t0);
      fs.utimesSync(cFile, t0, t0);

      assert.equal(jobs.list()[0].title, "alpha");
      assert.equal(chats.list()[0].title, "alpha");

      // Rewrite same byte length ("alpha" -> "bravo") while preserving exact mtime: cache hit returns "alpha".
      fs.writeFileSync(jFile, fs.readFileSync(jFile, "utf8").replace('"alpha"', '"bravo"'));
      fs.writeFileSync(cFile, fs.readFileSync(cFile, "utf8").replace('"alpha"', '"bravo"'));
      fs.utimesSync(jFile, t0, t0);
      fs.utimesSync(cFile, t0, t0);

      assert.equal(jobs.list()[0].title, "alpha");
      assert.equal(chats.list()[0].title, "alpha");

      // Bump mtime without changing size: cache invalidates and returns "bravo".
      const t1 = new Date(t0.getTime() + 5000);
      fs.utimesSync(jFile, t1, t1);
      fs.utimesSync(cFile, t1, t1);

      assert.equal(jobs.list()[0].title, "bravo");
      assert.equal(chats.list()[0].title, "bravo");

      // /api/state reflects the invalidated cache.
      initServer({ repo });
      const stRes = await callHandler("GET", "/api/state");
      assert.equal(stRes.status, 200);
      assert.equal(stRes.body.jobs[0].title, "bravo");
      assert.equal(stRes.body.chats[0].title, "bravo");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("Jobs.usage counts tokens incrementally by byte offset across appended log chunks", () => {
  withTempHome(() => {
    const repo = tmp("tw-usage-inc-");
    try {
      const jobs = new Jobs(repo);
      const j = jobs.save({
        id: "20261114000000-u1",
        title: "work",
        agent: "codex",
        model: "sol",
        effort: "medium",
        write: false,
        parent: "chat-1",
        status: "running",
        created: "2026-11-14T00:00:00.000Z",
      });
      const logFile = jobs.file(j.id, "log");
      const entry = (line) => JSON.stringify({ t: Date.now(), stream: "out", line: JSON.stringify(line) }) + "\n";

      assert.deepEqual(jobs.usage(j.id), { tokens: null, cost: null });

      const line1 = entry({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } });
      fs.writeFileSync(logFile, line1);
      assert.deepEqual(jobs.usage(j.id), { tokens: { input: 100, cached: 20, output: 30 }, cost: null });
      const offset1 = jobs._usageCache.get(j.id).offset;
      assert.equal(offset1, Buffer.byteLength(line1));

      // Appending a second line only reads from offset1 and sums both turns.
      const line2 = entry({ type: "turn.completed", usage: { input_tokens: 250, cached_input_tokens: 10, output_tokens: 40 } });
      fs.appendFileSync(logFile, line2);
      assert.deepEqual(jobs.usage(j.id), { tokens: { input: 350, cached: 30, output: 70 }, cost: null });
      assert.equal(jobs._usageCache.get(j.id).offset, Buffer.byteLength(line1) + Buffer.byteLength(line2));
      assert.equal(turnTotal(jobs, "chat-1", "2026-11-14T00:00:00.000Z", 50).used, 470);

      // Partial line without trailing newline does not advance committed offset or corrupt totals.
      const line3 = entry({ type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10 } });
      const mid = Math.floor(line3.length / 2);
      fs.appendFileSync(logFile, line3.slice(0, mid));
      assert.deepEqual(jobs.usage(j.id), { tokens: { input: 350, cached: 30, output: 70 }, cost: null });
      assert.equal(jobs._usageCache.get(j.id).offset, Buffer.byteLength(line1) + Buffer.byteLength(line2));

      fs.appendFileSync(logFile, line3.slice(mid));
      assert.deepEqual(jobs.usage(j.id), { tokens: { input: 400, cached: 30, output: 80 }, cost: null });
      assert.equal(jobs._usageCache.get(j.id).offset, fs.statSync(logFile).size);

      // Truncated/replaced log resets offset cleanly.
      fs.writeFileSync(logFile, line1);
      assert.deepEqual(jobs.usage(j.id), { tokens: { input: 100, cached: 20, output: 30 }, cost: null });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("events.js uses COMPACT_NOTICE and compact.js exports shared clip()", () => {
  const ev = normalize("claude", { stream: "compact", line: "{}" });
  assert.equal(ev[0].text, COMPACT_NOTICE);
  assert.equal(clip("  hello world  ", 8), "hello w…");
  assert.equal(clip("  hello world  ", 6), "hello…");
  assert.equal(clip("short", 10), "short");
});
