// Orchestrator chats: each message runs the main agent (Claude Code headless) with the
// tokenwise-studio MCP tools, so it can delegate to workers. Follow-ups resume the session.
import { validateImages, imageNote } from "./uploads.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeam, teamGuide, normalizeTeamOverride, overrideGuide } from "./team.js";
import { normalizeMentions, mentionInfo, mentionGuide } from "../ui/mentions.js";
import { RATE_LIMIT, available, nearLimit, claudePacing, recordProviderCooldown, clearCooldown, getCooldown, formatHHMM } from "./fallback.js";
import { limitResetTime } from "./cooldowns.js";
import { limits } from "./limits.js";
import { resolve, textOf } from "./workers.js";
import { findAgy, agySlug } from "./antigravity.js";
import { freeProviders } from "./freechat.js";
import { runFreeOrchestrator } from "./freeagent.js";
import { doctor } from "./doctor.js";
import { recordGeminiRun } from "./gemini-usage.js";
import { notify, turnNotice, handoffNotice, notifyLimitHandoff } from "./notify.js";
import { ORCH_AGENTS, loadSettings } from "./settings.js";
import { loadInstructions, instructionsGuide } from "./instructions.js";
import { budgetDecision, turnTotal, writeBudgetState, fmtTokens } from "./budget.js";
import { COMPACT_NOTICE, clip, compactChat, lastContextTokens, shouldCompact } from "./compact.js";
import { listJsonCached } from "./jobs.js";
import { getProjectMapSummary } from "./projectmap.js";
import { writeShootoutGate, clearShootoutGate } from "./shootout.js";
import { removeChatFromFolders } from "./folders.js";
import { scrubBase64Images } from "./studioproxy.js";
import { findRojoProject } from "./studiolog.js";
import { locateStudioMcp } from "./studiomcp.js";

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");
const TOOLS = ["delegate", "job_wait", "job_status", "job_diff", "job_merge", "job_discard", "job_test", "project_map"].map((t) => `mcp__tokenwise-studio__${t}`);
// No Edit/Write: every change goes through a worker so the user can review it before it lands.
const ALLOWED = [...TOOLS, "Read", "Glob", "Grep",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)",
  "Bash(python3:*)", "Bash(pytest:*)", "Bash(npm test:*)", "Bash(npm run:*)", "Bash(node:*)",
  "Bash(go test:*)", "Bash(cargo test:*)"];

/** Orchestrator guide for a permission mode, plus (optional) project instructions, turn budget, non-git, project map, and quota pacing rules. */
export function buildGuide(permissionMode = "ask", { instructions = null, turnBudget = 0, isGit = true, pacing = null, allowFree = false, freeMode = null, projectMap = null, shootout = false, mentions = [], robloxPlaytest = null } = {}) {
  const parts = [baseGuide(permissionMode)];
  const isFreeMode = freeMode === null ? Boolean(loadSettings().freeMode) : Boolean(freeMode);
  if (isFreeMode) {
    parts.push("FREE MODE IS ON (no plan usage): only free and local workers are allowed. Do NOT delegate to claude, codex, or gemini — those delegations will be refused. Always pass agent=\"free\" (or agent=\"local\") to delegate.");
  }
  if (robloxPlaytest?.rojo && robloxPlaytest?.studioMcpFound) {
    parts.push("ROBLOX STUDIO PLAYTEST READY: a Rojo project file and StudioMCP were detected. You may start a read-only delegate(..., write=false, role=\"playtest\") job when the user asks to test the game; do NOT request Studio edit, execute_luau, or upload tools.");
  }
  if (!isGit) parts.push("NON-GIT PROJECT: this folder is not a git repository. Write jobs (write=true) require git and will be rejected. Only use read-only jobs (write=false) here; if the user asks for file changes, explain that they can set up git from the studio UI (or run git init and make an initial commit) first.");
  if (turnBudget > 0) parts.push(`TURN TOKEN BUDGET: each turn has about ${fmtTokens(turnBudget)} tokens for you plus all workers. Keep tasks tight. When delegate answers that the budget is spent, start no more jobs: wrap up with what is done and what remains.`);
  if (pacing?.active && !isFreeMode) {
    const prefer = allowFree ? "codex, gemini, or free" : "codex or gemini";
    parts.push(`QUOTA PACING (Save Claude for planning): Claude's ${pacing.window} usage is at ${pacing.pct}% (pacing level ${pacing.threshold}%). You stay on Claude for planning and review; steer worker jobs away from Claude by preferring ${prefer} for delegation instead of claude workers unless no other worker can handle the task.`);
  }
  if (projectMap) {
    parts.push(`Project map available: ${projectMap.scriptCount} scripts, ${projectMap.remoteCount} remotes (${projectMap.projectFile}). Call project_map(prefix?, name?) to inspect instance paths, file paths, exports, remotes, and require edges before delegating.`);
  }
  if (shootout) {
    parts.push("MODEL SHOOTOUT OPTED IN: The user asked for a model shootout in this turn (note: this multiplies token use). Start 2–3 parallel write jobs (write=true) with the same task and a shared shootout parameter (e.g. shootout=\"compare\") across distinct models, wait for them with job_wait, optionally run job_test on each, and summarize the differences — do NOT call job_merge on shootout jobs so the user can pick the best one side by side.");
  } else {
    parts.push("Model shootouts are opt-in by the user only: do NOT pass shootout to delegate.");
  }
  const mg = mentionGuide(mentions);
  if (mg) parts.push(mg);
  const ig = instructionsGuide(instructions);
  if (ig) parts.push(ig);
  return parts.join("\n\n");
}

