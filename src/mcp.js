#!/usr/bin/env node
// MCP server: gives the orchestrating agent (e.g. Claude Opus in Claude Code) tools to
// delegate work to Codex / Claude / Gemini workers and review + merge their changes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Jobs } from "./jobs.js";

const repo = process.env.TOKENWISE_REPO || process.cwd();
const jobs = new Jobs(repo);
const server = new McpServer({ name: "tokenwise-studio", version: "0.1.0" });

const brief = (j) => ({
  id: j.id, status: j.status, agent: j.agent, model: j.model, effort: j.effort, write: j.write,
  title: j.title, diffStat: j.diffStat, files: j.files, movedFrom: j.movedFrom || null, movedTo: j.movedTo || null, final: j.final ? String(j.final).slice(0, 4000) : null,
});
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

server.registerTool("delegate", {
  title: "Delegate a task to a worker agent",
  description: [
    "Start a self-contained task on another AI agent CLI and return a job id immediately (it runs in the background).",
    "agent: 'codex' (models: terra, sol [default], or a full slug; astra is blocked unless the user opted in),",
    "'local' (Ollama model via Codex, free and unlimited, can edit files), 'free' (free hosted models like NVIDIA's Kimi/DeepSeek/GLM via a safe tool loop; can read and, with write=true, edit; opt-in),",
    "'claude' (haiku [default], sonnet, opus) or 'gemini' (via Google Antigravity: hydrogen [default, fast], argon [frontier, strongest]). effort: low|medium|high|xhigh.",
    "write=false: read-only answer. write=true: the worker edits files in its own git worktree branched from HEAD",
    "(uncommitted changes in the main tree are NOT visible to it); review with job_diff, then job_merge or job_discard.",
    "The worker cannot see this conversation: put every detail it needs in `task` (files, constraints, done-condition).",
    "Dispatch independent tasks in parallel, then job_wait each.",
    "If a worker's plan is near its usage limit or it hits a rate limit, the job is automatically moved to the next worker (codex → gemini → claude → free → local); job_wait follows the move.",
  ].join(" "),
  inputSchema: {
    agent: z.enum(["codex", "claude", "gemini", "local", "free"]),
    task: z.string().min(10),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    write: z.boolean().optional(),
    title: z.string().optional(),
    timeout_min: z.number().int().min(1).max(120).optional(),
  },
}, async (a) => {
  try { return ok(brief(jobs.start({ ...a, timeoutMin: a.timeout_min }))); } catch (e) { return fail(e); }
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
  description: "Without id: list all jobs. With id: one job's status.",
  inputSchema: { id: z.string().optional() },
}, async ({ id }) => {
  try { return ok(id ? brief(jobs.get(id)) : jobs.list().map(brief)); } catch (e) { return fail(e); }
});

server.registerTool("job_diff", {
  title: "Show a write job's changes",
  description: "Return the unified diff a write job produced, for review before merging.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try { const d = jobs.diff(id); return ok(d ? d.slice(0, 60000) : "(no changes)"); } catch (e) { return fail(e); }
});

server.registerTool("job_merge", {
  title: "Apply a job's changes",
  description: "Optionally pass `files` to apply only those paths. Apply a finished write job's changes to the main working tree as staged, uncommitted changes (so you can still review or commit) and remove its worktree.",
  inputSchema: { id: z.string(), files: z.array(z.string()).optional() },
}, async ({ id, files }) => {
  try { return ok(brief(jobs.merge(id, files))); } catch (e) { return fail(e); }
});

server.registerTool("job_discard", {
  title: "Discard a job",
  description: "Stop a job if running and delete its worktree and branch without applying anything.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  try { return ok(brief(jobs.discard(id))); } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
