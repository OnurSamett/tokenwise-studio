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
import { recordCooldown, clearCooldown, getCooldown, inCooldown, activeCooldowns, formatHHMM } from "./cooldowns.js";

export { clearCooldown, getCooldown, inCooldown, activeCooldowns, formatHHMM };

export const RATE_LIMIT = /rate.?limit|usage limit|quota|\b429\b|too many requests|resource.?exhausted|limit (?:reached|exceeded)|exceeded your|out of credits|hit your (?:[\w-]+ )?limit/i;

const chain = () => loadSettings().fallbackOrder;
const threshold = () => loadSettings().limitThreshold;
const liveWindow = (w, now = Date.now()) => w && typeof w.pct === "number" && !(w.resetsAt && w.resetsAt <= now);

/** Record a provider cooldown using error reset text or limits(home) resetsAt, else 30 minutes. */
export function recordProviderCooldown(agent, { text = "", home = null, limitsData = null, reason = "hit a rate limit", now = Date.now() } = {}) {
  const L = limitsData ?? (home ? limits(home) : null);
  return recordCooldown(agent, { text, limitsData: L, reason, now });
}

/** Is this agent's plan at or above the threshold? Returns a short reason or null. */
export function nearLimit(agent, home) {
  const L = limits(home);
  const plan = agent === "codex" ? L.codex : agent === "claude" ? L.claude : null;
  if (!plan) return null;
  const th = threshold();
  const now = Date.now();
  // Readings come from the last run; once a window's reset time has passed the reading is stale.
  if (liveWindow(plan.fiveHour, now) && plan.fiveHour.pct >= th) return `5-hour limit at ${plan.fiveHour.pct}%`;
  if (liveWindow(plan.week, now) && plan.week.pct >= th) return `weekly limit at ${plan.week.pct}%`;
  return null;
}

/**
 * Check whether "Save Claude for planning" pacing is active:
 * Claude's 5-hour or weekly usage is at/above pacingThreshold (50-89) and below limitThreshold,
 * Claude is not in cooldown, and the orchestrator is Claude.
 */
export function claudePacing(home, { limitsData = null, settings = null, now = Date.now(), orchestratorAgent = "claude" } = {}) {
  if (orchestratorAgent !== "claude") return null;
  const s = settings || loadSettings();
  if (!s.saveClaudeForPlanning) return null;
  const th = Number(s.limitThreshold) || 90;
  const pace = Math.min(Number(s.pacingThreshold) || 70, th - 1);
  if (pace < 50 || th <= 50) return null;
  if (inCooldown("claude", now)) return null;
  const L = limitsData || (home ? limits(home) : null);
  const plan = L?.claude;
  if (!plan) return null;
  if ((liveWindow(plan.fiveHour, now) && plan.fiveHour.pct >= th) || (liveWindow(plan.week, now) && plan.week.pct >= th)) {
    return null;
  }
  const hits = [];
  if (liveWindow(plan.fiveHour, now) && plan.fiveHour.pct >= pace) {
    hits.push({ window: "5-hour", pct: plan.fiveHour.pct, resetsAt: plan.fiveHour.resetsAt || null });
  }
  if (liveWindow(plan.week, now) && plan.week.pct >= pace) {
    hits.push({ window: "weekly", pct: plan.week.pct, resetsAt: plan.week.resetsAt || null });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.pct - a.pct);
  return {
    active: true,
    window: hits[0].window,
    pct: hits[0].pct,
    threshold: pace,
    hardThreshold: th,
  };
}

/** Preferred worker order, steering away from Claude while pacing is active. */
export function preferredWorkers(home, { write, role, pacing = null, settings = null } = {}) {
  const s = settings || loadSettings();
  const base = (s.fallbackOrder || chain()).filter((a) => available(a, { write, role }, home) && !nearLimit(a, home));
  const p = pacing ?? claudePacing(home, { settings: s });
  if (!p?.active || !base.includes("claude")) return base;
  return [
    ...base.filter((a) => a !== "claude" && a !== "local"),
    ...base.filter((a) => a === "claude"),
    ...base.filter((a) => a === "local"),
  ];
}

export function available(agent, { write, role } = {}, home) {
  const s = loadSettings();
  if (s.freeMode && (agent === "codex" || agent === "claude" || agent === "gemini")) return false;
  if (role === "research" && (agent === "free" || agent === "local")) return false;
  if (role === "images" && agent !== "codex") return false;
  if (role === "playtest" && agent !== "claude" && agent !== "codex") return false;
  if (inCooldown(agent)) return false;
  const d = doctor()[agent];
  if (!d || !d.installed || !d.signedIn) return false;
  if (agent === "free") return (s.freeMode || s.allowFree) && (!home || s.freeMode || loadTeam(home).allow.free !== false);
  return true;
}

/** Next agent to try after `tried`, skipping unavailable ones, cooldowns, and plans near their limit. */
export function nextAgent({ tried = [], write, role, home } = {}) {
  const candidates = [];
  for (const a of chain()) {
    if (tried.includes(a)) continue;
    if (!available(a, { write, role }, home)) continue;
    if (nearLimit(a, home)) continue;
    candidates.push(a);
  }
  if (!candidates.length) return null;
  if (candidates.includes("claude") && home && claudePacing(home)?.active) {
    const nonClaude = candidates.filter((a) => a !== "claude" && a !== "local");
    if (nonClaude.length) return nonClaude[0];
  }
  return candidates[0];
}
