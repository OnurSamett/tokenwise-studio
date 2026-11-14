// Orchestrator chats: each message runs the main agent (Claude Code headless) with the
// tokenwise-studio MCP tools, so it can delegate to workers. Follow-ups resume the session.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeam, teamGuide } from "./team.js";
import { RATE_LIMIT, available, nearLimit } from "./fallback.js";
import { resolve } from "./workers.js";
import { notify, turnNotice, handoffNotice } from "./notify.js";

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");
const TOOLS = ["delegate", "job_wait", "job_status", "job_diff", "job_merge", "job_discard"].map((t) => `mcp__tokenwise-studio__${t}`);
// No Edit/Write: every change goes through a worker so the user can review it before it lands.
const ALLOWED = [...TOOLS, "Read", "Glob", "Grep",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)",
  "Bash(python3:*)", "Bash(pytest:*)", "Bash(npm test:*)", "Bash(npm run:*)", "Bash(node:*)",
  "Bash(go test:*)", "Bash(cargo test:*)"];

const GUIDE = `You are the ORCHESTRATOR in tokenwise studio. You plan, delegate, review and integrate.
Use the tokenwise-studio tools to hand self-contained pieces to cheaper workers instead of doing them yourself:
- delegate(agent, model, effort, task, write): codex (sol default, terra for simple/mechanical), claude (haiku for search/summaries, sonnet for routine code), gemini (hydrogen for quick and routine work, argon (frontier) for hard problems). Spread work across providers to spare each plan's limits. When plans run low, jobs move automatically to the next worker (ending with 'local', a free Ollama model); mention such moves in your summary.
- Pick effort from: many interacting parts, ambiguity, prior failure, costly mistake. 0 signals -> low, 1 -> medium, 2+ -> high.
- write=true for edits: the worker gets its own git worktree from HEAD. Then job_wait and review every job_diff.
- The USER applies changes from the studio UI. Do NOT call job_merge unless the user explicitly asks you to apply/merge. job_discard work that is clearly wrong, and tell the user which jobs are ready to apply and why.
- Dispatch independent pieces in parallel, then wait for each.
- Workers cannot see this chat: every task must name files, expected behaviour and the done-condition.
- Review every diff: flag unrelated changes, generated files, caches or build output.
- You cannot edit files yourself: every code change, however small, goes to a worker (write=true) so the user can review it. For a tiny change pick the cheapest fitting worker (codex terra low, or claude haiku low). Reading and small investigations you can do yourself.
- Never use astra or max effort unless the user asks.
You already run in the project root: never use cd, &&, pipes or redirects. Your shell is limited to read-only git (status, diff, log), ls, and test runners (python3, pytest, npm test, node, go test, cargo test). To verify combined changes, ask a worker to run the tests.
Finish each turn with a SHORT plain-language summary for a busy user: at most 5 lines, no job ids, no file paths beyond names, no process details. Say what changed, who did it (e.g. "Codex Terra"), and what the user should do next (usually: review and apply in the studio).`;

// ---- Claude -> Codex orchestrator fallback ----
// Codex has no --append-system-prompt, so the guide goes at the top of the prompt.
const CODEX_NOTE = "Your delegation tools are on the tokenwise_studio MCP server. You run read-only: do not try to edit files yourself, delegate every change.";
const CODEX_MODEL = { opus: "sol", sonnet: "sol", haiku: "terra" };
const fallbackEnabled = () => process.env.TOKENWISE_ORCH_FALLBACK !== "0";

/** Codex family + effort that stands in for a Claude orchestrator model. */
export function codexPick(model, effort) {
  const fam = CODEX_MODEL[model] || "sol";
  return { model: fam, effort: effort === "xhigh" ? "high" : effort };
}

const codexReady = (home) => available("codex", { write: false }, home) && !nearLimit("codex", home);

/** Which agent runs this turn? Claude unless it is unavailable or near its plan limit and Codex is free. */
export function pickOrchestrator(home, model, effort) {
  const claude = { agent: "claude", model, effort, reason: null };
  if (!fallbackEnabled()) return claude;
  let why = null;
  // Test hook: TOKENWISE_ORCH_FORCE=codex forces the Codex path regardless of Claude's limits.
  if (process.env.TOKENWISE_ORCH_FORCE === "codex") why = "forced by TOKENWISE_ORCH_FORCE";
  else if (!available("claude", { write: false }, home)) why = "Claude is not available";
  else { const nl = nearLimit("claude", home); if (nl) why = `Claude ${nl}`; }
  if (!why || !codexReady(home)) return claude;
  return { agent: "codex", ...codexPick(model, effort), reason: why };
}

