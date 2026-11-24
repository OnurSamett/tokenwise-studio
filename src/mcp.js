#!/usr/bin/env node
// MCP server: gives the orchestrating agent (e.g. Claude Opus in Claude Code) tools to
// delegate work to Codex / Claude / Gemini workers and review + merge their changes.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Jobs } from "./jobs.js";
import { loadTeam, teamGuide, JOB_ROLES } from "./team.js";
import { loadSettings } from "./settings.js";
import { claudePacing } from "./fallback.js";
import { budgetGate } from "./budget.js";
import { runTests, testRunning, testTail } from "./testrun.js";
import { normalizeFreeModelArg } from "./workers.js";
import { queryProjectMap } from "./projectmap.js";
import { resolveTurnShootoutId } from "./shootout.js";
import { resolvePlaytestWorker } from "./playtest.js";

const repo = process.env.TOKENWISE_REPO || process.cwd();
let jobsInstance = null;
const getJobs = () => (jobsInstance ||= new Jobs(repo));
const server = new McpServer({ name: "tokenwise-studio", version: "0.1.0" });

const PAID_AGENTS = new Set(["codex", "claude", "gemini", "cursor"]);

/** Validate and resolve per-chat context from an explicit `chat_id` argument or `TOKENWISE_PARENT` env. */
export function resolveChatId(argChatId, envParent = process.env.TOKENWISE_PARENT, home = null) {
  const envId = envParent ? String(envParent).trim() : null;
  if (argChatId === undefined || argChatId === null || String(argChatId).trim() === "") {
    return envId;
  }
  const id = String(argChatId).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(id)) {
    throw new Error("invalid chat_id format");
  }
  if (envId && id !== envId) {
    throw new Error(`chat_id '${id}' does not match active chat '${envId}'`);
  }
  if (!envId && home) {
    const chatsDir = path.join(home, "chats");
    const exists =
      fs.existsSync(path.join(chatsDir, `${id}.json`)) ||
      fs.existsSync(path.join(chatsDir, `${id}.budget`)) ||
      fs.existsSync(path.join(chatsDir, `${id}.shootout`));
    if (!exists) {
      throw new Error(`unknown chat_id '${id}'`);
    }
  }
  return id;
}

/** Validate delegate arguments and convert bare free model aliases into ranking hints. */
export function prepareDelegateArgs(a, opts = {}) {
  if (!a || typeof a !== "object") throw new Error("delegate arguments must be an object");
  const { playtestOptions: _po, proxyScript: _ps, playtestDir: _pd, skipCheck: _sc, ...clean } = a;
  let next = clean;
  if (next.role === "playtest") {
    const s = opts.settings || loadSettings();
    const pm = opts.playtestModel !== undefined ? opts.playtestModel : s.playtestModel;
    const pw = resolvePlaytestWorker(pm);
    next = { ...next, agent: pw.agent, model: pw.model };
  }
  const freeMode = opts.freeMode !== undefined ? opts.freeMode : (opts.settings || loadSettings()).freeMode;
  if (freeMode && PAID_AGENTS.has(next.agent)) {
    throw new Error(
      `Free mode is on (no plan usage): paid worker '${next.agent}' is disabled. Delegate with agent="free" (model="auto") or agent="local" instead.`,
    );
  }
  if (next.agent !== "free") return next;
  const { model, hint, provider } = normalizeFreeModelArg(next.model);
  return {
    ...next,
    ...(model !== undefined ? { model } : {}),
    ...(hint ? { hint } : {}),
    ...(provider ? { provider } : {}),
  };
}