function baseGuide(permissionMode) {
  const researchRule = "- Web research: for questions that need current web information (latest releases, docs, advisories, prices, news), delegate a read-only job (write=false) with role=\"research\" to a web-capable worker (claude, gemini or codex — not free/local). Instruct the worker to answer with inline numbered citations [1] and end with a \"Sources\" list of the http/https URLs it actually opened (never guessed or unvisited URLs). Keep those inline [1] citations and the Sources list in your reply.";
  const playtestRule = "- Roblox playtesting: when the user asks to test or playtest the game in Roblox Studio, start a READ-ONLY job (write=false, role=\"playtest\"; omit agent to use the configured playtest model, or pass claude/codex). Specify what to test (start play, move/try actions, inspect console, stop play). Playtest jobs expose only read/play/input tools — NEVER ask for place edit, asset upload, or Luau execution tools.";
  if (permissionMode === "plan-only") {
    return `You are the ORCHESTRATOR in tokenwise studio running in PLAN-ONLY mode. You plan, investigate and answer, without making or delegating any file edits.
Use the tokenwise-studio tools to hand read-only research pieces to cheaper workers instead of doing everything yourself:
- delegate(agent, model, effort, task, write=false, role): codex (sol default, terra for simple/mechanical), claude (haiku for search/summaries, sonnet for analysis), gemini (hydrogen for quick and routine work, argon (frontier) for hard problems), free (opt-in hosted APIs: pass model="auto" or a full "nvidia:<id>" from the team options, never a bare alias). Spread work across providers to spare each plan's limits. When plans run low, jobs move automatically to the next worker (ending with 'local', a free Ollama model); mention such moves in your summary.
- Pick effort from: many interacting parts, ambiguity, prior failure, costly mistake. 0 signals -> low, 1 -> medium, 2+ -> high.
- PLAN-ONLY MODE IS ACTIVE: do NOT edit files yourself, do NOT pass write=true to delegate (it will be rejected), and do NOT call job_merge. Only read-only (write=false) delegation is permitted.
${researchRule}
${playtestRule}
- Dispatch independent read-only pieces in parallel, then job_wait each.
- Forward attached images with delegate images: [repo-relative upload paths] to Codex or Claude workers that need them. Other workers continue without images.
- Workers cannot see this chat: every task must name files, expected behaviour and the done-condition.
- Never use astra or max effort unless the user asks.
You already run in the project root: never use cd, &&, pipes or redirects. Your shell is limited to read-only git (status, diff, log), ls, and test runners (python3, pytest, npm test, node, go test, cargo test).
Finish each turn with a SHORT plain-language summary for a busy user: at most 5 lines, no job ids, no file paths beyond names, no process details. Say what you found or planned, who helped (e.g. "Claude Haiku"), and any recommended next steps.`;
  }
  const mergeRule = permissionMode === "auto-apply"
    ? "- After reviewing job_diff, call job_merge yourself when the changes look good (applied changes are staged, not committed). job_discard work that is clearly wrong, and tell the user what you merged."
    : "- The USER applies changes from the studio UI. Do NOT call job_merge unless the user explicitly asks you to apply/merge. job_discard work that is clearly wrong, and tell the user which jobs are ready to apply and why.";
  const reviewTarget = permissionMode === "auto-apply" ? "so you can review and apply it" : "so the user can review it";
  const nextStep = permissionMode === "auto-apply" ? "(usually: review the staged changes or commit)" : "(usually: review and apply in the studio)";
  return `You are the ORCHESTRATOR in tokenwise studio. You plan, delegate, review and integrate.
Use the tokenwise-studio tools to hand self-contained pieces to cheaper workers instead of doing them yourself:
- delegate(agent, model, effort, task, write, role): codex (sol default, terra for simple/mechanical), claude (haiku for search/summaries, sonnet for routine code), gemini (hydrogen for quick and routine work, argon (frontier) for hard problems), free (opt-in hosted APIs: pass model="auto" or a full "nvidia:<id>" from the team options, never a bare alias). Spread work across providers to spare each plan's limits. When plans run low, jobs move automatically to the next worker (ending with 'local', a free Ollama model); mention such moves in your summary.
- Pick effort from: many interacting parts, ambiguity, prior failure, costly mistake. 0 signals -> low, 1 -> medium, 2+ -> high.
- write=true for edits: the worker gets its own git worktree from HEAD. Then job_wait and review every job_diff.
${mergeRule}
${researchRule}
${playtestRule}
- Dispatch independent pieces in parallel, then wait for each.
- Forward attached images with delegate images: [repo-relative upload paths] to Codex or Claude workers that need them. Other workers continue without images.
- Workers cannot see this chat: every task must name files, expected behaviour and the done-condition.
- Review every diff: flag unrelated changes, generated files, caches or build output.
- job_test(id) runs the project's tests in a finished write job's worktree and returns pass/fail plus the end of the output. Use it to check a worker's changes before you call them ready; if it fails, say so (or delegate a fix).
- Image generation (icons, banners, OG images, illustrations, game art) goes to codex, the images role: delegate with write=true and name the output file path (png/jpg/webp). The picture is part of the job's diff and shows inline in the chat as a thumbnail, so do not paste file paths for the user to open; the user applies it like any other file.
- You cannot edit files yourself: every code change, however small, goes to a worker (write=true) ${reviewTarget}. For a tiny change pick the cheapest fitting worker (codex terra low, or claude haiku low). Reading and small investigations you can do yourself.
- Never use astra or max effort unless the user asks.
You already run in the project root: never use cd, &&, pipes or redirects. Your shell is limited to read-only git (status, diff, log), ls, and test runners (python3, pytest, npm test, node, go test, cargo test). To verify combined changes, ask a worker to run the tests.
Finish each turn with a SHORT plain-language summary for a busy user: at most 5 lines, no job ids, no file paths beyond names, no process details. Say what changed, who did it (e.g. "Codex Terra"), and what the user should do next ${nextStep}.`;
}

// ---- Orchestrator fallback chain (claude -> codex -> gemini -> free -> local) ----
// Codex and Gemini have no --append-system-prompt, so the guide goes at the top of the prompt.
const CODEX_NOTE = "Your delegation tools are on the tokenwise_studio MCP server. You run read-only: do not try to edit files yourself, delegate every change.";
const GEMINI_NOTE = (chatId) => `Your delegation tools are on the tokenwise-studio MCP server. Current chat_id is "${chatId}" (pass chat_id: "${chatId}" when calling delegate if needed). You run read-only in plan mode: do not try to edit files yourself, delegate every change.`;
const CODEX_MODEL = { opus: "sol", sonnet: "sol", haiku: "terra", sol: "sol", terra: "terra", luna: "luna", astra: "astra", hydrogen: "terra", argon: "sol", free: "sol", local: "sol" };
const GEMINI_MODEL = { opus: "argon", sonnet: "hydrogen", haiku: "hydrogen", sol: "argon", terra: "hydrogen", luna: "hydrogen", astra: "argon", hydrogen: "hydrogen", argon: "argon", free: "hydrogen", local: "hydrogen" };
export const fallbackEnabled = () => loadSettings().orchFallback !== "off";