/** Pure decision: should a failed Claude run be re-run on Codex? */
export function shouldHandOff({ agent, code, isError, lines = [], stopped, fallbackEnabled: on = true, codexReady: ready = true }) {
  if (agent !== "claude" || stopped || !on || !ready) return false;
  if (code === 0 && !isError) return false;
  return RATE_LIMIT.test(lines.slice(-50).join("\n"));
}

function codexCommand({ repo, chatId, model, effort, thread, prompt }) {
  const slug = resolve({ agent: "codex", model, effort }).model;
  const cfg = [
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    `mcp_servers.tokenwise_studio.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.tokenwise_studio.args=[${JSON.stringify(MCP)}]`,
    `mcp_servers.tokenwise_studio.env={TOKENWISE_REPO=${JSON.stringify(repo)},TOKENWISE_PARENT=${JSON.stringify(chatId)}}`,
    `mcp_servers.tokenwise_studio.default_tools_approval_mode="approve"`,
  ].flatMap((v) => ["-c", v]);
  // `exec resume` does not accept -C/--sandbox: cwd comes from spawn, the sandbox from config.
  const args = thread
    ? ["exec", "resume", thread, "--json", "--skip-git-repo-check", "-m", slug, "-c", 'sandbox_mode="read-only"', ...cfg, prompt]
    : ["exec", "--json", "--skip-git-repo-check", "-C", repo, "--sandbox", "read-only", "-m", slug, ...cfg, prompt];
  return { cmd: "codex", args };
}

const clip = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
const NAME = { claude: "Claude", codex: "Codex" };

/** Message plus, when this agent lacks context, the earlier turns handled elsewhere. */
export function buildPrompt(c, ti, agent, message) {
  const prior = c.turns.slice(0, ti).map((t, i) => ({ ...t, i, agent: t.agent || "claude" }));
  const hasSession = agent === "claude" ? !!c.sessionId : !!c.codexThread;
  let missed;
  if (hasSession) {
    let last = -1; prior.forEach((t) => { if (t.agent === agent) last = t.i; });
    missed = prior.filter((t) => t.i > last && t.agent !== agent);
  } else missed = prior;
  if (!missed.length) return message;
  const parts = missed.map((t) => `User: ${t.user}\nAssistant${hasSession ? "" : ` (${NAME[t.agent]})`}: ${t.reply ? clip(t.reply, 1500) : "(no reply)"}`);
  let body = "";
  for (let i = parts.length - 1; i >= 0; i--) { // keep the most recent turns within the cap
    if (body.length + parts[i].length > 12000 && body) break;
    body = parts[i] + (body ? "\n\n" : "") + body;
  }
  const who = hasSession ? NAME[missed[0].agent] : [...new Set(missed.map((t) => NAME[t.agent]))].join(" and ");
  return `Earlier in this chat (handled by ${who}):\n${body}\n\nNew message:\n${message}`;
}

