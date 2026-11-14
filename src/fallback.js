// Fallback chain: when a worker's plan is near its usage limit (or a job fails with a rate-limit
// error), hand the task to the next available worker instead of stopping.
//
// Order (override with TOKENWISE_FALLBACK, comma-separated):
//   codex → gemini → claude → free → local
// - "local" (Ollama) is free and unlimited and can edit files.
// - "free" (free-tier hosted APIs such as NVIDIA, driven by src/freeagent.js) can read and edit
//   files in its worktree; opt-in (TOKENWISE_ALLOW_FREE=1) because free tiers may use prompts for training.
import { doctor } from "./doctor.js";
import { limits } from "./limits.js";
import { loadTeam } from "./team.js";
import { loadSettings } from "./settings.js";

export const RATE_LIMIT = /rate.?limit|usage limit|quota|\b429\b|too many requests|limit (?:reached|exceeded)|exceeded your|out of credits|hit your (?:[\w-]+ )?limit/i;

const chain = () => loadSettings().fallbackOrder;
const threshold = () => loadSettings().limitThreshold;

/** Is this agent's plan at or above the threshold? Returns a short reason or null. */
export function nearLimit(agent, home) {
  const L = limits(home);
  const plan = agent === "codex" ? L.codex : agent === "claude" ? L.claude : null;
  if (!plan) return null;
  const th = threshold();
  // Readings come from the last run; once a window's reset time has passed the reading is stale.
  const live = (w) => w && typeof w.pct === "number" && !(w.resetsAt && w.resetsAt <= Date.now());
  if (live(plan.fiveHour) && plan.fiveHour.pct >= th) return `5-hour limit at ${plan.fiveHour.pct}%`;
  if (live(plan.week) && plan.week.pct >= th) return `weekly limit at ${plan.week.pct}%`;
  return null;
}

export function available(agent, { write, role } = {}, home) {
  if (role === "research" && (agent === "free" || agent === "local")) return false;
  const d = doctor()[agent];
  if (!d || !d.installed || !d.signedIn) return false;
  if (agent === "free") return loadSettings().allowFree && (!home || loadTeam(home).allow.free !== false);
  return true;
}

/** Next agent to try after `tried`, skipping unavailable ones and plans near their limit. */
export function nextAgent({ tried, write, role, home }) {
  for (const a of chain()) {
    if (tried.includes(a)) continue;
    if (!available(a, { write, role }, home)) continue;
    if (nearLimit(a, home)) continue;
    return a;
  }
  return null;
}
