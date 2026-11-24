// Calmer notifications: one ledger across processes, batching, rate limit, levels, focus, MCP/orchestrator rules.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  notify, flushNotifications, resetNotifyState, reportFocus, noticeCenter, markNoticesRead, loadLedger,
  isImportant, suppressReason, notifyLevel, jobNotice, turnNotice,
  COALESCE_MS, RATE_INTERVAL_MS, RATE_BURST, MCP_MIN_MS, FOCUS_STALE_MS,
} from "../src/notify.js";
import { VALIDATORS, DEFAULTS } from "../src/settings.js";
import { Jobs } from "../src/jobs.js";

// scripts/test.js sets TOKENWISE_NOTIFY=0 for safety; these tests drive the ledger with injected fakes.
delete process.env.TOKENWISE_NOTIFY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTIFY_URL = pathToFileURL(path.join(ROOT, "src", "notify.js")).href;
const T0 = 1_800_000_000_000;

function setup(settings = {}) {
  resetNotifyState();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ledger-"));
  const sent = [];
  let now = T0;
  const deps = {
    platform: "darwin", native: "/fake/tokenwise-studio", home, schedule: false, now: () => now,
    settings: { notifications: true, notifyLevel: "important", notifyFocusDnd: true, language: "en", ...settings },
    exec: (bin, args) => sent.push(Object.fromEntries([["title", args[args.indexOf("--title") + 1]], ["message", args[args.indexOf("--message") + 1]], ["repo", args.includes("--repo") ? args[args.indexOf("--repo") + 1] : ""]])),
  };
  const clock = { get now() { return now; }, set: (t) => { now = t; }, add: (ms) => { now += ms; } };
  const done = () => { resetNotifyState(); fs.rmSync(home, { recursive: true, force: true }); };
  return { home, sent, deps, clock, done };
}

const ev = (over = {}) => ({ kind: "review", title: "Ready for review", message: "Codex finished: x", repo: "/p/web-app", origin: "mcp", durationMs: 5 * 60_000, ...over });

