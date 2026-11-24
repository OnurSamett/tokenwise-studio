import test from "node:test";
import assert from "node:assert/strict";
import { freeWorkerUnavailable } from "../src/fallback.js";
import { buildGuide } from "../src/orchestrator.js";

test("unavailable free workers can hand off without bypassing refusals", () => {
  assert.equal(freeWorkerUnavailable({ type: "free.error", status: 403, message: "model access denied" }), true);
  assert.equal(freeWorkerUnavailable({ type: "free.error", status: 0, message: "no usable free model" }), true);
  assert.equal(freeWorkerUnavailable({ type: "free.error", status: 0, message: "connection refused" }), true);
  assert.equal(freeWorkerUnavailable({ type: "free.error", status: 403, message: "content policy refusal" }), false);
  assert.equal(freeWorkerUnavailable({ type: "free.error", status: 0, message: "stopped after 40 steps" }), false);
  assert.equal(freeWorkerUnavailable({ type: "free.skip", status: 404, message: "model not found" }), false);
});

test("orchestrator delegates routine work and preserves free mode", () => {
  for (const mode of ["ask", "auto-apply", "plan-only"]) {
    const guide = buildGuide(mode, { freeMode: true });
    assert.match(guide, /ORCHESTRATOR ROLE/);
    assert.match(guide, /never silently take over implementation/i);
    assert.match(guide, /only free and local workers are allowed/i);
  }
});

test("buildGuide is compact (>= 40% smaller) and includes optional sections only when active", () => {
  const typical = buildGuide("ask");
  assert.ok(typical.length <= 2670, `expected compact guide <= 2670 chars, got ${typical.length}`);
  assert.match(typical, /Every code change/i);
  assert.match(typical, /untrusted data/i);
  assert.match(typical, /Do NOT call job_merge/);
  assert.match(typical, /Free\/local cannot run commands/i);
  assert.doesNotMatch(typical, /FREE MODE IS ON/);
  assert.doesNotMatch(typical, /ROBLOX STUDIO PLAYTEST READY/);
  assert.doesNotMatch(typical, /TURN TOKEN BUDGET/);
  assert.doesNotMatch(typical, /NON-GIT PROJECT/);
  assert.doesNotMatch(typical, /MODEL SHOOTOUT OPTED IN/);

  // Playtest appears ONLY when enabled AND project is a Rojo project
  const playtestNoRojo = buildGuide("ask", { robloxPlaytest: { enabled: true, rojo: false, studioMcpFound: true } });
  assert.doesNotMatch(playtestNoRojo, /role="playtest"/);
  assert.doesNotMatch(playtestNoRojo, /ROBLOX STUDIO PLAYTEST READY/);

  const playtestWithRojo = buildGuide("ask", { robloxPlaytest: { enabled: true, rojo: true, studioMcpFound: true } });
  assert.match(playtestWithRojo, /ROBLOX STUDIO PLAYTEST READY/);
  assert.match(playtestWithRojo, /role="playtest"/);

  // Research omitted in Free mode or when research role does not exist
  assert.doesNotMatch(buildGuide("ask", { freeMode: true }), /role="research"/);
  assert.doesNotMatch(buildGuide("ask", { research: false }), /role="research"/);
  assert.doesNotMatch(buildGuide("ask", { team: { roles: { code: { agent: "codex" } } } }), /role="research"/);
  assert.match(buildGuide("ask"), /role="research"/);

  // Budget only when turnBudget > 0
  assert.match(buildGuide("ask", { turnBudget: 100_000 }), /TURN TOKEN BUDGET/);
});
