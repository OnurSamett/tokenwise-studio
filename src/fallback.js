// Fallback chain: when a worker's plan is near its usage limit (or a job fails with a rate-limit
// error), hand the task to the next available worker instead of stopping.
//
// Order (override with TOKENWISE_FALLBACK, comma-separated):
//   codex → gemini → claude → local → free
// - "local" (Ollama) is free and unlimited and can edit files.
// - "free" (free-tier chat API) is read-only text only and opt-in (TOKENWISE_ALLOW_FREE=1),
//   because free tiers may use prompts for training.
import { doctor } from "./doctor.js";
import { limits } from "./limits.js";

export const RATE_LIMIT = /rate.?limit|usage limit|quota|\b429\b|too many requests|limit (?:reached|exceeded)|exceeded your|out of credits/i;

const chain = () => (process.env.TOKENWISE_FALLBACK || "codex,gemini,claude,local,free").split(",").map((s) => s.trim()).filter(Boolean);
const threshold = () => Number(process.env.TOKENWISE_LIMIT_THRESHOLD || 90);

/** Is this agent's plan at or above the threshold? Returns a short reason or null. */
export function nearLimit(agent, home) {
  const L = limits(home);
  const plan = agent === "codex" ? L.codex : agent === "claude" ? L.claude : null;
  if (!plan) return null;
  const th = threshold();
  if (plan.fiveHour?.pct >= th) return `5-hour limit at ${plan.fiveHour.pct}%`;
  if (plan.week?.pct >= th) return `weekly limit at ${plan.week.pct}%`;
  return null;
}

export function available(agent, { write }) {
  const d = doctor()[agent];
  if (!d || !d.installed || !d.signedIn) return false;
  if (agent === "free") return !write && process.env.TOKENWISE_ALLOW_FREE === "1";
  return true;
}

/** Next agent to try after `tried`, skipping unavailable ones and plans near their limit. */
export function nextAgent({ tried, write, home }) {
  for (const a of chain()) {
    if (tried.includes(a)) continue;
    if (!available(a, { write })) continue;
    if (nearLimit(a, home)) continue;
    return a;
  }
  return null;
}