export const NAME = { claude: "Claude", codex: "Codex", gemini: "Gemini", free: "Free API", local: "Local" };

/** Map an orchestrator model name to its primary orchestrator agent. */
export function modelToOrchAgent(model) {
  const m = String(model || "opus").trim();
  if (["sol", "terra", "luna", "astra"].includes(m)) return "codex";
  if (["hydrogen", "argon"].includes(m) || m.startsWith("gemini-")) return "gemini";
  if (m === "free" || m === "auto" || m.includes(":")) return "free";
  if (m === "local") return "local";
  return "claude";
}

/** Codex family + effort that stands in for a Claude orchestrator model. */
export function codexPick(model, effort) {
  const fam = CODEX_MODEL[model] || "sol";
  return { model: fam, effort: effort === "xhigh" ? "high" : effort };
}

/** Model + effort pair for a target orchestrator agent. */
export function orchPickFor(agent, model, effort = "medium") {
  const eff = effort === "xhigh" && agent !== "codex" && agent !== "claude" ? "high" : (effort || "medium");
  if (agent === "claude") return { model: ["opus", "sonnet", "haiku"].includes(model) ? model : "sonnet", effort: effort || "medium" };
  if (agent === "codex") return codexPick(model, effort);
  if (agent === "gemini") return { model: GEMINI_MODEL[model] || "hydrogen", effort: eff };
  if (agent === "free") {
    const m = typeof model === "string" && (model === "auto" || model.includes(":")) ? model : "auto";
    return { model: m, effort: eff };
  }
  if (agent === "local") return { model: "local", effort: eff };
  return { model, effort };
}

/** Whether an orchestrator agent is enabled and installed/configured. */
export function orchAvailable(agent, home, settings = loadSettings()) {
  if (settings.freeMode && (agent === "claude" || agent === "codex" || agent === "gemini")) return false;
  if (agent === "gemini") {
    if (!settings.allowGeminiOrchestrator) return false;
    return available("gemini", { write: false }, home);
  }
  if (agent === "free") {
    if (!settings.freeMode && !settings.allowFree) return false;
    return freeProviders().length > 0;
  }
  if (agent === "local") {
    return Boolean(doctor().local?.ready);
  }
  return available(agent, { write: false }, home);
}

/** Whether an orchestrator agent is ready (not cooling down, available, and not near its plan limit). */
export function orchReady(agent, home, settings = loadSettings()) {
  if (getCooldown(agent)) return false;
  if (!orchAvailable(agent, home, settings)) return false;
  if (nearLimit(agent, home)) return false;
  return true;
}

const codexReady = (home) => orchReady("codex", home);

function agentSkipReason(agent, home, settings) {
  const label = NAME[agent] || agent;
  const cd = getCooldown(agent);
  if (cd) {
    return {
      why: `${label} cooling down until ${formatHHMM(cd.until)}`,
      isLimit: true,
      resetsAt: cd.source !== "default" ? cd.until : limitResetTime(agent, limits(home)),
    };
  }
  if (!orchAvailable(agent, home, settings)) {
    return { why: `${label} is not available`, isLimit: false, resetsAt: null };
  }
  const nl = nearLimit(agent, home);
  if (nl) {
    return {
      why: `${label} ${nl}`,
      isLimit: true,
      resetsAt: limitResetTime(agent, limits(home)),
    };
  }
  return null;
}

/** Find the next ready orchestrator in the configured fallback chain. */
export function nextOrchestrator(failedAgent, arg2 = {}, arg3 = {}) {
  const opts = typeof arg2 === "string" ? { home: arg2, ...(arg3 || {}) } : (arg2 || {});
  const { home, model = "opus", effort = "medium", tried = [] } = opts;
  const settings = opts.settings || loadSettings();
  const baseOrder = Array.isArray(settings.orchFallbackOrder) && settings.orchFallbackOrder.length
    ? settings.orchFallbackOrder
    : ORCH_AGENTS;
  const chain = settings.freeMode
    ? baseOrder.filter((a) => a === "free" || a === "local")
    : baseOrder;
  for (const cand of chain) {
    if (cand === failedAgent || tried.includes(cand)) continue;
    if (orchReady(cand, home, settings)) {
      return { agent: cand, ...orchPickFor(cand, model, effort) };
    }
  }
  return null;
}

/** Which agent runs this turn? Walks the orchestrator fallback chain (claude -> codex -> gemini -> free -> local). */
export function pickOrchestrator(home, model = "opus", effort = "medium") {
  if (model && typeof model === "object") {
    ({ model = "opus", effort = "medium" } = model);
  }
  const settings = loadSettings();
  const primary = modelToOrchAgent(model);

  if (settings.freeMode) {
    const baseOrder = Array.isArray(settings.orchFallbackOrder) && settings.orchFallbackOrder.length
      ? settings.orchFallbackOrder.filter((a) => a === "free" || a === "local")
      : ["free", "local"];
    const firstFree = primary === "local" ? ["local", "free"] : (baseOrder.length ? baseOrder : ["free", "local"]);
    for (const cand of firstFree) {
      if (orchReady(cand, home, settings)) {
        const moved = cand !== primary;
        return {
          agent: cand,
          ...orchPickFor(cand, model, effort),
          ...(moved ? { from: primary } : {}),
          reason: moved ? "Free mode — no plan usage" : null,
          isLimit: false,
          resetsAt: null,
          freeMode: true,
        };
      }
    }
    const fallbackFree = primary === "local" ? "local" : "free";
    const moved = fallbackFree !== primary;
    return {
      agent: fallbackFree,
      ...orchPickFor(fallbackFree, model, effort),
      ...(moved ? { from: primary } : {}),
      reason: moved ? "Free mode — no plan usage" : null,
      isLimit: false,
      resetsAt: null,
      freeMode: true,
    };
  }

  const basePick = { agent: primary, ...orchPickFor(primary, model, effort), reason: null, isLimit: false, resetsAt: null };
  if (settings.orchFallback === "off") return basePick;

  const forcedEnv = process.env.TOKENWISE_ORCH_FORCE;
  if (forcedEnv && ORCH_AGENTS.includes(forcedEnv) && forcedEnv !== primary) {
    if (orchReady(forcedEnv, home, settings)) {
      return {
        agent: forcedEnv,
        ...orchPickFor(forcedEnv, model, effort),
        from: primary,
        reason: "forced by TOKENWISE_ORCH_FORCE",
        isLimit: false,
        resetsAt: null,
      };
    }
    return basePick;
  }

  const skip = agentSkipReason(primary, home, settings);
  if (!skip) return basePick;

  const alt = nextOrchestrator(primary, { home, model, effort, tried: [primary] });
  if (!alt) return basePick;
  return {
    agent: alt.agent,
    model: alt.model,
    effort: alt.effort,
    from: primary,
    reason: skip.why,
    isLimit: skip.isLimit,
    resetsAt: skip.resetsAt,
  };
}