const briefFor = (jobs, j, { includeConflicts = false, detail = false } = {}) => ({
  id: j.id, status: j.status, agent: j.agent, model: j.model, effort: j.effort, write: j.write, role: j.role || null,
  shootout: j.shootout || null,
  title: j.title, diffStat: j.diffStat, files: Array.isArray(j.files) ? (detail ? j.files : j.files.slice(0, 30)) : j.files, movedFrom: j.movedFrom || null, movedTo: j.movedTo || null, final: j.final ? String(j.final).slice(0, detail ? 12000 : 1200) : null,
  ...(j.final && String(j.final).length > (detail ? 12000 : 1200) ? { finalTruncated: true } : {}),
  ...(Array.isArray(j.files) && j.files.length > 30 && !detail ? { fileCount: j.files.length } : {}),
  images: (j.images || []).map((i) => i.path), tests: j.test ? j.test.status : null,
  ...(j.playtest ? {
    playtest: {
      verdict: j.playtest.verdict,
      summary: j.playtest.summary,
      consoleErrorCount: (j.playtest.consoleErrors || []).length,
      screenshotCount: (j.playtest.screenshots || []).length,
      findingsCount: (j.playtest.findings || []).length,
      stats: j.playtest.stats || null,
    },
  } : {}),
  ...(includeConflicts ? { conflicts: j.write && j.status === "done" ? jobs.conflicts(j.id) : null } : {}),
});
const brief = (j, opts) => briefFor(getJobs(), j, opts);
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

/**
 * Shared orchestrator tool handlers used both by the MCP stdio server and IN-PROCESS by the
 * free-model / local orchestrator runner.
 */
