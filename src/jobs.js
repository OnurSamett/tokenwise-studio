// Job store: each delegated task runs as a child process, optionally in its own git worktree.
import { validateImages } from "./uploads.js";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { command, resolve, textOf } from "./workers.js";
import { loadTeam, ROLES } from "./team.js";
import { RATE_LIMIT, available, nearLimit, nextAgent } from "./fallback.js";
import { notify, jobNotice } from "./notify.js";
import { withProjectNotes } from "./instructions.js";
import { captureImages } from "./jobimages.js";
import { runTests, stopTests, runCombinedCheck, combinedCheckRunning } from "./testrun.js";
import { loadSettings } from "./settings.js";
import { createSnapshot, captureFileStates, restoreSnapshot } from "./snapshots.js";
import { checkJobConflicts, rebaseJob, resolveJobConflicts } from "./conflicts.js";

// Build/run artifacts that should never end up in a worker's diff, even without a .gitignore.
const ARTIFACTS = ["**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**", "**/node_modules/**", "**/.DS_Store",
  "**/.mypy_cache/**", "**/.ruff_cache/**", "**/target/debug/**", "**/.next/**", "**/coverage/**"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function killGroup(target, sig) {
  const pid = typeof target === "number" ? target : target?.pid;
  if (!(pid > 0)) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

/** Read and parse matching JSON files from `dir`, reusing cached objects when mtimeMs and size are unchanged. */
export function listJsonCached(dir, pattern, cache) {
  const files = fs.readdirSync(dir).filter((f) => pattern.test(f));
  const seen = new Set(files);
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  const out = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      const hit = cache.get(f);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { out.push(hit.data); continue; }
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      cache.set(f, { mtimeMs: st.mtimeMs, size: st.size, data });
      out.push(data);
    } catch (e) {
      if (e?.code === "ENOENT") { cache.delete(f); continue; }
      throw e;
    }
  }
  return out;
}

const hasGitignoreTokenwise = (text) => /^\s*\.tokenwise-studio\/?\s*$/m.test(String(text || ""));

function countProjectFiles(dir) {
  let count = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git" || d.name === ".tokenwise-studio") continue;
    if (d.isDirectory()) count += countProjectFiles(path.join(dir, d.name));
    else count++;
  }
  return count;
}

export function isGitRepo(repo) {
  try { git(repo, "rev-parse", "--is-inside-work-tree"); return true; } catch { return false; }
}

function ensureGitExclude(repo) {
  try {
    const ex = path.join(git(repo, "rev-parse", "--git-common-dir").trim(), "info", "exclude");
    const abs = path.isAbsolute(ex) ? ex : path.join(repo, ex);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    if (!cur.includes(".tokenwise-studio/")) fs.appendFileSync(abs, (cur.endsWith("\n") || !cur ? "" : "\n") + ".tokenwise-studio/\n");
  } catch {}
}

