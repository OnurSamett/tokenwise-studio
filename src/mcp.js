#!/usr/bin/env node
// MCP server: gives the orchestrating agent (e.g. Claude Opus in Claude Code) tools to
// delegate work to Codex / Claude / Gemini workers and review + merge their changes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Jobs } from "./jobs.js";
import { loadTeam, teamGuide, ROLES } from "./team.js";
import { loadSettings } from "./settings.js";
import { budgetGate } from "./budget.js";
import { runTests, testRunning, testTail } from "./testrun.js";

const repo = process.env.TOKENWISE_REPO || process.cwd();
const jobs = new Jobs(repo);
const server = new McpServer({ name: "tokenwise-studio", version: "0.1.0" });

const brief = (j, { includeConflicts = false } = {}) => ({
  id: j.id, status: j.status, agent: j.agent, model: j.model, effort: j.effort, write: j.write, role: j.role || null,
  title: j.title, diffStat: j.diffStat, files: j.files, movedFrom: j.movedFrom || null, movedTo: j.movedTo || null, final: j.final ? String(j.final).slice(0, 4000) : null,
  images: (j.images || []).map((i) => i.path), tests: j.test ? j.test.status : null,
  ...(includeConflicts ? { conflicts: j.write && j.status === "done" ? jobs.conflicts(j.id) : null } : {}),
});
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

server.registerTool("delegate", {
  title: "Delegate a task to a worker agent",
  description: [
    "Start a self-contained task on another AI agent CLI and return a job id immediately (it runs in the background).",
    "agent: 'codex' (models: terra, sol [default], or a full slug; astra is blocked unless the user opted in),",
    "'local' (Ollama model via Codex, free and unlimited, can edit files), 'free' (free hosted models like NVIDIA's Kimi/DeepSeek/GLM via a safe tool loop; reads and, with write=true, edits files; it cannot run commands; opt-in),",
    "'claude' (haiku [default], sonnet, opus) or 'gemini' (via Google Antigravity: hydrogen [default, fast], argon [frontier, strongest]). effort: low|medium|high|xhigh.",
    "write=false: read-only answer. write=true: the worker edits files in its own git worktree branched from HEAD",
    "(uncommitted changes in the main tree are NOT visible to it); review with job_diff, then job_merge or job_discard.",
    "role: optional ('code', 'quick', 'review', 'research', 'images'). Use role='research' with write=false for questions needing current web information (enables web search on claude/codex; free/local are not supported for web research).",
    "The worker cannot see this conversation: put every detail it needs in `task` (files, constraints, done-condition).",
    "Dispatch independent tasks in parallel, then job_wait each.",
    "If a worker's plan is near its usage limit or it hits a rate limit, the job is automatically moved to the next worker (codex → gemini → claude → free → local); job_wait follows the move.",
  ].join(" ") + (teamGuide(loadTeam(jobs.home)) ? "\n\n" + teamGuide(loadTeam(jobs.home)) : ""),
  inputSchema: {
    agent: z.enum(["codex", "claude", "gemini", "local", "free"]),
    task: z.string().min(10),
    images: z.array(z.string()).max(6).optional().describe("Repo-relative paths inside .tokenwise-studio/uploads; forwarded to Codex and Claude"),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    write: z.boolean().optional(),
    role: z.enum(ROLES).optional().describe("Optional job role; pass 'research' (with write=false) for current web research"),
    title: z.string().optional(),
    timeout_min: z.number().int().min(1).max(120).optional(),
  },
}, async (a) => {
  try {
    if (a.role === "research" && a.write) {
      return fail(new Error("research jobs must be read-only (write=false)"));
    }
    if (a.write && loadSettings().permissionMode === "plan-only") {
      return fail(new Error("write jobs are disabled in plan-only mode"));
    }
    const over = budgetGate(jobs, process.env.TOKENWISE_PARENT, loadSettings().turnBudget);
    if (over) return fail(new Error(over));
    return ok(brief(jobs.start({ ...a, timeoutMin: a.timeout_min })));
  } catch (e) { return fail(e); }
});

