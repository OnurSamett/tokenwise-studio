// Usage aggregation for the Usage drawer: tokens and API-equivalent cost per day and per agent/model,
// from orchestrator turns (chats) and worker jobs. Pure functions; ui.js feeds them chats and jobs.
//
// Cost: Claude runs report total_cost_usd, which is used as is. Everything else is ESTIMATED from the
// rough per-million-token rates below (API list prices are not read from anywhere). Free and local
// models cost nothing. Subscription plans (Claude, ChatGPT Codex) are not billed per token: the cost
// shown is what the same tokens would cost through the API.

// USD per 1M tokens: [input, cached input, output]. Rough, editable, only used when a run reported no cost.
export const RATES = {
  "claude:haiku": [1, 0.1, 5], "claude:sonnet": [3, 0.3, 15], "claude:opus": [5, 0.5, 25],
  "codex:luna": [0.25, 0.025, 2], "codex:terra": [1.25, 0.125, 10], "codex:sol": [1.75, 0.175, 14], "codex:astra": [5, 0.5, 40],
  "gemini:hydrogen": [0.3, 0.03, 2.5], "gemini:flash": [0.3, 0.03, 2.5], "gemini:argon": [1.25, 0.125, 10],
};

const zero = () => ({ input: 0, cached: 0, output: 0, total: 0, cost: 0, estimated: 0 });
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** Which rate row applies: agent plus the model family inside the (possibly long) model string. */
export function rateFor(agent, model) {
  if (agent === "free" || agent === "local") return [0, 0, 0];
  const m = String(model || "").toLowerCase();
  const fam = Object.keys(RATES).filter((k) => k.startsWith(agent + ":")).find((k) => m.includes(k.slice(agent.length + 1)));
  return fam ? RATES[fam] : null;
}

/** { tokens, cost } of one turn or job -> { input, cached, output, total, cost, estimated } (cost in USD). */
export function usageOf({ agent, model, tokens, cost }) {
  const t = tokens || {};
  const u = { input: num(t.input), cached: num(t.cached), output: num(t.output), cost: 0, estimated: 0 };
  u.total = u.input + u.output; // cached reads are tracked but not counted in the total, like the turn budget
  if (typeof cost === "number" && cost > 0) u.cost = cost;
  else {
    const r = rateFor(agent, model);
    if (r) { u.cost = (u.input * r[0] + u.cached * r[1] + u.output * r[2]) / 1e6; u.estimated = u.cost > 0 ? u.cost : 0; }
  }
  return u;
}

const add = (a, b) => { for (const k of ["input", "cached", "output", "total", "cost", "estimated"]) a[k] += b[k]; return a; };

// Job states describe process/lifecycle outcomes, not whether the produced work was correct.
// In particular, "discarded" can mean either a cancelled run or a completed result discarded later.
const jobStats = () => ({ completed: 0, failed: 0, discarded: 0, moved: 0, running: 0, other: 0, durationCount: 0, durationTotalMs: 0, averageDurationMs: null });
function recordJob(stats, job) {
  const status = String(job.status || "");
  const category = ["done", "merged", "undone"].includes(status) ? "completed"
    : ["failed", "discarded", "moved", "running"].includes(status) ? status : "other";
  stats[category]++;
  // A running or partially saved job has no completed elapsed time, even if its data is malformed.
  if (status === "running" || !job.created || !job.finished) return;
  const start = Date.parse(job.created), end = Date.parse(job.finished);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  stats.durationCount++;
  stats.durationTotalMs += end - start;
  stats.averageDurationMs = stats.durationTotalMs / stats.durationCount;
}

/** Local calendar day key YYYY-MM-DD. */
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Clean model label: drop the "(provider)" suffix and any path-like prefix noise for display grouping. */
const modelLabel = (agent, model) => {
  const m = String(model || "").trim();
  if (!m) return "default";
  return agent === "free" ? m : m.split("/").pop();
};

/**
 * @param {{chats: object[], jobs: object[], days?: number, now?: Date}} o
 * @returns {{days: number, byDay: object[], byModel: object[], totals: object}}
 */
export function aggregateUsage({ chats = [], jobs = [], days = 14, now = new Date() } = {}) {
  days = Math.min(90, Math.max(1, Math.floor(num(days)) || 14));
  const keys = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); keys.push(dayKey(d)); }
  const byDay = new Map(keys.map((k) => [k, { date: k, ...zero(), orch: zero(), workers: zero() }]));
  const byModel = new Map();
  const totals = { ...zero(), orch: zero(), workers: zero(), turns: 0, jobs: 0, jobStats: jobStats() };

  const take = (source, when, agent, model, tokens, cost, job = null) => {
    if (source === "orch" && !tokens && !(cost > 0)) return; // turns without usage remain excluded
    if (!when) return;
    const t = new Date(when);
    if (Number.isNaN(t.getTime())) return;
    const day = byDay.get(dayKey(t));
    if (!day) return; // outside the window
    const u = usageOf({ agent, model, tokens, cost });
    add(day, u); add(day[source], u);
    add(totals, u); add(totals[source], u);
    const label = modelLabel(agent, model);
    const key = `${agent}|${label}`;
    const row = byModel.get(key) || { agent, model: label, turns: 0, jobs: 0, ...zero(), jobStats: jobStats() };
    add(row, u);
    if (source === "orch") { row.turns++; totals.turns++; } else { row.jobs++; totals.jobs++; recordJob(row.jobStats, job); recordJob(totals.jobStats, job); }
    byModel.set(key, row);
  };

  for (const c of chats) for (const t of c.turns || []) take("orch", t.started, t.agent || "claude", t.modelUsed || t.model, t.tokens, t.cost);
  for (const j of jobs) take("workers", j.created, j.agent, j.modelUsed || j.model, j.tokens, j.cost, j);

  return {
    days,
    byDay: [...byDay.values()],
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.total - a.total),
    totals,
  };
}
