// Per-turn token budget: the orchestrator turn plus the worker jobs started in that turn.
// The UI server writes <chat>.budget (turn start, orchestrator tokens so far); the MCP delegate tool
// reads it, adds the jobs' tokens, and refuses new jobs once the budget is spent.
import fs from "node:fs";
import path from "node:path";

export const BUDGET_STEPS = [0, 50_000, 100_000, 250_000, 500_000];
export const WARN_AT = 0.8;

/** Pure: where is this turn against its budget? state is off | ok | warn (>= 80%) | exceeded (>= 100%). */
export function budgetDecision({ budget, used }) {
  used = Number(used) || 0;
  if (!(budget > 0)) return { state: "off", pct: 0, used, budget: 0 };
  const pct = Math.round((used / budget) * 100);
  return { state: used >= budget ? "exceeded" : used >= budget * WARN_AT ? "warn" : "ok", pct, used, budget };
}

export const tokenSum = (t) => (t ? (t.input || 0) + (t.output || 0) : 0);
export const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));

export const budgetFile = (home, chatId) => path.join(home, "chats", `${chatId}.budget`);

export function readBudgetState(home, chatId) {
  try { return JSON.parse(fs.readFileSync(budgetFile(home, chatId), "utf8")); } catch { return null; }
}
export function writeBudgetState(home, chatId, state) {
  const f = budgetFile(home, chatId), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, f);
}

/** Orchestrator tokens plus every job this chat started since the turn began (running jobs: what their log shows so far). */
export function turnTotal(jobs, chatId, since, orch = 0) {
  let workers = 0;
  for (const j of jobs.list()) {
    if (j.parent !== chatId || j.created < since) continue;
    let t = j.tokens;
    if (j.status === "running") { try { t = jobs.usage(j.id).tokens; } catch {} }
    workers += tokenSum(t);
  }
  return { orch, workers, used: orch + workers };
}

/** Message that rejects a delegate call when the chat's current turn has spent its budget, else null. */
export function budgetGate(jobs, chatId, budget) {
  if (!(budget > 0) || !chatId) return null;
  const st = readBudgetState(jobs.home, chatId);
  if (!st) return null;
  const { used } = turnTotal(jobs, chatId, st.started, st.orch || 0);
  const d = budgetDecision({ budget, used });
  if (d.state !== "exceeded") return null;
  return `The turn token budget is spent (${fmtTokens(used)} of ${fmtTokens(budget)} tokens). Do not start any more jobs this turn: wrap up with what is done and what remains. Running jobs keep going; you may still job_wait, job_diff and job_discard.`;
}
