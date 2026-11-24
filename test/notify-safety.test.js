// Regression canary: the test suite must never launch the user's real tokenwise studio app.
// A stub "native app" is registered through app.json in a temp HOME; any launch appends a line to a log.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLE_ID, appJsonPath, clearAppCache, defaultAppPath, findAppBundle, isTempHome } from "../src/appbundle.js";
import { notify, flushNotifications, resetNotifyState, jobNotice, turnNotice, handoffNotice, prNotice, nativeBlocked } from "../src/notify.js";
import { Jobs } from "../src/jobs.js";
import { Chats } from "../src/orchestrator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const darwinOnly = process.platform === "darwin" ? {} : { skip: "macOS only" };

function makeSandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tw-canary-home-")));
  const log = path.join(home, "stub-launches.log");
  const app = defaultAppPath(home);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string></dict></plist>`);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "tokenwise-studio"), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  fs.mkdirSync(path.dirname(appJsonPath(home)), { recursive: true });
  fs.writeFileSync(appJsonPath(home), JSON.stringify({ bundlePath: app }));
  return { home, log };
}
const launches = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

function fakeSpawn() {
  return (cmd) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    process.nextTick(() => {
      if (cmd === "claude") { child.stderr.emit("data", Buffer.from("You have hit your limit, resets in 2h\n")); child.emit("close", 1); }
      else {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "reply" } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\n"));
        child.emit("close", 0);
      }
    });
    return child;
  };
}

test("canary: no code path launches the native app from a test / temp home", darwinOnly, async () => {
  const { home, log } = makeSandbox();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-canary-repo-"));
  const prev = { HOME: process.env.HOME, TEST: process.env.TOKENWISE_TEST, NOTIFY: process.env.TOKENWISE_NOTIFY };
  process.env.HOME = home;
  process.env.TOKENWISE_TEST = "1";
  delete process.env.TOKENWISE_NOTIFY; // default settings, no env opt-out
  clearAppCache(); resetNotifyState();
  try {
    const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    g("init"); g("config", "user.email", "t@example.com"); g("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n"); g("add", "."); g("commit", "-m", "init");

    // The app really is discoverable through the real lookup, so a launch would have happened.
    assert.ok(findAppBundle({ home }), "stub app is discoverable");

    // job finished (no parent), orchestrator turn finished, handoff, PR: the same calls jobs.js, orchestrator.js and ui.js make
    const j = { id: "j1", status: "done", task: "do it", agent: "codex", model: "gpt", files: ["a.txt"], finished: new Date().toISOString(), created: new Date(Date.now() - 600_000).toISOString() };
    const jn = jobNotice(j, 1);
    if (jn) notify({ ...jn, subtitle: "repo", repo, key: "job:j1:done", durationMs: 600_000 });
    notify({ ...jobNotice({ ...j, id: "j2", status: "failed" }, 0), repo, key: "job:j2:failed", durationMs: 600_000 });
    const tn = turnNotice({ turn: { status: "done", agent: "codex", text: "done" }, chatTitle: "chat", readyJobs: 2 });
    if (tn) notify({ ...tn, repo, chat: "c1", key: "turn:c1:0", durationMs: 600_000 });
    notify({ ...handoffNotice("limit", { fromAgent: "claude", toAgent: "codex" }), repo, key: "handoff:c1:0" });
    notify({ ...prNotice({ branch: "b", prUrl: "https://example.com/pr/1" }), kind: "pr", repo, key: "pr:b:abc" });
    flushNotifications({ now: Date.now() + 3_600_000 });

    // Real Jobs + Chats with a fake agent process (limit handoff + finished turn)
    const jobs = new Jobs(repo);
    const chats = new Chats(jobs, { spawn: fakeSpawn() });
    chats.send({ message: "hello", model: "opus", effort: "medium" });
    await sleep(150);
    flushNotifications({ now: Date.now() + 3_600_000 });
    await sleep(100);

    assert.deepEqual(launches(log), [], "the native app must never be launched under test");
    assert.equal(fs.existsSync(path.join(home, ".tokenwise-studio", "notify-ledger.json")), false, "nothing is recorded in the ledger under test");
  } finally {
    for (const [k, v] of [["HOME", prev.HOME], ["TOKENWISE_TEST", prev.TEST], ["TOKENWISE_NOTIFY", prev.NOTIFY]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    clearAppCache(); resetNotifyState();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("positive control: outside tests and temp homes the same path DOES launch the stub", darwinOnly, async () => {
  const { home, log } = makeSandbox();
  const prev = { TEST: process.env.TOKENWISE_TEST, NOTIFY: process.env.TOKENWISE_NOTIFY };
  delete process.env.TOKENWISE_TEST; delete process.env.TOKENWISE_NOTIFY;
  clearAppCache(); resetNotifyState();
  try {
    const deps = { home, tmpdir: "/nonexistent-tmp-root", platform: "darwin", schedule: false, settings: { notifications: true, notifyLevel: "all", notifyFocusDnd: false } };
    assert.equal(nativeBlocked(deps), false);
    const now = Date.now();
    assert.equal(notify({ title: "t", message: "m", kind: "review", repo: "/r", key: "canary:positive" }, { ...deps, now }), true);
    flushNotifications({ ...deps, now: now + 60_000 });
    for (let i = 0; i < 40 && !launches(log).length; i++) await sleep(50);
    const l = launches(log);
    assert.equal(l.length, 1, "stub launched once");
    assert.match(l[0], /--notify/);
  } finally {
    for (const [k, v] of [["TOKENWISE_TEST", prev.TEST], ["TOKENWISE_NOTIFY", prev.NOTIFY]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    clearAppCache(); resetNotifyState();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("guards: temp homes resolve through symlinks and mdfind is skipped for them", () => {
  assert.equal(isTempHome(fs.mkdtempSync(path.join(os.tmpdir(), "tw-x-"))), true);
  assert.equal(isTempHome(os.homedir(), "/definitely/not/home"), false);
  let called = 0;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-y-"));
  try {
    // Real exec (none injected) is never used in a temp home; with an injected exec the lookup still runs.
    findAppBundle({ platform: "darwin", home, cache: false, exec: () => { called++; return ""; } });
    assert.equal(called, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("scripts/test.js runs the suite with TOKENWISE_TEST=1 and TOKENWISE_NOTIFY=0", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "test.js"), "utf8");
  assert.match(src, /TOKENWISE_TEST:\s*"1"/);
  assert.match(src, /TOKENWISE_NOTIFY:\s*"0"/);
});

test("setup skips the first notification for --no-notify, --dry-run and TOKENWISE_TEST", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  assert.match(src, /--no-notify/);
  assert.match(src, /firstNotify/);
  assert.match(src, /TOKENWISE_TEST !== "1"/);
});