/** Pure decision: should a failed orchestrator run be handed off to the next ready orchestrator? */
export function shouldHandOff({ agent, code, isError, lines = [], stopped, fallbackEnabled: on = true, codexReady: ready, nextReady }) {
  const canMove = nextReady !== undefined ? nextReady : (ready !== undefined ? ready : true);
  if (!ORCH_AGENTS.includes(agent) || stopped || !on || !canMove) return false;
  if (code === 0 && !isError) return false;
  return RATE_LIMIT.test(lines.slice(-50).join("\n"));
}

function codexCommand({ repo, chatId, model, effort, thread, prompt, images = [], fastMode = false }) {
  const slug = resolve({ agent: "codex", model, effort }).model;
  const cfg = [
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    ...(fastMode ? ['service_tier="fast"'] : []),
    `mcp_servers.tokenwise_studio.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.tokenwise_studio.args=[${JSON.stringify(MCP)}]`,
    `mcp_servers.tokenwise_studio.env={TOKENWISE_REPO=${JSON.stringify(repo)},TOKENWISE_PARENT=${JSON.stringify(chatId)},TOKENWISE_ORCH_AGENT="codex"}`,
    `mcp_servers.tokenwise_studio.default_tools_approval_mode="approve"`,
  ].flatMap((v) => ["-c", v]);
  // `exec resume` does not accept -C/--sandbox: cwd comes from spawn, the sandbox from config.
  const args = thread
    ? ["exec", "resume", thread, "--json", "--skip-git-repo-check", "-m", slug, "-c", 'sandbox_mode="read-only"', ...cfg, ...images.flatMap((p) => ["-i", p]), "--", prompt]
    : ["exec", "--json", "--skip-git-repo-check", "-C", repo, "--sandbox", "read-only", "-m", slug, ...cfg, ...images.flatMap((p) => ["-i", p]), "--", prompt];
  return { cmd: "codex", args };
}

/** Build the Antigravity (agy) headless invocation for the Gemini orchestrator. */
export function geminiCommand({ repo, chatId, model = "hydrogen", effort = "medium", prompt = "", guide = "" }) {
  const slug = agySlug(model, effort);
  const fullPrompt = `<instructions>\n${guide}\n${GEMINI_NOTE(chatId)}\n</instructions>\n\n${prompt}`;
  const args = [
    "-p", fullPrompt,
    "--model", slug,
    "--mode", "plan",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--print-timeout", "0s",
  ];
  const env = {
    ...process.env,
    TOKENWISE_REPO: repo,
    TOKENWISE_PARENT: chatId,
    TOKENWISE_ORCH_AGENT: "gemini",
  };
  return { cmd: findAgy() || "agy", args, env };
}

function codexThreadCumulative(c, threadId) {
  if (threadId && c.codexUsage?.[threadId]) return c.codexUsage[threadId];
  const sum = { input: 0, cached: 0, output: 0 };
  if (!threadId) return sum;
  const start = c.compaction?.throughTurn || 0;
  for (const pt of (c.turns || []).slice(start)) {
    if (pt?.agent === "codex" && pt.tokens && (!pt.codexThread || pt.codexThread === threadId)) {
      sum.input += pt.tokens.input || 0;
      sum.cached += pt.tokens.cached || 0;
      sum.output += pt.tokens.output || 0;
    }
  }
  return sum;
}

/** Message plus, when this agent lacks context, a compacted summary and/or earlier turns handled elsewhere. */
export function buildPrompt(c, ti, agent, message) {
  const compactEnd = c.compaction?.summary ? (c.compaction.throughTurn ?? 0) : 0;
  const prior = c.turns.slice(0, ti).map((t, i) => ({ ...t, i, agent: t.agent || "claude" }));
  const after = prior.filter((t) => t.i >= compactEnd);
  const hasSession = agent === "claude" ? !!c.sessionId : agent === "codex" ? !!c.codexThread : false;
  let missed;
  if (hasSession) {
    let last = -1; after.forEach((t) => { if (t.agent === agent) last = t.i; });
    missed = after.filter((t) => t.i > last && t.agent !== agent);
  } else missed = after;

  const summaryBlock = !hasSession && c.compaction?.summary
    ? `Earlier conversation summary:\n${c.compaction.summary}`
    : "";

  let handoffBlock = "";
  if (missed.length) {
    const parts = missed.map((t) => `User: ${t.user}\nAssistant${hasSession ? "" : ` (${NAME[t.agent] || t.agent})`}: ${t.reply ? clip(t.reply, 1500) : "(no reply)"}`);
    let body = "";
    for (let i = parts.length - 1; i >= 0; i--) { // keep the most recent turns within the cap
      if (body.length + parts[i].length > 12000 && body) break;
      body = parts[i] + (body ? "\n\n" : "") + body;
    }
    const who = hasSession ? (NAME[missed[0].agent] || missed[0].agent) : [...new Set(missed.map((t) => NAME[t.agent] || t.agent))].join(" and ");
    handoffBlock = `${summaryBlock ? `Recent turns since summary (handled by ${who})` : `Earlier in this chat (handled by ${who})`}:\n${body}`;
  }

  if (!summaryBlock && !handoffBlock) return message;
  return [summaryBlock, handoffBlock, `New message:\n${message}`].filter(Boolean).join("\n\n");
}

