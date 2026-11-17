import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULTS, loadSettings, saveSettings } from "../src/settings.js";
import { buildGuide } from "../src/orchestrator.js";

const tmp = (prefix = "tw-deleg-first-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("settings: delegationFirst defaults to false, persists, and validates", () => {
  const prevHome = process.env.HOME;
  const home = tmp("tw-home-");
  process.env.HOME = home;
  try {
    assert.equal(DEFAULTS.delegationFirst, false);
    assert.equal(loadSettings().delegationFirst, false);

    const on = saveSettings({ delegationFirst: true });
    assert.equal(on.delegationFirst, true);
    assert.equal(loadSettings().delegationFirst, true);

    const off = saveSettings({ delegationFirst: false });
    assert.equal(off.delegationFirst, false);

    assert.throws(() => saveSettings({ delegationFirst: "yes" }), /delegationFirst must be true or false/);
    assert.throws(() => saveSettings({ delegationFirst: 1 }), /delegationFirst must be true or false/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("buildGuide omits DELEGATION-FIRST block by default", () => {
  const guide = buildGuide("ask");
  assert.doesNotMatch(guide, /DELEGATION-FIRST/);
});

test("buildGuide adds DELEGATION-FIRST guidance when delegationFirst is true", () => {
  const guide = buildGuide("ask", { delegationFirst: true });
  assert.match(guide, /DELEGATION-FIRST/);
  assert.match(guide, /guidance, not a hard rule/i);
  assert.match(guide, /substantial requests that split into clear pieces/i);
  assert.match(guide, /permission mode, merge\/apply rules/i);
  assert.match(guide, /turn token budget/i);
  assert.match(guide, /prefer a suitable lightweight worker/i);
  assert.match(guide, /never switch the main model silently/i);
  assert.match(guide, /Reserve Opus and Astra/i);
});

test("buildGuide keeps plan-only and merge rules with delegationFirst enabled", () => {
  const plan = buildGuide("plan-only", { delegationFirst: true });
  assert.match(plan, /PLAN-ONLY MODE IS ACTIVE/);
  assert.match(plan, /DELEGATION-FIRST/);
  assert.doesNotMatch(plan, /call job_merge yourself when the changes look good/);

  const auto = buildGuide("auto-apply", { delegationFirst: true });
  assert.match(auto, /call job_merge yourself when the changes look good/);
  assert.match(auto, /DELEGATION-FIRST/);

  const ask = buildGuide("ask", { delegationFirst: true });
  assert.match(ask, /Do NOT call job_merge unless the user explicitly asks/i);
});

test("buildGuide stacks delegation-first with turn budget and pacing hints", () => {
  const guide = buildGuide("ask", {
    delegationFirst: true,
    turnBudget: 50_000,
    pacing: { active: true, window: "5h", pct: 72, threshold: 70 },
    allowFree: true,
  });
  assert.match(guide, /DELEGATION-FIRST/);
  assert.match(guide, /TURN TOKEN BUDGET/);
  assert.match(guide, /QUOTA PACING/);
});