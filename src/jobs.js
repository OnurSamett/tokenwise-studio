// Job store: each delegated task runs as a child process, optionally in its own git worktree.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { command, resolve, textOf } from "./workers.js";
import { RATE_LIMIT, available, nearLimit, nextAgent } from "./fallback.js";

// Build/run artifacts that should never end up in a worker's diff, even without a .gitignore.
const ARTIFACTS = ["**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**", "**/node_modules/**", "**/.DS_Store",
  "**/.mypy_cache/**", "**/.ruff_cache/**", "**/target/debug/**", "**/.next/**", "**/coverage/**"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export class Jobs {
  constructor(repo) {
    this.repo = path.resolve(repo);
    this.home = path.join(this.repo, ".tokenwise-studio");
    for (const d of ["jobs", "logs", "worktrees"]) fs.mkdirSync(path.join(this.home, d), { recursive: true });
    this.running = new Map(); // id -> { child, done: Promise }
    // Keep our state folder out of the user's git status.
    if (this.isGit()) {
      try {
        const ex = path.join(git(this.repo, "rev-parse", "--git-common-dir").trim(), "info", "exclude");
        const abs = path.isAbsolute(ex) ? ex : path.join(this.repo, ex);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
        if (!cur.includes(".tokenwise-studio/")) fs.appendFileSync(abs, (cur.endsWith("\n") || !cur ? "" : "\n") + ".tokenwise-studio/\n");
      } catch {}
    }
  }

  file(id, kind) {
    const [dir, name] = {
      job: ["jobs", `${id}.json`],
      log: ["logs", `${id}.jsonl`],
      diff: ["jobs", `${id}.diff`],
      last: ["jobs", `${id}.last.txt`],
    }[kind];
    return path.join(this.home, dir, name);
  }

  save(job) { fs.writeFileSync(this.file(job.id, "job"), JSON.stringify(job, null, 2)); return job; }
  get(id) {
    const f = this.file(id, "job");
    if (!fs.existsSync(f)) throw new Error(`unknown job ${id}`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  list() {
    return fs.readdirSync(path.join(this.home, "jobs")).filter((f) => /^[\w-]+\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.home, "jobs", f), "utf8")))
      .sort((a, b) => a.created.localeCompare(b.created));
  }

  isGit() { try { git(this.repo, "rev-parse", "--is-inside-work-tree"); return true; } catch { return false; } }

  start({ agent, model, effort, task, write = false, title, timeoutMin = 20, parent = process.env.TOKENWISE_PARENT || null,
    tried = [], movedFrom = null, noFallback = false }) {
    // Before starting: if this plan is near its limit or the worker isn't usable, pick the next one in the chain.
    if (!noFallback) {
      const why = nearLimit(agent, this.home) || (!available(agent, { write }) ? `${agent} not available` : null);
      if (why) {
        const alt = nextAgent({ tried: [...tried, agent], write, home: this.home });
        if (alt) { movedFrom = movedFrom || { agent, reason: why }; tried = [...tried, agent]; agent = alt; model = undefined; }
      }
    }
    const spec = resolve({ agent, model, effort });
    const id = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
    let cwd = this.repo, branch = null;
    if (write) {
      if (!this.isGit()) throw new Error("write mode needs the project to be a git repository");
      cwd = path.join(this.home, "worktrees", id);
      branch = `tokenwise/${id}`;
      git(this.repo, "worktree", "add", "-q", "-b", branch, cwd, "HEAD");
    }
    const job = this.save({
      id, title: title || task.slice(0, 80), task, ...spec, write, cwd, branch, parent,
      tried: [...tried, agent], movedFrom, movedTo: null,
      status: "running", created: new Date().toISOString(), finished: null, exitCode: null,
      final: null, diffStat: null, files: [], pid: null,
    });

    const lastFile = this.file(id, "last");
    const { cmd, args, env: extraEnv } = command(spec, { task, cwd, write, lastFile });
    const log = fs.createWriteStream(this.file(id, "log"), { flags: "a" });
    const write1 = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line }) + "\n");
    write1("meta", `$ ${cmd} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}`);

    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(extraEnv || {}) }, stdio: ["ignore", "pipe", "pipe"] });
    this.save({ ...job, pid: child.pid });
    let lastText = null, buf = { out: "", err: "" };
    const onData = (stream) => (chunk) => {
      buf[stream] += chunk.toString();
      let i;
      while ((i = buf[stream].indexOf("\n")) >= 0) {
        const line = buf[stream].slice(0, i); buf[stream] = buf[stream].slice(i + 1);
        if (!line.trim()) continue;
        write1(stream, line);
        if (stream === "out") { try { const t = textOf(JSON.parse(line)); if (t) lastText = t; } catch { lastText = line; } }
      }
    };
    child.stdout.on("data", onData("out"));
    child.stderr.on("data", onData("err"));
    const timer = setTimeout(() => { write1("meta", `timeout after ${timeoutMin} min, killing`); child.kill("SIGTERM"); }, timeoutMin * 60000);

    const done = new Promise((res) => child.on("close", (code) => {
      clearTimeout(timer);
      const j = this.get(id);
      j.exitCode = code; j.finished = new Date().toISOString(); j.pid = null;
      if (j.status !== "discarded") j.status = code === 0 ? "done" : "failed";
      // Hit a usage/rate limit? Re-run the same task on the next worker in the chain.
      if (j.status === "failed" && !noFallback) {
        let tail = ""; try { tail = fs.readFileSync(this.file(id, "log"), "utf8").slice(-30000); } catch {}
        if (RATE_LIMIT.test(tail)) {
          const alt = nextAgent({ tried: j.tried, write, home: this.home });
          if (alt) {
            try {
              const nj = this.start({ agent: alt, effort, task, write, title, timeoutMin, parent, tried: j.tried, movedFrom: { id, agent: j.agent, reason: "hit a rate limit" } });
              j.status = "moved"; j.movedTo = nj.id;
              write1("meta", `rate limit: moved to ${alt} (${nj.id})`);
            } catch (e) { write1("meta", `fallback failed: ${e.message}`); }
          }
        }
      }
      Object.assign(j, this.usage(id));
      j.final = (fs.existsSync(lastFile) && fs.readFileSync(lastFile, "utf8").trim()) || lastText;
      // Some CLIs answer with local file:// markdown links; keep just the link text.
      if (j.final) j.final = String(j.final).replace(/\[([^\]]+)\]\(file:\/\/[^)]*\)/g, "$1");
      if (write && j.status === "moved") {
        this.cleanup(j); // its replacement job has its own worktree
      } else if (write) {
        try {
          git(cwd, "add", "-A", "--", ".", ...ARTIFACTS.map((x) => `:(exclude,glob)${x}`));
          j.diffStat = git(cwd, "diff", "--cached", "--stat", "HEAD").trim() || "(no changes)";
          j.files = git(cwd, "diff", "--cached", "--name-only", "HEAD").split("\n").filter(Boolean);
          fs.writeFileSync(this.file(id, "diff"), git(cwd, "diff", "--cached", "--binary", "HEAD"));
        } catch (e) { j.diffStat = "diff failed: " + e.message; }
      }
      write1("meta", `exit ${code}`);
      log.end();
      this.save(j);
      this.running.delete(id);
      res(j);
    }));
    child.on("error", (e) => write1("meta", `spawn error: ${e.message}`));
    this.running.set(id, { child, done });
    return job;
  }

  /** Token/cost totals from this job's own log: Codex turn.completed lines are summed, Claude's final result line is used. */
  usage(id) {
    const f = this.file(id, "log");
    const sum = { input: 0, cached: 0, output: 0 };
    let found = false, claude = null, cost = null;
    for (const l of fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n") : []) {
      let e;
      try { const o = JSON.parse(l); if (o.stream !== "out") continue; e = JSON.parse(o.line); } catch { continue; }
      if (e && e.type === "free.usage" && e.usage) {
        claude = { input: e.usage.prompt_tokens || 0, cached: 0, output: e.usage.completion_tokens || 0 };
        continue;
      }
      if (e && e.event === "result" && e.result?.usage) { // antigravity
        const r = e.result.usage;
        // Antigravity's input_tokens already includes the cached part (total = input + output).
        claude = { input: r.input_tokens || 0, cached: r.cache_read_tokens || 0, output: (r.output_tokens || 0) + (r.thinking_tokens || 0) };
        continue;
      }
      const u = e && e.usage;
      if (!u) continue;
      if (e.type === "turn.completed") {
        sum.input += u.input_tokens || 0; sum.cached += u.cached_input_tokens || 0; sum.output += u.output_tokens || 0; found = true;
      } else if (e.type === "result") {
        claude = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        cost = typeof e.total_cost_usd === "number" ? e.total_cost_usd : null;
      }
    }
    return { tokens: claude || (found ? sum : null), cost };
  }

  async wait(id, timeoutS = 600) {
    const r = this.running.get(id);
    if (!r) return this.get(id);
    let timer;
    const t = new Promise((res) => { timer = setTimeout(() => res(null), timeoutS * 1000); });
    const out = await Promise.race([r.done, t]);
    clearTimeout(timer);
    const j = out || this.get(id);
    // Follow a job that was moved to another worker.
    if (j.movedTo) return this.wait(j.movedTo, timeoutS);
    return j;
  }

  diff(id) {
    const f = this.file(id, "diff");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }

  /** Apply the worker's changes (all files, or only `files`) to the main working tree as staged
   *  changes, then remove the worktree. Files not selected are dropped. */
  merge(id, files) {
    const j = this.get(id);
    if (!j.write) throw new Error("read-only job: nothing to merge");
    if (j.status !== "done") throw new Error(`job is ${j.status}; only finished jobs can be applied`);
    const f = this.file(id, "diff");
    if (fs.existsSync(f) && fs.statSync(f).size > 0) {
      const pick = Array.isArray(files) && files.length ? files : null;
      if (pick && pick.some((x) => !(j.files || []).includes(x))) throw new Error("unknown file in selection");
      const args = ["apply", "--3way", "--whitespace=nowarn", ...(pick ? pick.flatMap((x) => ["--include", x]) : []), f];
      git(this.repo, ...args);
      j.applied = pick || j.files;
    }
    this.cleanup(j);
    j.status = "merged"; return this.save(j);
  }

  discard(id) {
    const j = this.get(id);
    const r = this.running.get(id);
    if (r) r.child.kill("SIGTERM");
    else if (j.status === "running" && j.pid) { try { process.kill(j.pid, "SIGTERM"); } catch {} }
    if (j.write) this.cleanup(j);
    j.status = "discarded"; return this.save(j);
  }

  cleanup(j) {
    try { git(this.repo, "worktree", "remove", "--force", j.cwd); } catch {}
    try { git(this.repo, "branch", "-D", j.branch); } catch {}
  }
}