server.registerTool("job_wait", {
  title: "Wait for a job",
  description: "Wait until a job finishes (or timeout_s passes) and return its status, final answer and diff summary.",
  inputSchema: { id: z.string(), timeout_s: z.number().int().min(1).max(1800).optional() },
}, async ({ id, timeout_s }) => {
  try { return ok(brief(await jobs.wait(id, timeout_s ?? 600))); } catch (e) { return fail(e); }
});

server.registerTool("job_status", {
  title: "List or inspect jobs",
  description: "Without id: list all jobs. With id: one job's status. Finished write jobs include a `conflicts` field (overlaps with other unapplied jobs and apply cleanliness against the current tree) so you can sequence applies.",
  inputSchema: { id: z.string().optional() },
}, async ({ id }) => {
  try {
    return ok(id
      ? brief(jobs.get(id), { includeConflicts: true })
      : jobs.list().map((j) => brief(j, { includeConflicts: true })));
  } catch (e) { return fail(e); }
});

server.registerTool("job_diff", {
  title: "Show a write job's changes",
  description: "Return the unified diff a write job produced and a `conflicts` summary for review before merging.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try {
    const j = jobs.get(id);
    const d = jobs.diff(id);
    const conflicts = j.write && j.status === "done" ? jobs.conflicts(id) : null;
    return ok({ id: j.id, diff: d ? d.slice(0, 60000) : "(no changes)", conflicts });
  } catch (e) { return fail(e); }
});

server.registerTool("job_test", {
  title: "Run a write job's tests",
  description: [
    "Run the project's test command (npm test, pytest -q, go test ./..., cargo test, or the one set in Settings) inside a finished write job's worktree and return pass/fail plus the tail of the output.",
    "Use it to check a worker's changes before telling the user they are ready. It does not change any files in the project. Without rerun, an existing result (for example from the automatic run) is returned as is; a run in progress is waited for.",
  ].join(" "),
  inputSchema: { id: z.string(), rerun: z.boolean().optional(), timeout_s: z.number().int().min(10).max(700).optional() },
}, async ({ id, rerun, timeout_s }) => {
  try {
    let j = jobs.get(id);
    const give = (j) => ok({ id: j.id, status: j.test?.status || "not run", command: j.test?.command || null, exitCode: j.test?.exitCode ?? null,
      durationMs: j.test?.durationMs ?? null, tail: (testTail(jobs, id, 3000) || j.test?.tail || "").slice(-3000) });
    if (!testRunning(j) && !(j.test && j.test.status !== "running" && !rerun)) { j = (await runTests(jobs, id).done) || jobs.get(id); }
    else if (testRunning(j)) {
      const end = Date.now() + (timeout_s ?? 660) * 1000;
      while (testRunning(j) && Date.now() < end) { await new Promise((r) => setTimeout(r, 1000)); j = jobs.get(id); }
    }
    return give(j);
  } catch (e) { return fail(e); }
});

server.registerTool("job_merge", {
  title: "Apply a job's changes",
  description: "Optionally pass `files` to apply only those paths. Apply a finished write job's changes to the main working tree as staged, uncommitted changes (so you can still review or commit) and remove its worktree.",
  inputSchema: { id: z.string(), files: z.array(z.string()).optional() },
}, async ({ id, files }) => {
  try {
    if (loadSettings().permissionMode === "plan-only") return fail(new Error("applying changes is disabled in plan-only mode"));
    return ok(brief(jobs.merge(id, files)));
  } catch (e) { return fail(e); }
});

server.registerTool("job_discard", {
  title: "Discard a job",
  description: "Stop a job if running and delete its worktree and branch without applying anything.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try { return ok(brief(jobs.discard(id))); } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
