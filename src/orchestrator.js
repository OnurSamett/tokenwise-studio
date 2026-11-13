// Orchestrator chats: each message runs the main agent (Claude Code headless) with the
// tokenwise-studio MCP tools, so it can delegate to workers. Follow-ups resume the session.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");
const TOOLS = ["delegate", "job_wait", "job_status", "job_diff", "job_merge", "job_discard"].map((t) => `mcp__tokenwise-studio__${t}`);
// No Edit/Write: every change goes through a worker so the user can review it before it lands.
const ALLOWED = [...TOOLS, "Read", "Glob", "Grep",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)",
  "Bash(python3:*)", "Bash(pytest:*)", "Bash(npm test:*)", "Bash(npm run:*)", "Bash(node:*)",
  "Bash(go test:*)", "Bash(cargo test:*)"];

const GUIDE = `You are the ORCHESTRATOR in tokenwise studio. You plan, delegate, review and integrate.
Use the tokenwise-studio tools to hand self-contained pieces to cheaper workers instead of doing them yourself:
- delegate(agent, model, effort, task, write): codex (sol default, terra for simple/mechanical), claude (haiku for search/summaries, sonnet for routine code), gemini (hydrogen for quick and routine work, argon (frontier) for hard problems). Spread work across providers to spare each plan's limits.
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
    c.turns.push({ user: message, model, effort, started: new Date().toISOString(), finished: null, cost: null });
    this.save(c);

    const mcpFile = this.f(id, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "tokenwise-studio": {
      command: process.execPath, args: [MCP], env: { TOKENWISE_REPO: this.jobs.repo, TOKENWISE_PARENT: id },
    } } }));
    const args = ["-p", message, "--model", model, "--effort", effort,
      "--output-format", "stream-json", "--verbose",
      "--mcp-config", mcpFile, "--strict-mcp-config",
      "--permission-mode", "default", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit",
      "--append-system-prompt", GUIDE,
      "--allowedTools", ...ALLOWED];
    if (c.sessionId) args.push("--resume", c.sessionId);

    const log = fs.createWriteStream(this.f(id, "jsonl"), { flags: "a" });
    const w = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line, turn: c.turns.length - 1 }) + "\n");
    w("user", message);
    const child = spawn("claude", args, { cwd: this.jobs.repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    this.running.set(id, child);
    const buf = { out: "", err: "" };
    const on = (s) => (chunk) => {
      buf[s] += chunk.toString(); let i;
      while ((i = buf[s].indexOf("\n")) >= 0) {
        const line = buf[s].slice(0, i); buf[s] = buf[s].slice(i + 1);
        if (!line.trim()) continue;
        w(s, line);
        if (s === "out") {
          try {
            const e = JSON.parse(line);
            if (e.session_id && !c.sessionId) { c.sessionId = e.session_id; this.save(c); }
            if (e.type === "result") { const t = c.turns[c.turns.length - 1]; t.cost = e.total_cost_usd || 0; c.cost = (c.cost || 0) + t.cost; }
          } catch {}
        }
      }
    };
    child.stdout.on("data", on("out"));
    child.stderr.on("data", on("err"));
    child.on("error", (e) => w("meta", `spawn error: ${e.message}`));
    child.on("close", (code) => {
      this.running.delete(id);
      const cur = this.get(id);
      cur.sessionId = c.sessionId || cur.sessionId;
      cur.cost = c.cost; cur.turns = c.turns;
      cur.turns[cur.turns.length - 1].finished = new Date().toISOString();
      cur.status = cur.status === "stopped" ? "stopped" : code === 0 ? "idle" : "failed";
      w("meta", `orchestrator exited (${code})`);
      log.end();
      this.save(cur);
    });
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