/** Preview git setup for a non-git folder: file count and .gitignore status. */
export function gitSetupPreview(repo) {
  const root = path.resolve(repo);
  if (isGitRepo(root)) throw new Error("this folder is already a git repository");
  const giPath = path.join(root, ".gitignore");
  let hasGitignore = false;
  let needsGitignoreEntry = true;
  try {
    const st = fs.lstatSync(giPath);
    if (st.isSymbolicLink()) throw new Error(".gitignore is a symbolic link");
    if (st.isFile()) {
      hasGitignore = true;
      needsGitignoreEntry = !hasGitignoreTokenwise(fs.readFileSync(giPath, "utf8"));
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { isGit: false, fileCount: countProjectFiles(root), hasGitignore, needsGitignoreEntry };
}

/** Initialize git, add .tokenwise-studio/ to .gitignore if missing, and create the initial commit. */
export function setupGit(repo) {
  const root = path.resolve(repo);
  const preview = gitSetupPreview(root);
  const giPath = path.join(root, ".gitignore");
  let gitignoreUpdated = false;
  if (!preview.hasGitignore) {
    fs.writeFileSync(giPath, ".tokenwise-studio/\n");
    gitignoreUpdated = true;
  } else if (preview.needsGitignoreEntry) {
    const cur = fs.readFileSync(giPath, "utf8");
    const sep = cur && !cur.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(giPath, `${cur}${sep}.tokenwise-studio/\n`);
    gitignoreUpdated = true;
  }
  git(root, "init", "-q");
  ensureGitExclude(root);
  git(root, "add", "-A");
  const staged = git(root, "diff", "--cached", "--name-only").trim();
  let hasName = false, hasEmail = false;
  try { hasName = !!git(root, "config", "user.name").trim(); } catch {}
  try { hasEmail = !!git(root, "config", "user.email").trim(); } catch {}
  const idArgs = [
    ...(hasName ? [] : ["-c", "user.name=tokenwise studio"]),
    ...(hasEmail ? [] : ["-c", "user.email=studio@localhost"]),
  ];
  execFileSync(
    "git",
    ["-C", root, ...idArgs, "commit", "-q", "-m", "Initial commit", ...(staged ? [] : ["--allow-empty"])],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const sha = git(root, "rev-parse", "--short", "HEAD").trim();
  return { ok: true, isGit: true, sha, fileCount: preview.fileCount, gitignoreUpdated };
}

export class Jobs {
  constructor(repo) {
    this.repo = path.resolve(repo);
    this.home = path.join(this.repo, ".tokenwise-studio");
    for (const d of ["jobs", "logs", "worktrees"]) fs.mkdirSync(path.join(this.home, d), { recursive: true });
    this.running = new Map(); // id -> { child, done: Promise, discardTimer? }
    this.testing = new Map(); // id -> test-run child process (see testrun.js)
    this.combinedChecking = null; // { active, child } for main-tree combined check
    this._listCache = new Map(); // filename -> { mtimeMs, size, data }
    this._usageCache = new Map(); // id -> { offset, sum, found, claude, cost, model }
    // Keep our state folder out of the user's git status.
    if (this.isGit()) ensureGitExclude(this.repo);
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

  save(job) { fs.writeFileSync(this.file(job.id, "job"), JSON.stringify(job, null, 2)); this._listCache.delete(`${job.id}.json`); return job; }
  get(id) {
    const f = this.file(id, "job");
    if (!fs.existsSync(f)) throw new Error(`unknown job ${id}`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  list() {
    return listJsonCached(path.join(this.home, "jobs"), /^[\w-]+\.json$/, this._listCache)
      .sort((a, b) => a.created.localeCompare(b.created));
  }

  isGit() { return isGitRepo(this.repo); }

  start({ agent, model, effort, hint = null, provider = null, task, write = false, role = null, title, timeoutMin = 20, parent = process.env.TOKENWISE_PARENT || null,
    tried = [], movedFrom = null, noFallback = false, images = [] }) {
    if (role !== null && role !== undefined && !ROLES.includes(role)) throw new Error(`unknown role '${role}' (roles: ${ROLES.join(", ")})`);
    if (role === "research" && write) throw new Error("research jobs must be read-only (write=false)");
    if (role === "images" && agent !== "codex") throw new Error("image generation needs Codex");
    const attachments = validateImages(this.repo, images);
    const team = loadTeam(this.home);
    if (agent === "free" && team.allow.free === false) throw new Error("free workers are disabled in the team settings");
    // Before starting: if this plan is near its limit or the worker isn't usable, pick the next one in the chain.
    if (!noFallback) {
      const why = nearLimit(agent, this.home) || (!available(agent, { write, role }, this.home)
        ? (role === "research" && (agent === "free" || agent === "local") ? `${agent} does not support web research` : `${agent} not available`)
        : null);
      if (why) {
        const alt = nextAgent({ tried: [...tried, agent], write, role, home: this.home });
        if (alt) { movedFrom = movedFrom || { agent, reason: why }; tried = [...tried, agent]; agent = alt; model = undefined; hint = null; provider = null; }
      }
    }
    if (role === "research" && (agent === "free" || agent === "local")) {
      throw new Error(`${agent} does not support web research; use claude, gemini or codex`);
    }
    const spec = resolve({ agent, model, effort, hint, provider, allowAstra: team.allow.astra === true });
    const id = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
    let cwd = this.repo, branch = null;
    if (write) {
      if (!this.isGit()) throw new Error("write mode needs the project to be a git repository");
      cwd = path.join(this.home, "worktrees", id);
      branch = `tokenwise/${id}`;
      git(this.repo, "worktree", "add", "-q", "-b", branch, cwd, "HEAD");
    }
    const job = this.save({
      id, title: title || task.slice(0, 80), task, images: attachments.map((i) => i.rel), ...spec, write, role: role || null, cwd, branch, parent,
      tried: [...tried, agent], movedFrom, movedTo: null,
      status: "running", created: new Date().toISOString(), finished: null, exitCode: null,
      final: null, diffStat: null, files: [], pid: null,
    });

    const lastFile = this.file(id, "last");
    const researchNote = role === "research"
      ? "\n\nWeb research requirements:\n- Use web search/fetch to look up current information.\n- Cite facts inline with numbered brackets like [1], [2].\n- End with a \"Sources\" list containing ONLY the real http/https URLs you actually opened."
      : "";
    const { cmd, args, env: extraEnv } = command(spec, { task: withProjectNotes(task, this.repo) + researchNote, cwd, write, role: role || null, lastFile, images: attachments.map((i) => i.abs) });
    const log = fs.createWriteStream(this.file(id, "log"), { flags: "a" });
    const write1 = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line }) + "\n");
    write1("meta", `$ ${cmd} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}`);

    if (attachments.length && !["codex", "claude"].includes(spec.agent)) write1("meta", `${spec.agent}: images are not supported; continuing without images`);

    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(extraEnv || {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
    let killTimer = null;
    const timer = setTimeout(() => {
      write1("meta", `timeout after ${timeoutMin} min, killing`);
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutMin * 60000);

    const done = new Promise((res) => child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const runEntry = this.running.get(id);
      if (runEntry?.discardTimer) clearTimeout(runEntry.discardTimer);
      const j = this.get(id);
      j.exitCode = code; j.finished = new Date().toISOString(); j.pid = null;
      if (j.status === "discarded") {
        Object.assign(j, this.usage(id));
        write1("meta", `exit ${code} (discarded)`);
        log.end();
        this.save(j);
        this.running.delete(id);
        return res(j);
      }
      j.status = code === 0 ? "done" : "failed";
      // Hit a usage/rate limit? Re-run the same task on the next worker in the chain.
      if (j.status === "failed" && !noFallback) {
        let tail = ""; try { tail = fs.readFileSync(this.file(id, "log"), "utf8").slice(-30000); } catch {}
        if (RATE_LIMIT.test(tail)) {
          const alt = nextAgent({ tried: j.tried, write, role: j.role || null, home: this.home });
          if (alt) {
            try {
              const nj = this.start({ agent: alt, effort, task, images: job.images, write, role: j.role || null, title, timeoutMin, parent, tried: j.tried, movedFrom: { id, agent: j.agent, reason: "hit a rate limit" } });
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
          j.files = git(cwd, "diff", "--cached", "--no-renames", "--name-only", "HEAD").split("\n").filter(Boolean);
          fs.writeFileSync(this.file(id, "diff"), git(cwd, "diff", "--cached", "--no-renames", "--binary", "HEAD"));
        } catch (e) { j.diffStat = "diff failed: " + e.message; }
        // Generated images stay viewable after the worktree is gone (Apply or Discard).
        try { if (j.status === "done") j.images = captureImages(this, j, j.files); } catch {}
      }
      write1("meta", `exit ${code}`);
      log.end();
      this.save(j);
      this.running.delete(id);
      // Optional: run the project's tests in the worktree as soon as a write job finishes (setting "Run tests before Apply").
      if (write && j.status === "done" && j.files.length) {
        try { if (loadSettings().runTestsBeforeApply) runTests(this, id).done.catch(() => {}); } catch {}
      }
      if (!j.parent && (j.status === "done" || j.status === "failed")) {
        const n = jobNotice(j, write ? j.files.length : undefined);
        if (n) notify({ ...n, subtitle: path.basename(this.repo), repo: this.repo, key: `job:${id}:${j.status}` });
      }
      res(j);
    }));
    child.on("error", (e) => write1("meta", `spawn error: ${e.message}`));
    this.running.set(id, { child, done });
    return job;
  }

  /** Token/cost totals from this job's own log (incremental by byte offset): Codex turn.completed lines are summed, Claude's final result line is used. */
  usage(id) {
    const f = this.file(id, "log");
    let st;
    try { st = fs.statSync(f); } catch {
      this._usageCache.delete(id);
      return { tokens: null, cost: null };
    }
    let c = this._usageCache.get(id);
    if (!c || st.size < c.offset) {
      c = { offset: 0, sum: { input: 0, cached: 0, output: 0 }, found: false, claude: null, cost: null, model: null };
      this._usageCache.set(id, c);
    }
    const applyLine = (l, target) => {
      if (!l) return;
      let e;
      try { const o = JSON.parse(l); if (o.stream !== "out") return; e = JSON.parse(o.line); } catch { return; }
      if (e && e.type === "free.init" && e.model) { target.model = `${e.model} (${e.provider})`; return; } // the model that actually answered
      if (e && e.type === "free.usage" && e.usage) {
        target.claude = { input: e.usage.prompt_tokens || 0, cached: 0, output: e.usage.completion_tokens || 0 };
        return;
      }
      if (e && e.event === "result" && e.result?.usage) { // antigravity
        const r = e.result.usage;
        // Antigravity's input_tokens already includes the cached part (total = input + output).
        target.claude = { input: r.input_tokens || 0, cached: r.cache_read_tokens || 0, output: (r.output_tokens || 0) + (r.thinking_tokens || 0) };
        return;
      }
      const u = e && e.usage;
      if (!u) return;
      if (e.type === "turn.completed") {
        target.sum.input += u.input_tokens || 0; target.sum.cached += u.cached_input_tokens || 0; target.sum.output += u.output_tokens || 0; target.found = true;
      } else if (e.type === "result") {
        target.claude = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
        target.cost = typeof e.total_cost_usd === "number" ? e.total_cost_usd : null;
      }
    };
    let view = c;
    if (st.size > c.offset) {
      const len = st.size - c.offset;
      const buf = Buffer.allocUnsafe(len);
      const fd = fs.openSync(f, "r");
      let bytesRead = 0;
      try {
        while (bytesRead < len) {
          const n = fs.readSync(fd, buf, bytesRead, len - bytesRead, c.offset + bytesRead);
          if (n === 0) break;
          bytesRead += n;
        }
      } finally { fs.closeSync(fd); }
      const slice = buf.subarray(0, bytesRead);
      const lastNl = slice.lastIndexOf(0x0a);
      const completeLen = lastNl >= 0 ? lastNl + 1 : 0;
      if (completeLen > 0) {
        for (const l of slice.subarray(0, lastNl).toString("utf8").split("\n")) applyLine(l, c);
        c.offset += completeLen;
      }
      if (completeLen < bytesRead) {
        const tail = slice.subarray(completeLen).toString("utf8");
        view = { sum: { ...c.sum }, found: c.found, claude: c.claude ? { ...c.claude } : null, cost: c.cost, model: c.model };
        applyLine(tail, view);
      }
    }
    const tokens = view.claude ? { ...view.claude } : (view.found ? { ...view.sum } : null);
    return { tokens, cost: view.cost, ...(view.model ? { model: view.model } : {}) };
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

  /** Detect overlaps with other unapplied write jobs and whether the diff applies cleanly to the current tree/index. */
  conflicts(id, files) {
    return checkJobConflicts(this, id, { files });
  }

  /** Re-run a finished write job's diff with `git apply --3way` into a fresh worktree from current HEAD. */
  rebase(id) {
    return rebaseJob(this, id, {
      artifacts: ARTIFACTS,
      onImages: (j) => captureImages(this, j, j.files),
    });
  }

  /** Start a follow-up write job for the same agent with the conflicting files and failed hunks in its task. */
  resolveConflict(id, opts = {}) {
    return resolveJobConflicts(this, id, opts);
  }

  /** Apply the worker's changes (all files, or only `files`) to the main working tree as staged
   *  changes, then remove the worktree. Files not selected are dropped. */
  merge(id, files, { autoCheck = true } = {}) {
    const j = this.get(id);
    if (!j.write) throw new Error("read-only job: nothing to merge");
    if (j.status !== "done") throw new Error(`job is ${j.status}; only finished jobs can be applied`);
    const f = this.file(id, "diff");
    const hasDiff = fs.existsSync(f) && fs.statSync(f).size > 0;
    const pick = hasDiff && Array.isArray(files) && files.length ? files : null;
    if (pick && pick.some((x) => !(j.files || []).includes(x))) throw new Error("unknown file in selection");
    const touched = hasDiff ? (pick || j.files || []) : [];

    if (hasDiff && touched.length) {
      const c = this.conflicts(id, touched);
      if (!c.clean) {
        throw new Error(`cannot apply: conflict in ${c.applyConflicts.map((x) => x.file).join(", ")}`);
      }
    }

    const snapshot = createSnapshot(this.repo, j.id, touched);
    if (hasDiff) {
      const args = ["apply", "--3way", "--whitespace=nowarn", ...(pick ? pick.flatMap((x) => ["--include", x]) : []), f];
      git(this.repo, ...args);
    }
    j.applied = touched;
    j.applySnapshot = snapshot.ref;
    j.applyPost = captureFileStates(this.repo, touched);
    this.cleanup(j);
    j.status = "merged";
    const saved = this.save(j);
    if (autoCheck) {
      try {
        if (loadSettings().checkAfterApply && !combinedCheckRunning(this)) {
          runCombinedCheck(this).done.catch(() => {});
        }
      } catch {}
    }
    return saved;
  }

  /** Restore the files touched by an applied job back to its pre-apply snapshot (index and working tree). */
  undo(id) {
    const j = this.get(id);
    restoreSnapshot(this.repo, j);
    j.status = "undone";
    j.undoneAt = new Date().toISOString();
    return this.save(j);
  }

  discard(id) {
    const j = this.get(id);
    const r = this.running.get(id);
    if (r) {
      killGroup(r.child, "SIGTERM");
      if (r.discardTimer) clearTimeout(r.discardTimer);
      r.discardTimer = setTimeout(() => killGroup(r.child, "SIGKILL"), 5000);
      r.discardTimer.unref?.();
    } else if (j.status === "running" && j.pid) {
      killGroup(j.pid, "SIGTERM");
    }
    if (j.write) this.cleanup(j);
    j.status = "discarded"; return this.save(j);
  }

  cleanup(j) {
    stopTests(this, j.id);
    try { git(this.repo, "worktree", "remove", "--force", j.cwd); } catch {}
    try { git(this.repo, "branch", "-D", j.branch); } catch {}
  }
}