export class Chats {
  constructor(jobs) {
    this.jobs = jobs;
    this.dir = path.join(jobs.home, "chats");
    fs.mkdirSync(this.dir, { recursive: true });
    this.running = new Map();
  }
  f(id, ext) { return path.join(this.dir, `${id}.${ext}`); }
  save(c) { fs.writeFileSync(this.f(c.id, "json"), JSON.stringify(c, null, 2)); return c; }
  get(id) { return JSON.parse(fs.readFileSync(this.f(id, "json"), "utf8")); }
  list() {
    return fs.readdirSync(this.dir).filter((x) => x.endsWith(".json") && !x.endsWith(".mcp.json"))
      .map((x) => JSON.parse(fs.readFileSync(path.join(this.dir, x), "utf8")))
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  send({ id, message, model = "opus", effort = "medium" }) {
    if (!message || !message.trim()) throw new Error("empty message");
    if (!["opus", "sonnet", "haiku"].includes(model)) throw new Error("orchestrator model must be opus, sonnet or haiku");
    if (!["low", "medium", "high", "xhigh"].includes(effort)) throw new Error("effort must be low|medium|high|xhigh");
    let c;
    if (id) {
      c = this.get(id);
      if (this.running.has(id)) throw new Error("the orchestrator is still working on the previous message");
    } else {
      id = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
      c = { id, title: message.slice(0, 70), created: new Date().toISOString(), sessionId: null, turns: [], cost: 0 };
    }
    c.model = model; c.effort = effort; c.status = "running";
    const ti = c.turns.length;
    const pick = pickOrchestrator(this.jobs.home, model, effort);
    const turn = { user: message, agent: pick.agent, model: pick.model, effort: pick.effort, started: new Date().toISOString(), finished: null, cost: null };
    if (pick.reason) turn.handoff = { from: "claude", reason: pick.reason };
    c.turns.push(turn);
    this.save(c);

    const mcpFile = this.f(id, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "tokenwise-studio": {
      command: process.execPath, args: [MCP], env: { TOKENWISE_REPO: this.jobs.repo, TOKENWISE_PARENT: id },
    } } }));
    const tg = teamGuide(loadTeam(this.jobs.home));
    const guide = tg ? GUIDE + "\n\n" + tg : GUIDE;

    const log = fs.createWriteStream(this.f(id, "jsonl"), { flags: "a" });
    const w = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line, turn: ti, agent: turn.agent }) + "\n");
    w("user", message);
    if (turn.handoff) w("handoff", JSON.stringify({ from: "claude", to: "codex", reason: turn.handoff.reason }));

    const finish = (code, stopped) => {
      this.running.delete(id);
      const cur = this.get(id);
      cur.sessionId = c.sessionId || cur.sessionId;
      cur.codexThread = c.codexThread || cur.codexThread;
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
    if (turn.handoff) { const n = handoffNotice(turn.handoff.reason); notify({ ...n, subtitle: c.title, repo: this.jobs.repo, key: `handoff:${id}:${ti}` }); }

    const run = (agent) => {
      const t = c.turns[ti];
      const prompt = buildPrompt(c, ti, agent, message);
      let cmd, args;
      if (agent === "codex") {
        ({ cmd, args } = codexCommand({ repo: this.jobs.repo, chatId: id, model: t.model, effort: t.effort, thread: c.codexThread, prompt: `<instructions>\n${guide}\n${CODEX_NOTE}\n</instructions>\n\n${prompt}` }));
      } else {
        cmd = "claude";
        args = ["-p", prompt, "--model", t.model, "--effort", t.effort,
          "--output-format", "stream-json", "--verbose",
          "--mcp-config", mcpFile, "--strict-mcp-config",
          "--permission-mode", "default", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit",
          "--append-system-prompt", guide,
          "--allowedTools", ...ALLOWED];
        if (c.sessionId) args.push("--resume", c.sessionId);
      }
      const child = spawn(cmd, args, { cwd: this.jobs.repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(id, child);
      const buf = { out: "", err: "" };
      const tail = []; // last ~50 lines of output, for rate-limit detection
      let isError = false, spawnFailed = false;
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
              if (e.type === "result") {
                t.cost = e.total_cost_usd || 0; c.cost = (c.cost || 0) + t.cost;
                if (typeof e.result === "string") t.reply = e.result;
                if (e.is_error) isError = true;
              }
            } else {
              if (e.type === "thread.started" && e.thread_id) { c.codexThread = e.thread_id; this.save(c); }
              if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) t.reply = e.item.text;
              if (e.type === "turn.completed" && e.usage) t.tokens = { input: e.usage.input_tokens || 0, cached: e.usage.cached_input_tokens || 0, output: e.usage.output_tokens || 0 };
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
        if (agent === "claude" && !spawnFailed && shouldHandOff({
          agent, code, isError, lines: tail, stopped,
          fallbackEnabled: fallbackEnabled(), codexReady: codexReady(this.jobs.home),
        })) {
          const reason = "hit its usage limit";
          const cx = codexPick(c.turns[ti].model, c.turns[ti].effort);
          Object.assign(t, { agent: "codex", model: cx.model, effort: cx.effort, cost: null, reply: undefined, handoff: { from: "claude", reason } });
          w("meta", `Claude ${reason}; continuing this turn on Codex`);
          w("handoff", JSON.stringify({ from: "claude", to: "codex", reason }));
          this.save(c);
          { const n = handoffNotice(reason); notify({ ...n, subtitle: c.title, repo: this.jobs.repo, key: `handoff:${id}:${ti}` }); }
          run("codex");
          return;
        }
        finish(code, stopped);
      });
    };
    run(turn.agent);
    return c;
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
    for (const ext of ["json", "jsonl", "mcp.json"]) fs.rmSync(this.f(id, ext), { force: true });
    return { ok: true };
  }

  log(id, from = 0) {
    const f = this.f(id, "jsonl");
    if (!fs.existsSync(f)) return { entries: [], next: 0 };
    const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    return { entries: all.slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean), next: all.length };
  }
}
