// Job store: each delegated task runs as a child process, optionally in its own git worktree.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { command, resolve, textOf } from "./workers.js";

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

  start({ agent, model, effort, task, write = false, title, timeoutMin = 20 }) {
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
      id, title: title || task.slice(0, 80), task, ...spec, write, cwd, branch,
      status: "running", created: new Date().toISOString(), finished: null, exitCode: null,
      final: null, diffStat: null,
    });

    const lastFile = this.file(id, "last");
    const { cmd, args } = command(spec, { task, cwd, write, lastFile });
    const log = fs.createWriteStream(this.file(id, "log"), { flags: "a" });
    const write1 = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line }) + "\n");
    write1("meta", `$ ${cmd} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}`);

    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
      j.exitCode = code; j.finished = new Date().toISOString();
      j.status = code === 0 ? "done" : "failed";
      j.final = (fs.existsSync(lastFile) && fs.readFileSync(lastFile, "utf8").trim()) || lastText;
      if (write) {
        try {
          git(cwd, "add", "-A");
          j.diffStat = git(cwd, "diff", "--cached", "--stat", "HEAD").trim() || "(no changes)";
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

  async wait(id, timeoutS = 600) {
    const r = this.running.get(id);
    if (!r) return this.get(id);
    let timer;
    const t = new Promise((res) => { timer = setTimeout(() => res(null), timeoutS * 1000); });
    const out = await Promise.race([r.done, t]);
    clearTimeout(timer);
    return out || this.get(id);
  }

  diff(id) {
    const f = this.file(id, "diff");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }

  /** Apply the worker's changes to the main working tree (uncommitted), then clean up. */
  merge(id) {
    const j = this.get(id);
    if (!j.write) throw new Error("read-only job: nothing to merge");
    if (j.status === "running") throw new Error("job still running");
    const f = this.file(id, "diff");
    if (fs.existsSync(f) && fs.statSync(f).size > 0) git(this.repo, "apply", "--3way", "--whitespace=nowarn", f);
    this.cleanup(j);
    j.status = "merged"; return this.save(j);
  }

  discard(id) {
    const j = this.get(id);
    const r = this.running.get(id); if (r) r.child.kill("SIGTERM");
    if (j.write) this.cleanup(j);
    j.status = "discarded"; return this.save(j);
  }

  cleanup(j) {
    try { git(this.repo, "worktree", "remove", "--force", j.cwd); } catch {}
    try { git(this.repo, "branch", "-D", j.branch); } catch {}
  }
}