export class Chats {
  constructor(jobs, { summarize, spawn: spawnFn, chatFn, freeRunner } = {}) {
    this.jobs = jobs;
    this.dir = path.join(jobs.home, "chats");
    fs.mkdirSync(this.dir, { recursive: true });
    this.running = new Map();
    this.compacting = new Set();
    this._listCache = new Map();
    this.summarizeRunner = summarize;
    this.spawn = spawnFn || spawn;
    this.chatFn = chatFn || null;
    this.freeRunner = freeRunner || runFreeOrchestrator;
  }
  f(id, ext) { return path.join(this.dir, `${id}.${ext}`); }
  save(c) { fs.writeFileSync(this.f(c.id, "json"), JSON.stringify(c, null, 2)); this._listCache.delete(`${c.id}.json`); return c; }
  get(id) { return JSON.parse(fs.readFileSync(this.f(id, "json"), "utf8")); }
  list() {
    return listJsonCached(this.dir, /^(?!.*\.mcp\.json$).+\.json$/, this._listCache)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  send({ id, message, model, effort, images = [], force, explicit, shootout = false, mentions, team: teamOverride } = {}) {
    const settings = loadSettings();
    model = model || settings.defaultModel;
    effort = effort || settings.defaultEffort;
    const attachments = validateImages(this.jobs.repo, images);
    if (typeof message !== "string") throw new Error("message must be a string");
    if (!message.trim() && !attachments.length) throw new Error("empty message");
    const codexModels = ["luna", "terra", "sol", "astra"];
    const geminiModels = ["hydrogen", "argon"];
    const validOrchModel = ["opus", "sonnet", "haiku", ...codexModels, ...geminiModels, "free", "local", "auto"].includes(model)
      || (typeof model === "string" && /^(nvidia|openrouter|groq|mistral|custom):[\w.\/:-]+$/.test(model));
    if (!validOrchModel) throw new Error("unsupported orchestrator model");
    if (!["low", "medium", "high", "xhigh"].includes(effort)) throw new Error("effort must be low|medium|high|xhigh");
    if (force !== undefined && force !== null && !ORCH_AGENTS.includes(force)) throw new Error("force must be codex, claude, gemini, free, or local");
    if (settings.freeMode && (force === "claude" || force === "codex" || force === "gemini")) {
      throw new Error("Free mode is on (no plan usage): paid orchestrators (claude, codex, gemini) are disabled.");
    }
    if (explicit !== undefined && typeof explicit !== "boolean") throw new Error("explicit must be true or false");
    if (shootout !== undefined && typeof shootout !== "boolean") throw new Error("shootout must be true or false");
    const mentionNames = normalizeMentions(mentions);
    if (!settings.freeMode && mentionNames.some((n) => mentionInfo(n).agent === "free") && !(settings.allowFree && loadTeam(this.jobs.home).allow?.free !== false)) {
      throw new Error("Free models are off. Turn them on in Settings (and the team options) to use @free.");
    }
    const roleOverride = normalizeTeamOverride(teamOverride, { allowAstra: !!loadTeam(this.jobs.home).allow?.astra });
    let c;
    if (id) {
      c = this.get(id);
      if (this.running.has(id)) throw new Error("the orchestrator is still working on the previous message");
      if (this.compacting.has(id)) throw new Error("compaction is in progress");
    } else {
      id = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
      c = { id, title: message.slice(0, 70) || "Attached images", created: new Date().toISOString(), sessionId: null, turns: [], cost: 0 };
    }
    const compactNeeded = !!c.turns.length && shouldCompact(c, settings);
    const prevTokens = compactNeeded ? lastContextTokens(c) : 0;
    const chatSnapshot = compactNeeded ? { ...c, turns: c.turns.slice() } : null;
    c.model = model; c.effort = effort; c.status = "running";
    const ti = c.turns.length;
    let pick;
    if (force === "codex") {
      if (available("codex", { write: false }, this.jobs.home)) {
        pick = { agent: "codex", ...(codexModels.includes(model) ? { model, effort } : codexPick(model, effort)), reason: null };
      } else {
        const cd = getCooldown("codex");
        throw new Error(cd ? `Codex is cooling down until ${formatHHMM(cd.until)}.` : "Codex is not available. Sign in to Codex and try again.");
      }
    } else if (force === "claude") {
      pick = { agent: "claude", ...orchPickFor("claude", model, effort), reason: null };
    } else if (force === "gemini") {
      if (orchAvailable("gemini", this.jobs.home, settings) && !getCooldown("gemini")) {
        pick = { agent: "gemini", ...orchPickFor("gemini", model, effort), reason: null };
      } else {
        const cd = getCooldown("gemini");
        throw new Error(cd ? `Gemini is cooling down until ${formatHHMM(cd.until)}.` : "Gemini is not available.");
      }
    } else if (force === "free") {
      if ((orchAvailable("free", this.jobs.home, settings) || this.chatFn) && !getCooldown("free")) {
        pick = { agent: "free", ...orchPickFor("free", model, effort), reason: null };
      } else {
        const cd = getCooldown("free");
        throw new Error(cd ? `Free API is cooling down until ${formatHHMM(cd.until)}.` : "Free API is not available.");
      }
    } else if (force === "local") {
      if ((orchAvailable("local", this.jobs.home, settings) || this.chatFn) && !getCooldown("local")) {
        pick = { agent: "local", ...orchPickFor("local", model, effort), reason: null };
      } else {
        const cd = getCooldown("local");
        throw new Error(cd ? `Local is cooling down until ${formatHHMM(cd.until)}.` : "Local Ollama is not available.");
      }
    } else {
      pick = pickOrchestrator(this.jobs.home, model, effort);
    }
    const turn = { user: message, images: attachments.map((i) => i.rel), agent: pick.agent, model: pick.model, effort: pick.effort, started: new Date().toISOString(), finished: null, cost: null, ...(shootout ? { shootout: true } : {}), ...(mentionNames.length ? { mentions: mentionNames } : {}), ...(roleOverride ? { teamOverride: roleOverride } : {}) };
    if (pick.reason) turn.handoff = { from: pick.from || "claude", reason: pick.reason };
    c.turns.push(turn);
    this.save(c);

    const mcpFile = this.f(id, "mcp.json");
    const writeMcpConfig = (orchAgent) => {
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "tokenwise-studio": {
        command: process.execPath, args: [MCP], env: { TOKENWISE_REPO: this.jobs.repo, TOKENWISE_PARENT: id, TOKENWISE_ORCH_AGENT: orchAgent },
      } } }));
    };
    writeMcpConfig(turn.agent);
    const team = loadTeam(this.jobs.home);
    const allowFree = settings.freeMode || (settings.allowFree && team.allow?.free !== false);
    const pacing = pick.agent === "claude" && !settings.freeMode ? claudePacing(this.jobs.home, { settings }) : null;
    const baseG = buildGuide(settings.permissionMode, {
      instructions: loadInstructions(this.jobs.repo),
      turnBudget: settings.turnBudget,
      isGit: this.jobs.isGit(),
      pacing,
      allowFree,
      freeMode: settings.freeMode,
      projectMap: getProjectMapSummary(this.jobs.repo),
      shootout: !!shootout,
      mentions: mentionNames,
      robloxPlaytest: { rojo: !!findRojoProject(this.jobs.repo), studioMcpFound: !!locateStudioMcp() },
    });
    const tg = [teamGuide(team, { pacing, allowFree, freeMode: settings.freeMode }), overrideGuide(roleOverride, { allowFree })].filter(Boolean).join("\n");
    const guide = tg ? baseG + "\n\n" + tg : baseG;
    const allowedTools = settings.permissionMode === "plan-only" ? ALLOWED.filter((t) => t !== "mcp__tokenwise-studio__job_merge") : ALLOWED;

    const log = fs.createWriteStream(this.f(id, "jsonl"), { flags: "a" });
    const w = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line: scrubBase64Images(line), turn: ti, agent: turn.agent, ...(stream === "user" ? { images: turn.images, ...(turn.mentions ? { mentions: turn.mentions } : {}) } : {}) }) + "\n");
    w("user", message);
    if (turn.handoff) w("handoff", JSON.stringify({ from: turn.handoff.from, to: turn.agent, reason: turn.handoff.reason }));

    // Turn budget: orchestrator tokens so far (live.base + live.run) plus this turn's worker jobs.
    const live = { base: 0, run: 0, warned: false, stopped: false, written: -1 };
    const claudeMsgs = new Map();
    const triedAgents = [];
    try { writeBudgetState(this.jobs.home, id, { turn: ti, started: turn.started, orch: 0 }); } catch {}
    try { writeShootoutGate(this.jobs.home, id, { turn: ti, started: turn.started, allowed: !!shootout }); } catch {}
    const budgetTick = () => {
      try {
        const orch = live.base + live.run;
        if (orch !== live.written) { writeBudgetState(this.jobs.home, id, { turn: ti, started: turn.started, orch }); live.written = orch; }
        const budget = loadSettings().turnBudget;
        if (!(budget > 0) || live.stopped) return;
        const d = budgetDecision({ budget, used: turnTotal(this.jobs, id, turn.started, orch).used });
        const label = `${fmtTokens(d.used)} of ${fmtTokens(budget)} tokens`;
        if (d.state === "exceeded") {
          live.stopped = live.warned = true;
          w("notice", `Turn budget reached (${label}). No new jobs will start this turn; running jobs keep going.`);
        } else if (d.state === "warn" && !live.warned) {
          live.warned = true;
          w("notice", `Turn budget at ${d.pct}% (${label}). New jobs stop at 100%.`);
        }
      } catch {}
    };
    const ticker = setInterval(budgetTick, 2000); ticker.unref();

    const finish = (code, stopped) => {
      clearInterval(ticker); budgetTick();
      try { clearShootoutGate(this.jobs.home, id, ti); } catch {}
      this.running.delete(id);
      const cur = this.get(id);
      cur.sessionId = c.sessionId ?? null;
      cur.codexThread = c.codexThread ?? null;
      if (c.compaction) cur.compaction = c.compaction;
      cur.cost = c.cost; cur.turns = c.turns;
      cur.turns[ti].finished = new Date().toISOString();
      cur.status = cur.status === "stopped" ? "stopped" : code === 0 ? "idle" : "failed";
      w("meta", `orchestrator exited (${code})`);
      log.end();
      this.save(cur);
      const failed = cur.status === "failed";
      let readyJobs = 0;
      try { readyJobs = this.jobs.list().filter((j) => j.parent === id && j.write && j.status === "done" && j.created >= turn.started).length; } catch {}
      const n = turnNotice({ turn: cur.turns[ti], chatTitle: cur.title, failed, stopped: stopped || cur.status === "stopped", readyJobs });
      if (n) notify({ ...n, repo: this.jobs.repo, key: `turn:${id}:${ti}` });
    };
    if (turn.handoff) {
      if (pick.isLimit) notifyLimitHandoff({ provider: turn.handoff.from, toAgent: turn.agent, resetsAt: pick.resetsAt, subtitle: c.title, repo: this.jobs.repo });
      else { const n = handoffNotice(turn.handoff.reason, { fromAgent: turn.handoff.from, toAgent: turn.agent }); notify({ ...n, subtitle: c.title, repo: this.jobs.repo, key: `handoff:${id}:${ti}` }); }
    }

    const attemptMidTurnHandoff = (agent, { code, isError, tail, stopped, spawnFailed, resetsAt }) => {
      if (spawnFailed || force) return false;
      const alt = nextOrchestrator(agent, { home: this.jobs.home, model, effort, tried: triedAgents });
      if (!shouldHandOff({
        agent, code, isError, lines: tail, stopped,
        fallbackEnabled: fallbackEnabled() && !(force && explicit === true),
        nextReady: !!alt,
      })) {
        return false;
      }
      const reason = "hit its usage limit";
      const fromLabel = NAME[agent] || agent;
      const toLabel = NAME[alt.agent] || alt.agent;
      const t = c.turns[ti];
      Object.assign(t, { agent: alt.agent, model: alt.model, effort: alt.effort, cost: null, reply: undefined, handoff: { from: agent, reason } });
      writeMcpConfig(alt.agent);
      live.base += live.run; live.run = 0; claudeMsgs.clear();
      w("meta", `${fromLabel} ${reason}; continuing this turn on ${toLabel}`);
      w("handoff", JSON.stringify({ from: agent, to: alt.agent, reason }));
      this.save(c);
      notifyLimitHandoff({ provider: agent, toAgent: alt.agent, resetsAt, subtitle: c.title, repo: this.jobs.repo });
      run(alt.agent);
      return true;
    };

    const run = (agent) => {
      triedAgents.push(agent);
      const t = c.turns[ti];
      const prompt = buildPrompt(c, ti, agent, message);
      const imagePaths = attachments.map((i) => i.abs);

      if (agent === "free" || agent === "local") {
        const ac = new AbortController();
        this.running.set(id, { kill: () => ac.abort() });
        const tail = [];
        let isError = false;
        Promise.resolve().then(() => this.freeRunner({
          repo: this.jobs.repo,
          jobs: this.jobs,
          chatId: id,
          agent,
          model: t.model,
          guide,
          prompt,
          permissionMode: settings.permissionMode,
          chatFn: this.chatFn,
          signal: ac.signal,
          onUsage: (u) => {
            t.tokens = {
              input: u.prompt_tokens || 0,
              cached: 0,
              output: u.completion_tokens || 0,
            };
            live.run = t.tokens.input + t.tokens.output;
            budgetTick();
          },
          emit: (evt) => {
            const line = JSON.stringify(evt);
            w("out", line);
            tail.push(line);
            if (tail.length > 50) tail.shift();
            if (evt.type === "free.init" && evt.model) {
              t.via = evt.provider ? `${evt.provider}:${evt.model}` : evt.model;
            }
            if (evt.type === "free.message" && typeof evt.text === "string") {
              t.reply = evt.text;
            }
            if (evt.type === "free.usage" && evt.usage) {
              t.tokens = {
                input: evt.usage.prompt_tokens || 0,
                cached: 0,
                output: evt.usage.completion_tokens || 0,
              };
              live.run = t.tokens.input + t.tokens.output;
              budgetTick();
            }
            if (evt.type === "free.error") {
              isError = true;
            }
          },
        })).then((res) => {
          const stopped = ac.signal.aborted || this.get(id).status === "stopped" || Boolean(res?.stopped);
          const code = res?.ok ? 0 : (res?.exitCode ?? 1);
          const tailText = tail.join("\n");
          let resetsAt = null;
          if (!stopped && (code !== 0 || isError) && RATE_LIMIT.test(tailText)) {
            const cd = recordProviderCooldown(agent, { text: tailText, home: this.jobs.home, reason: "hit a rate limit" });
            if (cd && cd.source !== "default") resetsAt = cd.until;
          } else if (!stopped && code === 0 && !isError) {
            clearCooldown(agent);
          }
          if (attemptMidTurnHandoff(agent, { code, isError, tail, stopped, spawnFailed: false, resetsAt })) return;
          finish(code, stopped);
        }).catch((err) => {
          const stopped = ac.signal.aborted || this.get(id).status === "stopped";
          if (!stopped) w("out", JSON.stringify({ type: "free.error", status: 0, message: String(err?.message || err) }));
          finish(1, stopped);
        });
        return;
      }

      let cmd, args, childEnv = process.env;
      if (agent === "codex") {
        ({ cmd, args } = codexCommand({ repo: this.jobs.repo, chatId: id, model: t.model, effort: t.effort, thread: c.codexThread, images: imagePaths, fastMode: settings.fastMode, prompt: `<instructions>\n${guide}\n${CODEX_NOTE}\n</instructions>\n\n${prompt}` }));
      } else if (agent === "gemini") {
        ({ cmd, args, env: childEnv } = geminiCommand({ repo: this.jobs.repo, chatId: id, model: t.model, effort: t.effort, prompt, guide }));
      } else {
        cmd = "claude";
        args = ["-p", [prompt, imageNote(imagePaths)].filter(Boolean).join("\n\n"), "--model", t.model, "--effort", t.effort,
          "--output-format", "stream-json", "--verbose",
          "--mcp-config", mcpFile, "--strict-mcp-config",
          "--permission-mode", "default", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit",
          "--append-system-prompt", guide,
          ...(settings.fastMode ? ["--settings", JSON.stringify({ fastMode: true })] : []),
          "--allowedTools", ...allowedTools];
        if (c.sessionId) args.push("--resume", c.sessionId);
      }
      const child = this.spawn(cmd, args, { cwd: this.jobs.repo, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(id, child);
      const buf = { out: "", err: "" };
      const tail = []; // last ~50 lines of output, for rate-limit detection
      let isError = false, spawnFailed = false, lastCallCtx = 0;
      const on = (s) => (chunk) => {
        buf[s] += chunk.toString(); let i;
        while ((i = buf[s].indexOf("\n")) >= 0) {
          const line = buf[s].slice(0, i); buf[s] = buf[s].slice(i + 1);
          if (!line.trim()) continue;
          w(s, line);
          tail.push(line); if (tail.length > 50) tail.shift();
          if (s !== "out") continue;
          try {
            const e = JSON.parse(line);
            if (agent === "claude") {
              if (e.session_id && !c.sessionId) { c.sessionId = e.session_id; this.save(c); }
              if (e.type === "assistant" && e.message?.usage) {
                const u = e.message.usage;
                lastCallCtx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                if (e.message.id) { // one entry per API call, repeated per content block
                  claudeMsgs.set(e.message.id, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0));
                  live.run = [...claudeMsgs.values()].reduce((a, b) => a + b, 0);
                }
              }
              if (e.type === "result") {
                if (e.usage) {
                  t.tokens = {
                    input: (e.usage.input_tokens || 0) + (e.usage.cache_creation_input_tokens || 0),
                    cached: e.usage.cache_read_input_tokens || 0,
                    output: e.usage.output_tokens || 0,
                    context: lastCallCtx,
                  };
                  live.run = t.tokens.input + t.tokens.output;
                }
                t.cost = e.total_cost_usd || 0; c.cost = (c.cost || 0) + t.cost;
                if (typeof e.result === "string") t.reply = e.result;
                if (e.is_error) isError = true;
              }
            } else if (agent === "gemini") {
              const txt = textOf(e);
              if (txt) t.reply = txt;
              if (e.event === "result" && e.result) {
                if (e.result.usage) {
                  const u = e.result.usage;
                  t.tokens = {
                    input: u.input_tokens || 0,
                    cached: u.cache_read_tokens || 0,
                    output: (u.output_tokens || 0) + (u.thinking_tokens || 0),
                  };
                  live.run = t.tokens.input + t.tokens.output;
                }
                if (e.result.status && e.result.status !== "SUCCESS") isError = true;
              }
              if (e.type === "error") isError = true;
            } else {
              if (e.type === "thread.started" && e.thread_id) { c.codexThread = e.thread_id; this.save(c); }
              if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) t.reply = e.item.text;
              if (e.type === "turn.completed" && e.usage) {
                const tid = c.codexThread || null;
                const prev = codexThreadCumulative(c, tid);
                const cum = {
                  input: e.usage.input_tokens || 0,
                  cached: e.usage.cached_input_tokens || 0,
                  output: e.usage.output_tokens || 0,
                };
                const delta = {
                  input: Math.max(0, cum.input - prev.input),
                  cached: Math.max(0, cum.cached - prev.cached),
                  output: Math.max(0, cum.output - prev.output),
                };
                t.tokens = {
                  input: (t.tokens?.input || 0) + delta.input,
                  cached: (t.tokens?.cached || 0) + delta.cached,
                  output: (t.tokens?.output || 0) + delta.output,
                };
                if (tid) {
                  t.codexThread = tid;
                  c.codexUsage = { ...(c.codexUsage || {}), [tid]: cum };
                }
                live.run += delta.input + delta.output;
              }
              if (e.type === "turn.failed" || e.type === "error") isError = true;
            }
          } catch {}
        }
      };
      child.stdout.on("data", on("out"));
      child.stderr.on("data", on("err"));
      child.on("error", (e) => { spawnFailed = true; w("meta", `spawn error: ${e.message}`); });
      child.on("close", (code) => {
        const stopped = this.get(id).status === "stopped";
        const tailText = tail.join("\n");
        let resetsAt = null;
        const rateLimited = !stopped && !spawnFailed && (code !== 0 || isError) && RATE_LIMIT.test(tailText);
        if (rateLimited) {
          const cd = recordProviderCooldown(agent, { text: tailText, home: this.jobs.home, reason: "hit a rate limit" });
          if (cd && cd.source !== "default") resetsAt = cd.until;
        } else if (!stopped && !spawnFailed && code === 0 && !isError) {
          clearCooldown(agent);
        }
        if (agent === "gemini" && !stopped && !spawnFailed) {
          recordGeminiRun({ tokens: t.tokens, model: t.model, via: "antigravity", rateLimited });
        }
        if (attemptMidTurnHandoff(agent, { code, isError, tail, stopped, spawnFailed, resetsAt })) return;
        finish(code, stopped);
      });
    };
    if (compactNeeded) {
      const ac = new AbortController();
      this.running.set(id, { kill: () => ac.abort() });
      const chatJobs = (() => { try { return this.jobs.list().filter((j) => j.parent === id); } catch { return []; } })();
      compactChat({
        chat: chatSnapshot,
        jobs: chatJobs,
        runner: this.summarizeRunner,
        repo: this.jobs.repo,
        home: this.jobs.home,
        signal: ac.signal,
      }).then(({ summary, method }) => {
        if (ac.signal.aborted || this.get(id).status === "stopped") return finish(1, true);
        c.sessionId = null;
        c.codexThread = null;
        c.codexUsage = {};
        c.compaction = { summary, at: new Date().toISOString(), throughTurn: ti, method, tokens: prevTokens };
        this.save(c);
        w("compact", JSON.stringify({
          text: COMPACT_NOTICE,
          summary,
          method,
          tokens: prevTokens,
          threshold: settings.compactThreshold,
          throughTurn: ti,
        }));
        run(turn.agent);
      }).catch((err) => {
        if (ac.signal.aborted || err?.name === "AbortError" || this.get(id).status === "stopped") return finish(1, true);
        w("meta", `compaction error: ${err?.message || err}`);
        run(turn.agent);
      });
    } else {
      run(turn.agent);
    }
    return c;
  }

  async compact(id, { runner } = {}) {
    const c = this.get(id);
    if (this.running.has(id) || c.status === "running") throw new Error("cannot compact while the orchestrator is running");
    if (this.compacting.has(id)) throw new Error("compaction is already in progress");
    if (!c.turns?.length) throw new Error("chat has no turns to compact");
    if (c.compaction && (c.compaction.throughTurn ?? 0) >= c.turns.length && !c.sessionId && !c.codexThread) {
      throw new Error("chat is already compacted");
    }
    this.compacting.add(id);
    try {
      const chatJobs = (() => { try { return this.jobs.list().filter((j) => j.parent === id); } catch { return []; } })();
      const tokens = lastContextTokens(c);
      const { summary, method } = await compactChat({
        chat: c,
        jobs: chatJobs,
        runner: runner ?? this.summarizeRunner,
        repo: this.jobs.repo,
        home: this.jobs.home,
      });
      const fresh = this.get(id);
      fresh.sessionId = null;
      fresh.codexThread = null;
      fresh.codexUsage = {};
      fresh.compaction = { summary, at: new Date().toISOString(), throughTurn: fresh.turns.length, method, tokens };
      this.save(fresh);
      const turnIdx = fresh.turns.length - 1;
      const entry = {
        t: Date.now(),
        stream: "compact",
        line: JSON.stringify({
          text: COMPACT_NOTICE,
          summary,
          method,
          tokens,
          threshold: loadSettings().compactThreshold,
          throughTurn: fresh.turns.length,
        }),
        turn: turnIdx,
        agent: fresh.turns[turnIdx]?.agent || "claude",
      };
      fs.appendFileSync(this.f(id, "jsonl"), JSON.stringify(entry) + "\n");
      return fresh;
    } finally {
      this.compacting.delete(id);
    }
  }

  stop(id) {
    const ch = this.running.get(id);
    const c = this.get(id);
    if (ch) { c.status = "stopped"; this.save(c); ch.kill("SIGTERM"); }
    return c;
  }

  rename(id, title) {
    const t = String(title || "").trim();
    if (!t || t.length > 120) throw new Error("title must be 1-120 characters");
    const c = this.get(id);
    c.title = t;
    return this.save(c);
  }

  /** Delete a chat. Its unapplied jobs (running or done) are discarded first. */
  remove(id) {
    const c = this.get(id);
    this.stop(c.id);
    for (const j of this.jobs.list()) {
      if (j.parent === id && (j.status === "running" || j.status === "done")) {
        try { this.jobs.discard(j.id); } catch {}
      }
    }
    for (const ext of ["json", "jsonl", "mcp.json", "budget", "shootout"]) fs.rmSync(this.f(id, ext), { force: true });
    this._listCache.delete(`${id}.json`);
    removeChatFromFolders(this.jobs.home, id);
    return { ok: true };
  }

  log(id, from = 0) {
    const f = this.f(id, "jsonl");
    if (!fs.existsSync(f)) return { entries: [], next: 0 };
    const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    return { entries: all.slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean), next: all.length };
  }
}