function runChild(code, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

test("ledger: the same event key is sent once across two processes, and each group is flushed by exactly one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ledger-procs-"));
  const log = path.join(home, "delivered.log");
  try {
    const common = `
      import fs from "node:fs";
      import { notify, flushNotifications } from ${JSON.stringify(NOTIFY_URL)};
      const deps = { platform: "darwin", native: "/fake/bin", home: process.env.H, schedule: false, now: () => Number(process.env.NOW),
        settings: { notifications: true, notifyLevel: "all", notifyFocusDnd: false, language: "en" },
        exec: (bin, args) => fs.appendFileSync(process.env.LOG, JSON.stringify(args) + "\\n") };`;
    const enqueue = (who) => `${common}
      const r = [];
      for (let i = 0; i < 20; i++) r.push(notify({ kind: "review", title: "Ready", message: "shared " + i, repo: "/p/a", key: "job:shared:" + i, origin: "mcp", durationMs: 600000 }, deps));
      r.push(notify({ kind: "review", title: "Ready", message: "${who}", repo: "/p/a", key: "job:${who}", origin: "mcp", durationMs: 600000 }, deps));
      console.log(JSON.stringify(r));`;
    const env = { H: home, LOG: log, NOW: String(T0) };
    // Two server processes see the same 20 events (e.g. two MCP servers watching one job dir) plus one of their own.
    const [a, b] = await Promise.all([runChild(enqueue("one"), env), runChild(enqueue("two"), env)]);
    const accepted = [...JSON.parse(a), ...JSON.parse(b)].filter(Boolean).length;
    assert.equal(accepted, 22, "20 shared keys accepted once in total + 1 own key per process");
    const L = loadLedger({ home });
    assert.equal(L.center.length, 22);
    assert.equal(Object.keys(L.pending).length, 1, "one project, one group");

    // Both processes flush at the same moment: the group is delivered once, as one summary.
    const flush = `${common}\n console.log(JSON.stringify(flushNotifications(deps).length));`;
    const later = { ...env, NOW: String(T0 + COALESCE_MS + 1) };
    const [fa, fb] = await Promise.all([runChild(flush, later), runChild(flush, later)]);
    assert.equal(Number(fa) + Number(fb), 1);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const args = JSON.parse(lines[0]);
    assert.equal(args[args.indexOf("--title") + 1], "22 jobs ready for review in a");
    assert.equal(fs.existsSync(path.join(home, ".tokenwise-studio", "notify-ledger.json.lock")), false, "lock released");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("coalescing: events within the window become one summary, nothing is instant", () => {
  const { sent, deps, clock, done } = setup();
  try {
    assert.equal(notify(ev({ key: "job:1" }), deps), true);
    clock.add(4000);
    assert.equal(notify(ev({ key: "job:2" }), deps), true);
    clock.add(4000);
    assert.equal(notify(ev({ key: "job:3" }), deps), true);
    assert.equal(notify(ev({ key: "job:3" }), deps), false, "duplicate key");
    assert.equal(flushNotifications(deps).length, 0);
    assert.equal(sent.length, 0, "nothing arrives instantly");
    clock.set(T0 + COALESCE_MS - 1);
    flushNotifications(deps);
    assert.equal(sent.length, 0);
    clock.set(T0 + COALESCE_MS);
    flushNotifications(deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "3 jobs ready for review in web-app");
    assert.equal(sent[0].repo, "/p/web-app");
    // A different project is its own group; mixed kinds get a generic summary that names failures.
    clock.add(1000);
    notify(ev({ key: "job:4", repo: "/p/api" }), deps);
    notify(ev({ key: "job:5", repo: "/p/api", kind: "jobFailed", title: "Worker failed", message: "Codex: y" }), deps);
    clock.add(COALESCE_MS);
    flushNotifications(deps);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].title, "2 updates in api");
    assert.match(sent[1].message, /^1 failed · /);
    // A single event keeps its own text.
    clock.add(RATE_INTERVAL_MS * 3);
    notify(ev({ key: "job:6", repo: "/p/solo", title: "Ready for review", message: "Codex finished: z" }), deps);
    clock.add(COALESCE_MS);
    flushNotifications(deps);
    assert.deepEqual(sent[2], { title: "Ready for review", message: "Codex finished: z", repo: "/p/solo" });
  } finally { done(); }
});

test("rate limit: burst of 3, then 1 per 20 s; delayed groups keep collecting", () => {
  const { sent, deps, clock, done } = setup();
  try {
    for (let i = 0; i < 5; i++) notify(ev({ key: `job:r${i}`, repo: `/p/p${i}` }), deps);
    clock.add(COALESCE_MS);
    flushNotifications(deps);
    assert.equal(sent.length, RATE_BURST);
    notify(ev({ key: "job:late", repo: "/p/p4" }), deps); // joins the waiting group of p4
    clock.add(RATE_INTERVAL_MS / 2);
    flushNotifications(deps);
    assert.equal(sent.length, 3, "no token yet");
    clock.add(RATE_INTERVAL_MS / 2);
    flushNotifications(deps);
    assert.equal(sent.length, 4);
    clock.add(RATE_INTERVAL_MS);
    flushNotifications(deps);
    assert.equal(sent.length, 5);
    assert.equal(sent.filter((s) => s.repo === "/p/p4").length, 1, "p4 got one summary");
    assert.equal(sent.find((s) => s.repo === "/p/p4").title, "2 jobs ready for review in p4");
    // Over the whole stretch: never more than burst + elapsed/interval.
    assert.ok(sent.length <= RATE_BURST + Math.floor((clock.now - T0) / RATE_INTERVAL_MS));
  } finally { done(); }
});