export function createOrchestratorTools({ jobs: jobsOpt = null, parent: parentOpt = undefined, permissionMode: permOpt = null } = {}) {
  const resolveJobs = () => jobsOpt || getJobs();
  const resolvePerm = () => permOpt || (process.env.TOKENWISE_PERMISSION === "plan-only" ? "plan-only" : loadSettings().permissionMode);
  const resolveParent = (argChatId, jobs) => {
    const baseParent = parentOpt !== undefined ? parentOpt : process.env.TOKENWISE_PARENT;
    return resolveChatId(argChatId, baseParent, jobs.home);
  };

  const handlers = {
    async delegate(a = {}) {
      try {
        const jobs = resolveJobs();
        const s = loadSettings();
        const perm = resolvePerm();
        if (a.role === "playtest" && !s.playtestEnabled) {
          return fail(new Error("Roblox playtest is disabled in Settings (enable it under Settings → Roblox)"));
        }
        if (a.role !== "playtest" && !a.agent) {
          return fail(new Error("agent is required"));
        }
        if (a.role === "research" && a.write) {
          return fail(new Error("research jobs must be read-only (write=false)"));
        }
        if (a.role === "playtest" && a.write) {
          return fail(new Error("playtest jobs must be read-only (write=false)"));
        }
        if (a.write && perm === "plan-only") {
          return fail(new Error("write jobs are disabled in plan-only mode"));
        }
        const prepared = prepareDelegateArgs(a, { freeMode: s.freeMode, playtestModel: s.playtestModel, settings: s });
        const chatId = resolveParent(a.chat_id, jobs);
        const over = budgetGate(jobs, chatId, s.turnBudget);
        if (over) return fail(new Error(over));
        let shootoutId = null;
        if (a.shootout !== undefined && a.shootout !== false) {
          if (!a.write) return fail(new Error("shootout jobs must be write jobs (write=true)"));
          shootoutId = resolveTurnShootoutId(jobs.home, chatId, a.shootout, { title: a.title || "", task: a.task });
        }
        return ok(briefFor(jobs, jobs.start({
          ...prepared,
          ...(chatId ? { parent: chatId } : {}),
          fixOf: prepared.fix_of || null,
          timeoutMin: prepared.timeout_min,
          ...(shootoutId ? { shootout: shootoutId, noFallback: true, skipFixDetect: true } : {}),
        })));
      } catch (e) { return fail(e); }
    },

    async job_wait(a = {}) {
      try {
        const jobs = resolveJobs();
        const timeout = a.timeout_s ?? a.timeout_sec ?? 600;
        if (Array.isArray(a.ids)) {
          if (a.ids.length === 1) return ok(briefFor(jobs, await jobs.wait(a.ids[0], timeout)));
          const waited = await Promise.all(a.ids.map((id) => jobs.wait(id, timeout)));
          return ok(waited.map((j) => briefFor(jobs, j)));
        }
        const id = a.id || a.ids;
        if (!id) throw new Error("id is required");
        return ok(briefFor(jobs, await jobs.wait(id, timeout)));
      } catch (e) { return fail(e); }
    },

    async job_status({ id, detail = false } = {}) {
      try {
        const jobs = resolveJobs();
        return ok(id
          ? briefFor(jobs, jobs.get(id), { includeConflicts: true, detail: detail === true })
          : jobs.list().map((j) => briefFor(jobs, j, { includeConflicts: true })));
      } catch (e) { return fail(e); }
    },

    async job_diff({ id } = {}) {
      try {
        const jobs = resolveJobs();
        const j = jobs.get(id);
        const d = jobs.diff(id);
        const conflicts = j.write && j.status === "done" ? jobs.conflicts(id) : null;
        return ok({ id: j.id, diff: d ? d.slice(0, 60000) : "(no changes)", conflicts });
      } catch (e) { return fail(e); }
    },

    async job_test({ id, rerun, timeout_s } = {}) {
      try {
        const jobs = resolveJobs();
        let j = jobs.get(id);
        const give = (job) => ok({
          id: job.id,
          status: job.test?.status || "not run",
          command: job.test?.command || null,
          exitCode: job.test?.exitCode ?? null,
          durationMs: job.test?.durationMs ?? null,
          tail: (testTail(jobs, id, 3000) || job.test?.tail || "").slice(-3000),
        });
        if (!testRunning(j) && !(j.test && j.test.status !== "running" && !rerun)) {
          j = (await runTests(jobs, id, { trustedOnly: true }).done) || jobs.get(id);
        } else if (testRunning(j)) {
          const end = Date.now() + (timeout_s ?? 660) * 1000;
          while (testRunning(j) && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 1000));
            j = jobs.get(id);
          }
        }
        return give(j);
      } catch (e) { return fail(e); }
    },

    async job_merge({ id, files } = {}) {
      try {
        const perm = resolvePerm();
        if (perm === "plan-only") return fail(new Error("applying changes is disabled in plan-only mode"));
        if (perm === "ask") return fail(new Error("applying changes is disabled in ask permission mode (the user reviews and clicks Apply in the UI)"));
        const jobs = resolveJobs();
        return ok(briefFor(jobs, jobs.merge(id, files)));
      } catch (e) { return fail(e); }
    },

    async job_discard({ id } = {}) {
      try {
        const jobs = resolveJobs();
        return ok(briefFor(jobs, jobs.discard(id)));
      } catch (e) { return fail(e); }
    },

    async project_map({ prefix, name, path: pathArg } = {}) {
      try {
        const jobs = resolveJobs();
        const { text } = queryProjectMap(jobs.repo, { prefix: prefix ?? pathArg, name });
        return ok(text);
      } catch (e) { return fail(e); }
    },
  };

  async function callTool(name, args = {}) {
    const fn = handlers[name];
    if (!fn) return { isError: true, text: `error: unknown orchestrator tool ${name}` };
    const res = await fn(args);
    const text = res?.content?.[0]?.text ?? "";
    return { isError: !!res?.isError, text: res?.isError ? `error: ${text}` : text, raw: res };
  }

  return { handlers, callTool };
}

