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