test("levels: important only (default), all, off; failures always pass the level", () => {
  assert.equal(DEFAULTS.notifyLevel, "important");
  assert.equal(DEFAULTS.notifyFocusDnd, true);
  assert.equal(VALIDATORS.notifyLevel("loud") === true, false);
  assert.equal(VALIDATORS.notifyLevel("all"), true);
  assert.equal(notifyLevel({ notifications: false, notifyLevel: "all" }), "off");
  assert.equal(notifyLevel({}), "important");

  assert.equal(isImportant({ kind: "turn", durationMs: 30_000 }), false);
  assert.equal(isImportant({ kind: "turn", durationMs: 60_000 }), true);
  assert.equal(isImportant({ kind: "turn", durationMs: 5_000, readyJobs: 2 }), true, "review ready");
  for (const kind of ["review", "jobFailed", "turnFailed", "limit"]) assert.equal(isImportant({ kind }), true, kind);
  for (const kind of ["jobDone", "pr"]) assert.equal(isImportant({ kind }), false, kind);

  const app = (kind, durationMs) => ({ kind, durationMs, origin: "app" });
  assert.equal(suppressReason(app("jobDone", 1000), { notifyLevel: "important" }), "level");
  assert.equal(suppressReason(app("jobDone", 1000), { notifyLevel: "all" }), "");
  assert.equal(suppressReason(app("jobFailed", 1000), { notifyLevel: "important" }), "");
  assert.equal(suppressReason(app("review", 1000), { notifyLevel: "off" }), "off");

  // The kinds come from the notice builders.
  assert.equal(jobNotice({ status: "failed", agent: "codex" }, undefined, { lang: "en" }).kind, "jobFailed");
  assert.equal(jobNotice({ status: "done", agent: "codex", write: true, diffStat: "a | 1 +", title: "x" }, 1, { lang: "en" }).kind, "review");
  assert.equal(jobNotice({ status: "done", agent: "codex" }, 0, { lang: "en" }).kind, "jobDone");
  assert.equal(turnNotice({ turn: { reply: "ok" }, lang: "en" }).kind, "turn");
  assert.equal(turnNotice({ turn: { reply: "ok" }, failed: true, lang: "en" }).kind, "turnFailed");

  const { deps, clock, sent, home, done } = setup({ notifyLevel: "important", notifyFocusDnd: false });
  try {
    assert.equal(notify(ev({ key: "a", kind: "jobDone", origin: "app", durationMs: 1000 }), deps), false);
    assert.equal(notify(ev({ key: "b", kind: "turn", origin: "app", durationMs: 20_000 }), deps), false);
    assert.equal(notify(ev({ key: "c", kind: "turn", origin: "app", durationMs: 90_000 }), deps), true);
    assert.equal(notify(ev({ key: "d", kind: "jobFailed", origin: "app", durationMs: 1000 }), deps), true);
    const off = { ...deps, settings: { ...deps.settings, notifications: false } };
    assert.equal(notify(ev({ key: "e", kind: "jobFailed", origin: "app" }), off), false);
    clock.add(COALESCE_MS);
    flushNotifications(deps);
    assert.equal(sent.length, 1);
    const center = noticeCenter("/p/web-app", { home });
    assert.equal(center.items.length, 5, "suppressed events stay visible in the app");
    assert.deepEqual(center.items.map((n) => n.status), ["off", "sent", "sent", "level", "level"]);
  } finally { done(); }
});

