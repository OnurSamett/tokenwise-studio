import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, usageOf, rateFor } from "../src/usage.js";

const NOW = new Date(2026, 10, 14, 15, 0, 0); // local time, mid-afternoon
const at = (daysAgo, h = 12) => new Date(2026, 10, 14 - daysAgo, h, 0, 0).toISOString();

test("usageOf: reported cost wins, otherwise estimated, free and local cost nothing", () => {
  assert.equal(usageOf({ agent: "claude", model: "opus", tokens: { input: 1000, output: 100 }, cost: 0.42 }).cost, 0.42);
  const est = usageOf({ agent: "codex", model: "sol", tokens: { input: 1e6, cached: 0, output: 1e6 } });
  assert.ok(est.cost > 0 && est.estimated === est.cost);
  assert.equal(usageOf({ agent: "free", model: "kimi (nvidia)", tokens: { input: 5e6, output: 5e6 } }).cost, 0);
  assert.equal(usageOf({ agent: "local", model: "x", tokens: { input: 5e6, output: 5e6 } }).cost, 0);
  assert.equal(rateFor("codex", "gpt-unknown"), null);
});

test("usageOf: total is input plus output, cached is tracked apart", () => {
  const u = usageOf({ agent: "claude", model: "haiku", tokens: { input: 10, cached: 500, output: 5 } });
  assert.equal(u.total, 15); assert.equal(u.cached, 500);
});

test("aggregateUsage: per day, window edges, by model, totals", () => {
  const chats = [{ turns: [
    { started: at(0), agent: "claude", model: "opus", tokens: { input: 1000, cached: 0, output: 200 }, cost: 0.5 },
    { started: at(1), agent: "claude", model: "opus", tokens: { input: 100, output: 50 }, cost: 0.1 },
    { started: at(20), agent: "claude", model: "opus", tokens: { input: 9999, output: 9999 }, cost: 9 }, // outside 14 days
    { started: at(0), agent: "claude", model: "opus", tokens: null, cost: null }, // nothing recorded
  ] }];
  const jobs = [
    { created: at(0), agent: "codex", model: "sol", tokens: { input: 2000, cached: 100, output: 300 }, cost: null },
    { created: at(13), agent: "free", model: "moonshot/kimi (nvidia)", tokens: { input: 50, output: 50 }, cost: null },
    { created: at(14), agent: "codex", model: "sol", tokens: { input: 7, output: 7 }, cost: null }, // day 15: outside
  ];
  const r = aggregateUsage({ chats, jobs, days: 14, now: NOW });
  assert.equal(r.byDay.length, 14);
  assert.equal(r.byDay.at(-1).date, "2026-11-14");
  assert.equal(r.byDay[0].date, "2026-11-01");
  const today = r.byDay.at(-1);
  assert.equal(today.orch.total, 1200); assert.equal(today.workers.total, 2300); assert.equal(today.total, 3500);
  assert.equal(r.byDay.at(-2).orch.total, 150);
  assert.equal(r.byDay[0].workers.total, 100);
  assert.equal(r.totals.total, 3500 + 150 + 100);
  assert.equal(r.totals.turns, 2); assert.equal(r.totals.jobs, 2);
  const opus = r.byModel.find((m) => m.agent === "claude");
  assert.equal(opus.turns, 2); assert.ok(Math.abs(opus.cost - 0.6) < 1e-9);
  assert.ok(r.byModel.find((m) => m.agent === "free").cost === 0);
  assert.ok(r.byModel.find((m) => m.agent === "codex").estimated > 0);
  assert.deepEqual(r.byModel.map((m) => m.cost), [...r.byModel.map((m) => m.cost)].sort((a, b) => b - a));
});

test("aggregateUsage: empty input and days clamp", () => {
  const r = aggregateUsage({ now: NOW, days: 500 });
  assert.equal(r.days, 90); assert.equal(r.byDay.length, 90); assert.equal(r.totals.total, 0); assert.deepEqual(r.byModel, []);
  assert.equal(aggregateUsage({ now: NOW, days: "x" }).days, 14);
});

test("aggregateUsage counts job lifecycle outcomes without requiring reported tokens", () => {
  const start = at(0);
  const later = new Date(new Date(start).getTime() + 9000).toISOString();
  const later2 = new Date(new Date(start).getTime() + 3000).toISOString();
  const jobs = [
    { created: start, finished: later, agent: "codex", model: "sol", status: "done" },
    { created: start, finished: later2, agent: "codex", model: "sol", status: "failed" },
    { created: start, finished: null, agent: "codex", model: "sol", status: "discarded" },
    { created: start, finished: later, agent: "codex", model: "sol", status: "running" },
    { created: start, finished: later, agent: "codex", model: "sol", status: "moved" },
    { created: start, finished: at(1), agent: "codex", model: "sol", status: "merged" }, // earlier end: invalid duration
    { created: start, finished: "invalid", agent: "codex", model: "sol", status: "undone" },
    { created: at(30), finished: later, agent: "codex", model: "sol", status: "failed" }, // outside window
    { created: null, finished: later, agent: "codex", model: "sol", status: "done" },
    { created: "bad", finished: later, agent: "codex", model: "sol", status: "done" },
  ];
  const r = aggregateUsage({ jobs, days: 14, now: NOW });
  assert.equal(r.totals.jobs, 7);
  assert.equal(r.totals.total, 0);
  const row = r.byModel.find((item) => item.agent === "codex" && item.model === "sol");
  assert.equal(row.jobs, 7);
  assert.deepEqual(row.jobStats, {
    completed: 3, failed: 1, discarded: 1, moved: 1, running: 1, other: 0,
    durationCount: 3, durationTotalMs: 21000, averageDurationMs: 7000,
  });
  assert.deepEqual(r.totals.jobStats, row.jobStats);
});

test("aggregateUsage keeps outcomes separate by actual provider and model", () => {
  const jobs = [
    { created: at(0), agent: "codex", model: "sol", status: "failed" },
    { created: at(0), agent: "free", model: "nvidia:example/model", modelUsed: "nvidia:example/actual", status: "done" },
    { created: at(0), agent: "codex", model: "sol", status: "unknown" },
  ];
  const r = aggregateUsage({ jobs, days: 14, now: NOW });
  const codex = r.byModel.find((item) => item.agent === "codex");
  const free = r.byModel.find((item) => item.agent === "free");
  assert.equal(codex.jobStats.failed, 1);
  assert.equal(codex.jobStats.other, 1);
  assert.equal(codex.jobStats.averageDurationMs, null);
  assert.equal(free.model, "nvidia:example/actual");
  assert.equal(free.jobStats.completed, 1);
  assert.equal(r.totals.jobs, 3);
});