export const ORCH_TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "delegate",
      description: "Start a self-contained task on a worker agent and return a job id immediately. Use write=false for read-only tasks, write=true for edits in an isolated git worktree.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["codex", "claude", "gemini", "cursor", "local", "free"], description: "Worker agent" },
          task: { type: "string", description: "Self-contained prompt for the worker (at least 10 chars)" },
          model: { type: "string", description: "Optional model; for agent='free', pass 'auto' or a full 'nvidia:<id>' / '<provider>:<id>'" },
          effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
          write: { type: "boolean", description: "true = edit files in a git worktree; false = read-only" },
          role: { type: "string", enum: JOB_ROLES },
          title: { type: "string", description: "Short 3-6 word label" },
          fix_of: { type: "string", description: "Optional previous job id for a fix round" },
          shootout: { type: ["boolean", "string"], description: "Optional model shootout group (only when user asked for shootout)" },
          timeout_min: { type: "integer" },
        },
        required: ["agent", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_wait",
      description: "Wait until a job finishes and return its status, final answer, and diff summary.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id returned by delegate" },
          ids: { type: "array", items: { type: "string" }, description: "Optional list of job ids to wait for" },
          timeout_s: { type: "integer", description: "Max seconds to wait (default 600)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_status",
      description: "List all jobs (when id is omitted) or inspect a single job's status and conflicts.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional job id" },
          detail: { type: "boolean", description: "Include more of one job's report and its full file list" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_diff",
      description: "Return the unified diff a write job produced and its conflicts summary.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_test",
      description: "Run the test command the user set for this project in Settings inside a finished write job's worktree. Fails if the user has not set one.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id" },
          rerun: { type: "boolean" },
          timeout_s: { type: "integer" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_merge",
      description: "Apply a finished write job's changes to the main working tree as staged changes.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id" },
          files: { type: "array", items: { type: "string" }, description: "Optional subset of file paths to apply" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_discard",
      description: "Stop a job if running and delete its worktree and branch without applying anything.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_map",
      description: "Read-only: return the cached Rojo project map.",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Optional file path or instance path prefix filter" },
          name: { type: "string", description: "Optional substring filter" },
        },
      },
    },
  },
];

export function getOrchToolSpecs(permissionMode = "ask") {
  if (permissionMode === "plan-only") {
    return ORCH_TOOL_SPECS.filter((t) => t.function.name !== "job_merge");
  }
  return ORCH_TOOL_SPECS;
}

const defaultTools = createOrchestratorTools();

server.registerTool("delegate", {
  title: "Delegate a task to a worker agent",
  description: [
    "Start a self-contained task on another AI agent CLI and return a job id immediately (it runs in the background).",
    "agent: 'codex' (models: terra, sol [default], or a full slug; astra is blocked unless the user opted in),",
    "'local' (Ollama model via Codex, free and unlimited, can edit files), 'free' (free hosted models via a safe tool loop; pass model='auto' [default] or a full 'nvidia:<id>' / '<provider>:<id>' from the team options — never a bare alias like 'deepseek'; reads and, with write=true, edits files; it cannot run commands; opt-in),",
    "'claude' (haiku [default], sonnet, opus), 'gemini' (hydrogen or argon), or 'cursor' (Cursor Agent CLI, auto model; effort is controlled by Cursor). effort: low|medium|high|xhigh.",
    "write=false: read-only answer. write=true: the worker edits files in its own git worktree branched from HEAD",
    "(uncommitted changes in the main tree are NOT visible to it); review with job_diff, then job_merge or job_discard.",
    "role: optional ('code', 'quick', 'review', 'research', 'images', 'playtest'). Use role='research' with write=false for questions needing current web information (enables web search on claude/codex; free/local are not supported for web research). Use role='playtest' with write=false to run a read-only, rate-limited Roblox Studio playtest via StudioMCP (agent optional, defaults to Settings playtest model; claude/codex only; mutating/edit/upload tools are blocked).",
    "The worker cannot see this conversation: put every detail it needs in `task` (files, constraints, done-condition).",
    "Dispatch independent tasks in parallel, then job_wait each.",
    "shootout: optional (true or short group name) to group 2-3 parallel write=true jobs into one side-by-side model shootout; multiplies token use and is ONLY allowed when the user explicitly asked for it in the current turn.",
    "If a worker's plan is near its usage limit or it hits a rate limit, the job is automatically moved to the next worker (codex → gemini → claude → free → local); job_wait follows the move.",
  ].join(" ") + (() => {
    const home = path.join(repo, ".tokenwise-studio");
    const orchAgent = process.env.TOKENWISE_ORCH_AGENT || "claude";
    const s = loadSettings();
    const tg = teamGuide(loadTeam(home), {
      pacing: orchAgent === "claude" ? claudePacing(home, { settings: s }) : null,
      allowFree: s.allowFree,
    });
    return tg ? "\n\n" + tg : "";
  })(),
  inputSchema: {
    agent: z.enum(["codex", "claude", "gemini", "cursor", "local", "free"]).optional().describe("Worker agent (optional for role='playtest', defaults to Settings playtest model)"),
    task: z.string().min(10),
    images: z.array(z.string()).max(6).optional().describe("Repo-relative paths inside .tokenwise-studio/uploads; forwarded to Codex and Claude"),
    model: z.string().optional().describe("Optional model; for agent='free', pass 'auto' or a full 'nvidia:<id>' (or '<provider>:<id>') from team options"),
    effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    write: z.boolean().optional(),
    role: z.enum(JOB_ROLES).optional().describe("Optional job role; pass 'research' (with write=false) for current web research, or 'playtest' (with write=false) for read-only Roblox Studio playtesting"),
    title: z.string().optional(),
    fix_of: z.string().optional().describe("Optional previous job id for a fix round on the same files (passes only previous diff and failing check output)"),
    shootout: z.union([z.boolean(), z.string().min(1).max(80)]).optional().describe("Group parallel write jobs as a model shootout; allowed ONLY when the user asked for a shootout in this turn"),
    timeout_min: z.number().int().min(1).max(120).optional(),
    chat_id: z.string().optional().describe("Optional chat id when provided in the prompt (validated against active chats)"),
  },
}, (a) => defaultTools.handlers.delegate(a));