test("focus: no desktop alert while the project's window is focused; unknown focus skips in-app events", () => {
  const { deps, clock, sent, home, done } = setup({ notifyLevel: "all" });
  try {
    const inApp = (key, repo = "/p/web-app") => ev({ key, repo, origin: "app", kind: "turn", durationMs: 120_000 });
    assert.equal(notify(inApp("u1"), deps), false, "unknown focus + in-app event: assume focused");
    assert.equal(notify(ev({ key: "u2" }), deps), true, "unknown focus + long MCP job: the user is elsewhere");

    reportFocus("/p/web-app", true, deps);
    assert.equal(notify(inApp("f1"), deps), false);
    assert.equal(notify(inApp("o1", "/p/other"), deps), false, "other project: still unknown");
    reportFocus("/p/other", false, deps);
    assert.equal(notify(inApp("o2", "/p/other"), deps), true, "window not focused");

    clock.add(FOCUS_STALE_MS + 1);
    assert.equal(notify(inApp("s1"), deps), true, "a stale focused report means the window went away");

    // The user comes back before the batch is sent: drop it (it is in the bell list).
    reportFocus("/p/web-app", true, deps);
    clock.add(COALESCE_MS);
    flushNotifications(deps);
    assert.deepEqual(sent.map((s) => s.repo), ["/p/other"]);
    const statuses = Object.fromEntries(loadLedger({ home }).center.map((n) => [n.key, n.status]));
    assert.equal(statuses.u1, "focused");
    assert.equal(statuses.u2, "focused");
    assert.equal(statuses.s1, "focused");
    assert.equal(statuses.o2, "sent");

    // Do not disturb off: focus is ignored.
    const loud = { ...deps, settings: { ...deps.settings, notifyFocusDnd: false } };
    assert.equal(notify(inApp("f2"), loud), true);
  } finally { done(); }
});

test("MCP and orchestrator-started jobs: quiet unless an MCP job ran over 2 minutes", () => {
  const { deps, home, done } = setup({ notifyLevel: "all", notifyFocusDnd: false });
  try {
    assert.equal(notify(ev({ key: "m1", origin: "mcp", durationMs: 30_000 }), deps), false);
    assert.equal(notify(ev({ key: "m2", origin: "mcp", durationMs: MCP_MIN_MS }), deps), false);
    assert.equal(notify(ev({ key: "m3", origin: "mcp", kind: "jobFailed", durationMs: 10_000 }), deps), false, "the MCP client shows its own failure");
    assert.equal(notify(ev({ key: "m4", origin: "mcp", durationMs: MCP_MIN_MS + 1 }), deps), true);
    assert.equal(notify(ev({ key: "o1", origin: "orchestrator" }), deps), false);
    const keys = loadLedger({ home }).center.map((n) => `${n.key}:${n.status}`);
    assert.deepEqual(keys, ["m4:pending", "m3:mcp", "m2:mcp", "m1:mcp"], "orchestrator children are covered by the turn summary");

    // MCP servers mark their jobs; jobs with a parent chat never notify on their own.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ledger-repo-"));
    try {
      assert.equal(new Jobs(repo, { origin: "mcp" }).origin, "mcp");
      assert.equal(new Jobs(repo).origin, "app");
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    const mcpSrc = fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8");
    assert.match(mcpSrc, /new Jobs\(repo, \{ origin: "mcp" \}\)/);
    const jobsSrc = fs.readFileSync(path.join(ROOT, "src", "jobs.js"), "utf8");
    assert.match(jobsSrc, /if \(!j\.parent && \(j\.status === "done" \|\| j\.status === "failed"\)\)/);
  } finally { done(); }
});

test("notification center: newest first, per project, mark read", () => {
  const { deps, home, done } = setup({ notifyLevel: "all", notifyFocusDnd: false });
  try {
    notify(ev({ key: "n1", repo: "/p/a", title: "First" }), deps);
    notify(ev({ key: "n2", repo: "/p/b", title: "Other" }), deps);
    notify(ev({ key: "n3", repo: "/p/a", title: "Second" }), deps);
    const a = noticeCenter("/p/a", { home });
    assert.deepEqual(a.items.map((n) => n.title), ["Second", "First"]);
    assert.equal(a.unread, 2);
    assert.equal("key" in a.items[0], false);
    markNoticesRead("/p/a", { home });
    assert.equal(noticeCenter("/p/a", { home }).unread, 0);
    assert.equal(noticeCenter("/p/b", { home }).unread, 1);
  } finally { done(); }
});
