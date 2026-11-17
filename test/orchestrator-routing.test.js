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