server.registerTool("job_wait", {
  title: "Wait for a job",
  description: "Wait until a job finishes (or timeout_s passes) and return its status, final answer and diff summary.",
  inputSchema: { id: z.string(), timeout_s: z.number().int().min(1).max(1800).optional() },
}, (a) => defaultTools.handlers.job_wait(a));

server.registerTool("job_status", {
  title: "List or inspect jobs",
  description: "Without id: list all jobs. With id: one job's status. Finished write jobs include a `conflicts` field (overlaps with other unapplied jobs and apply cleanliness against the current tree) so you can sequence applies.",
  inputSchema: { id: z.string().optional(), detail: z.boolean().optional() },
}, (a) => defaultTools.handlers.job_status(a));

server.registerTool("job_diff", {
  title: "Show a write job's changes",
  description: "Return the unified diff a write job produced and a `conflicts` summary for review before merging.",
  inputSchema: { id: z.string() },
}, (a) => defaultTools.handlers.job_diff(a));

server.registerTool("job_test", {
  title: "Run a write job's tests",
  description: [
    "Run the test command the user set for this project in Settings > Tests inside a finished write job's worktree and return pass/fail plus the tail of the output.",
    "It only runs that user-set command (never one detected from the worker's files); if none is set it returns an error, so tell the user to set one or to run the tests from the UI. Do not ask workers to add or change test scripts for it.",
    "It does not change any files in the project. Without rerun, an existing result (for example from a run the user started) is returned as is; a run in progress is waited for.",
  ].join(" "),
  inputSchema: { id: z.string(), rerun: z.boolean().optional(), timeout_s: z.number().int().min(10).max(700).optional() },
}, (a) => defaultTools.handlers.job_test(a));

server.registerTool("job_merge", {
  title: "Apply a job's changes",
  description: "Optionally pass `files` to apply only those paths. Apply a finished write job's changes to the main working tree as staged, uncommitted changes (so you can still review or commit) and remove its worktree.",
  inputSchema: { id: z.string(), files: z.array(z.string()).optional() },
}, (a) => defaultTools.handlers.job_merge(a));

server.registerTool("job_discard", {
  title: "Discard a job",
  description: "Stop a job if running and delete its worktree and branch without applying anything.",
  inputSchema: { id: z.string() },
}, (a) => defaultTools.handlers.job_discard(a));

server.registerTool("project_map", {
  title: "Inspect Roblox Rojo project map",
  description: "Read-only: return the cached Rojo project map (instance path <-> file path, module return keys, exported functions, RemoteEvent/RemoteFunction names, and require() edges), capped at 40 KB. Optional filter by path prefix or name.",
  inputSchema: {
    prefix: z.string().optional().describe("Optional file path or instance path prefix filter (e.g. 'src/server' or 'ReplicatedStorage.Shared')"),
    name: z.string().optional().describe("Optional substring filter across script paths, exports, return keys, remotes, and requires"),
  },
}, (a) => defaultTools.handlers.project_map(a));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
}
