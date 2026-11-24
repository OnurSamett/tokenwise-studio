// Job store: each delegated task runs as a child process, optionally in its own git worktree.
import { gitCommonDir } from "./platform.js";
import { validateImages } from "./uploads.js";
import { spawn, execFileSync, addUntrustedDir } from "./process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command, resolve, textOf } from "./workers.js";
import { loadTeam, ROLES, JOB_ROLES } from "./team.js";
import { allowedToolSet, scrubBase64Images, setStopFlag } from "./studioproxy.js";
import { PLAYTEST_WORKER_SYSTEM_PROMPT, resolvePlaytestWorker, parsePlaytestReport } from "./playtest.js";

export { JOB_ROLES };
const STUDIO_PROXY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "studioproxy.js");
import { RATE_LIMIT, freeWorkerUnavailable, freeWorkerRefused, available, nearLimit, nextAgent, recordProviderCooldown, clearCooldown, getCooldown, formatHHMM } from "./fallback.js";
import { recordGeminiRun } from "./gemini-usage.js";
import { notify, jobNotice } from "./notify.js";
import { withProjectNotes } from "./instructions.js";
import { captureImages } from "./jobimages.js";
import { runTests, stopTests, runCombinedCheck, combinedCheckRunning, testTail, loadCombinedCheck, combinedTail } from "./testrun.js";
import { loadSettings, clampPlaytestLimits } from "./settings.js";
import { createSnapshot, captureFileStates, restoreSnapshot } from "./snapshots.js";
import { checkJobConflicts, rebaseJob, resolveJobConflicts, extractFilePatches } from "./conflicts.js";
import { extractMentionedProjectFiles, withProjectMapSlice } from "./projectmap.js";
import { registerShootoutJob } from "./shootout.js";

// Build/run artifacts that should never end up in a worker's diff, even without a .gitignore.
const ARTIFACTS = ["**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**", "**/node_modules/**", "**/.DS_Store",
  "**/.mypy_cache/**", "**/.ruff_cache/**", "**/target/debug/**", "**/.next/**", "**/coverage/**"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Job records are read from <repo>/.tokenwise-studio/jobs/, which a cloned repository can ship: validate them.
const JOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const isRelPath = (p) => typeof p === "string" && !!p && !path.isAbsolute(p) && !/^[A-Za-z]:|^[\\/]/.test(p) && !p.replace(/\\/g, "/").split("/").includes("..");
const optString = (v) => v === undefined || v === null || typeof v === "string";
/** Basic shape check for a job record loaded from disk. Records that fail it are ignored. */
export function validJobRecord(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return false;
  if (typeof j.id !== "string" || !JOB_ID_RE.test(j.id) || typeof j.created !== "string") return false;
  if (!optString(j.cwd) || !optString(j.branch) || !optString(j.applySnapshot) || !optString(j.status)) return false;
  if (j.pid !== undefined && j.pid !== null && !(Number.isInteger(j.pid) && j.pid > 0)) return false;
  for (const k of ["applied", "files"]) if (j[k] !== undefined && j[k] !== null && !(Array.isArray(j[k]) && j[k].every(isRelPath))) return false;
  return true;
}

/** "lstart command" of a live process (or null): recorded at spawn so a PID from a job file is only signalled if it is still that same process. */
function procIdentity(pid) {
  if (process.platform === "win32" || !(pid > 0)) return null;
  try {
    return execFileSync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

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
    const abs = path.join(gitCommonDir(repo, git(repo, "rev-parse", "--git-common-dir")), "info", "exclude");
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

const MAX_FIX_DIFF_CHARS = 24 * 1024;
const MAX_FIX_CHECK_CHARS = 8 * 1024;
const FAIL_CHECK_STATUSES = new Set(["fail", "error", "timeout"]);

function jobFileMentioned(taskLower, filePath, rojoFiles) {
  const fl = filePath.toLowerCase();
  if (taskLower.includes(fl)) return true;
  if (rojoFiles.has(filePath)) return true;
  const base = path.posix.basename(fl);
  if (!base.startsWith("init.") && base.includes(".")) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^A-Za-z0-9_./\\\\-])${escaped}(?:$|[^A-Za-z0-9_./\\\\-])`).test(taskLower)) return true;
  }
  return false;
}

function failingOutputForJob(jobs, prev) {
  if (prev.test && FAIL_CHECK_STATUSES.has(prev.test.status)) {
    return testTail(jobs, prev.id, MAX_FIX_CHECK_CHARS) || prev.test.tail || "";
  }
  if (prev.status === "merged") {
    const cc = loadCombinedCheck(jobs);
    if (cc && FAIL_CHECK_STATUSES.has(cc.status)) {
      return combinedTail(jobs, MAX_FIX_CHECK_CHARS) || cc.tail || "";
    }
  }
  return testTail(jobs, prev.id, MAX_FIX_CHECK_CHARS) || prev.test?.tail || "";
}

function findFixRound(jobs, { task, write, parent, fixOf, files, skipFixDetect }) {
  if (skipFixDetect) return null;
  if (fixOf) {
    const prev = jobs.get(fixOf);
    const explicitFiles = Array.isArray(files) && files.length ? files : (prev.files || []);
    return { prev, matchedFiles: explicitFiles, failingOutput: failingOutputForJob(jobs, prev) };
  }
  if (!write) return null;

  const taskLower = String(task || "").replace(/\\/g, "/").toLowerCase();
  const rojoFiles = new Set(extractMentionedProjectFiles(jobs.repo, task));
  const explicitSet = Array.isArray(files) && files.length ? new Set(files) : null;
  const cc = loadCombinedCheck(jobs);
  const ccFailed = !!(cc && FAIL_CHECK_STATUSES.has(cc.status));

  const candidates = jobs.list().slice().reverse();
  for (const prev of candidates) {
    if ((parent || null) !== (prev.parent || null)) continue;
    if (!prev.write || !Array.isArray(prev.files) || !prev.files.length) continue;
    if (prev.status !== "done" && prev.status !== "merged" && prev.status !== "failed") continue;

    const overlapping = prev.files.filter((f) => (explicitSet ? explicitSet.has(f) : jobFileMentioned(taskLower, f, rojoFiles)));
    if (!overlapping.length) continue;

    // Only treat as a fix round when the most recent finished write job for these files actually failed a check.
    const testFailed = !!(prev.test && FAIL_CHECK_STATUSES.has(prev.test.status));
    const mergedAndCcFailed = prev.status === "merged" && ccFailed && (!cc.started || !prev.finished || cc.started >= prev.created);
    if (!testFailed && !mergedAndCcFailed) return null;

    return {
      prev,
      matchedFiles: overlapping,
      failingOutput: testFailed ? (testTail(jobs, prev.id, MAX_FIX_CHECK_CHARS) || prev.test?.tail || "") : (combinedTail(jobs, MAX_FIX_CHECK_CHARS) || cc?.tail || ""),
    };
  }
  return null;
}

function buildFixRoundTask({ task, jobs, prev, matchedFiles, failingOutput }) {
  let diffText = jobs.diff(prev.id).trim();
  if (diffText && matchedFiles?.length && prev.files?.length && matchedFiles.length < prev.files.length) {
    const patchMap = extractFilePatches(diffText);
    const filtered = matchedFiles.map((f) => patchMap.get(f)?.patch).filter(Boolean).join("\n");
    if (filtered.trim()) diffText = filtered.trim();
  }
  if (diffText.length > MAX_FIX_DIFF_CHARS) {
    diffText = diffText.slice(0, MAX_FIX_DIFF_CHARS) + "\n...(diff truncated)";
  }
  let checkText = String(failingOutput || "").trim();
  if (checkText.length > MAX_FIX_CHECK_CHARS) {
    checkText = checkText.slice(-MAX_FIX_CHECK_CHARS);
  }
  return [
    task,
    "",
    `Previous diff (job ${prev.id}):`,
    diffText || "(no changes)",
    "",
    "Failing check output:",
    checkText || "(no output)",
  ].join("\n");
}

export class Jobs {
  constructor(repo, { proxyScript = null, playtestDir = null, playtestDiscardGraceMs = 3000 } = {}) {
    this.repo = path.resolve(repo);
    addUntrustedDir(this.repo);
    this.home = path.join(this.repo, ".tokenwise-studio");
    for (const d of ["jobs", "logs", "worktrees"]) fs.mkdirSync(path.join(this.home, d), { recursive: true });
    for (const root of fs.readdirSync(path.join(this.home, "worktrees"))) addUntrustedDir(path.join(this.home, "worktrees", root));
    this.running = new Map(); // id -> { child, done: Promise, discardTimer? }
    this.testing = new Map(); // id -> test-run child process (see testrun.js)
    this.combinedChecking = null; // { active, child } for main-tree combined check
    this._listCache = new Map(); // filename -> { mtimeMs, size, data }
    this._usageCache = new Map(); // id -> { offset, sum, found, claude, cost, model }
    this._testProxyScript = proxyScript || null;
    this._testPlaytestDir = playtestDir || null;
    this._playtestDiscardGraceMs = playtestDiscardGraceMs;
    // Keep our state folder out of the user's git status.
    if (this.isGit()) ensureGitExclude(this.repo);
  }

  file(id, kind) {
    const [dir, name] = {
      job: ["jobs", `${id}.json`],
      log: ["logs", `${id}.jsonl`],
      diff: ["jobs", `${id}.diff`],
      last: ["jobs", `${id}.last.txt`],
      mcp: ["jobs", `${id}.mcp.json`],
    }[kind];
    return path.join(this.home, dir, name);
  }

  save(job) { fs.writeFileSync(this.file(job.id, "job"), JSON.stringify(job, null, 2)); this._listCache.delete(`${job.id}.json`); return job; }
  get(id) {
    if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new Error(`unknown job ${id}`);
    const f = this.file(id, "job");
    if (!fs.existsSync(f)) throw new Error(`unknown job ${id}`);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!validJobRecord(j) || j.id !== id) throw new Error(`invalid job record ${id}`);
    return j;
  }
  list() {
    return listJsonCached(path.join(this.home, "jobs"), /^[\w-]+\.json$/, this._listCache)
      .filter(validJobRecord)
      .sort((a, b) => a.created.localeCompare(b.created));
  }

  isGit() { return isGitRepo(this.repo); }

  start({ agent, model, effort, hint = null, provider = null, task, write = false, role = null, title, timeoutMin = null, parent = process.env.TOKENWISE_PARENT || null,
    tried = [], movedFrom = null, noFallback = false, images = [], fixOf = null, files = null, skipFixDetect = false, shootout = null, playtestOptions = null }) {
    if (role !== null && role !== undefined && !JOB_ROLES.includes(role)) throw new Error(`unknown role '${role}' (roles: ${JOB_ROLES.join(", ")})`);
    if (role === "research" && write) throw new Error("research jobs must be read-only (write=false)");
    if (role === "playtest" && write) throw new Error("playtest jobs must be read-only (write=false)");
    const settings = loadSettings();
    if (role === "playtest") {
      if (process.platform !== "darwin") throw new Error("Roblox playtest is available only on macOS");
      if (!settings.playtestEnabled) {
        throw new Error("Roblox playtest is disabled in Settings (enable it under Settings → Roblox)");
      }
      noFallback = true;
      const pw = resolvePlaytestWorker(settings.playtestModel);
      if (!agent) agent = pw.agent;
      if (!model) model = pw.model;
      if (agent === "codex" && !String(settings.playtestModel || "").startsWith("codex:")) {
        throw new Error("Codex playtest requires playtestModel to be explicitly set to codex:* in Settings (screenshots go to OpenAI)");
      }
    }
    if (settings.freeMode && (agent === "codex" || agent === "claude" || agent === "gemini" || agent === "cursor")) {
      throw new Error(`Free mode is on (no plan usage): paid worker '${agent}' is disabled. Use agent='free' or agent='local' instead.`);
    }
    if (role === "images" && agent !== "codex") throw new Error("image generation needs Codex");
    const attachments = validateImages(this.repo, images);
    const team = loadTeam(this.home);
    if (agent === "free" && !(settings.allowFree || settings.freeMode)) throw new Error("Hosted API workers are disabled. Enable them in Settings first.");
    if (agent === "free" && team.allow.free === false && !settings.freeMode) throw new Error("free workers are disabled in the team settings");
    if (agent === "cursor" && !available("cursor", { write, role }, this.home)) {
      throw new Error("Cursor Agent is not ready. Install the Cursor Agent CLI and run cursor-agent login; check free mode and role settings.");
    }
    // Before starting: if this plan is near its limit, cooling down, or not usable, pick the next one in the chain.
    if (!noFallback && role !== "playtest") {
      const cd = getCooldown(agent);
      const cdWhy = cd ? `cooling down until ${formatHHMM(cd.until)}` : null;
      const why = nearLimit(agent, this.home) || cdWhy || (!available(agent, { write, role }, this.home)
        ? (role === "research" && (agent === "free" || agent === "local") ? `${agent} does not support web research` : `${agent} not available`)
        : null);
      if (why) {
        const alt = nextAgent({ tried: [...tried, agent], write, role, home: this.home });
        if (alt) { movedFrom = movedFrom || { agent, reason: why }; tried = [...tried, agent]; agent = alt; model = undefined; hint = null; provider = null; }
      }
    }
    if (role === "research" && (agent === "free" || agent === "local" || agent === "cursor")) {
      throw new Error(`${agent} does not support web research; use claude, gemini or codex`);
    }
    if (role === "playtest" && agent !== "claude" && agent !== "codex") {
      throw new Error(`${agent} does not support Roblox playtest; use claude or codex`);
    }
    const spec = resolve({ agent, model, effort, hint, provider, allowAstra: team.allow.astra === true });
    const playtestLimits = role === "playtest"
      ? clampPlaytestLimits({
          maxCalls: playtestOptions?.maxCalls ?? settings.playtestMaxCalls,
          maxScreenshots: playtestOptions?.maxScreenshots ?? settings.playtestMaxScreenshots,
          maxMinutes: playtestOptions?.maxMinutes ?? settings.playtestMaxMinutes,
        }, settings)
      : null;
    const effTimeoutMin = role === "playtest"
      ? Math.min(timeoutMin ?? Infinity, playtestLimits.maxMinutes + 2)
      : (timeoutMin ?? 20);
    const fixCtx = findFixRound(this, { task, write, parent, fixOf, files, skipFixDetect });
    const id = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
    let cwd = this.repo, branch = null, trustWorkspace = false;
    if (write) {
      if (!this.isGit()) throw new Error("write mode needs the project to be a git repository");
      cwd = path.join(this.home, "worktrees", id);
      addUntrustedDir(cwd);
      branch = `tokenwise/${id}`;
      git(this.repo, "worktree", "add", "-q", "-b", branch, cwd, "HEAD");
      trustWorkspace = true; // created by Studio just now, in its own managed location
    }
    let playtestCfg = null;
    if (role === "playtest") {
      const playtestDir = typeof this._testPlaytestDir === "function"
        ? this._testPlaytestDir(id)
        : (this._testPlaytestDir || path.join(this.home, "playtests", id));
      fs.mkdirSync(playtestDir, { recursive: true });
      const { maxCalls, maxScreenshots, maxMinutes } = playtestLimits;
      const allowInput = typeof playtestOptions?.allowInput === "boolean"
        ? playtestOptions.allowInput
        : Boolean(settings.playtestAllowInput);
      const proxyScript = this._testProxyScript || STUDIO_PROXY_SCRIPT;
      const proxyArgs = [
        proxyScript,
        "--playtest-id", id,
        "--playtest-dir", playtestDir,
        "--repo", this.repo,
        "--max-calls", String(maxCalls),
        "--max-screenshots", String(maxScreenshots),
        "--max-minutes", String(maxMinutes),
        ...(allowInput ? ["--allow-input"] : ["--no-input"]),
      ];
      const mcpConfigFile = this.file(id, "mcp");
      if (spec.agent === "claude") {
        fs.writeFileSync(mcpConfigFile, JSON.stringify({
          mcpServers: {
            "roblox-playtest": { command: process.execPath, args: proxyArgs },
          },
        }, null, 2));
      }
      const codexHome = spec.agent === "codex" ? fs.mkdtempSync(path.join(os.tmpdir(), "tw-codex-playtest-")) : null;
      playtestCfg = {
        repo: this.repo,
        playtestDir,
        mcpConfigFile,
        codexHome,
        proxyArgs,
        maxCalls,
        allowedTools: [...allowedToolSet({ allowInput })],
        systemPrompt: PLAYTEST_WORKER_SYSTEM_PROMPT,
        limits: { maxCalls, maxScreenshots, maxMinutes, allowInput },
      };
    }
    const job = this.save({
      id, title: title || task.slice(0, 80), task, images: attachments.map((i) => i.rel), ...spec, write, role: role || null, cwd, branch, parent,
      ...(fixCtx ? { fixOf: fixCtx.prev.id } : {}),
      ...(shootout ? { shootout } : {}),
      ...(playtestCfg ? { playtestLimits: playtestCfg.limits } : {}),
      tried: [...tried, agent], movedFrom, movedTo: null,
      status: "running", created: new Date().toISOString(), finished: null, exitCode: null,
      final: null, diffStat: null, files: [], pid: null,
    });
    if (shootout) { try { registerShootoutJob(this.home, shootout, job); } catch {} }

    const lastFile = this.file(id, "last");
    const researchNote = role === "research"
      ? "\n\nWeb research requirements:\n- Use web search/fetch to look up current information.\n- Cite facts inline with numbered brackets like [1], [2].\n- End with a \"Sources\" list containing ONLY the real http/https URLs you actually opened."
      : "";
    // Fix rounds get only the previous diff and failing check output instead of the full project context.
    const workerTask = fixCtx
      ? buildFixRoundTask({ task, jobs: this, ...fixCtx })
      : withProjectMapSlice(withProjectNotes(task, this.repo), this.repo) + researchNote;
    const { cmd, args, env: extraEnv } = command(spec, { task: workerTask, cwd, write, role: role || null, lastFile, images: attachments.map((i) => i.abs), playtest: playtestCfg, strictModel: noFallback, trustWorkspace });
    const log = fs.createWriteStream(this.file(id, "log"), { flags: "a" });
    const write1 = (stream, line) => log.write(JSON.stringify({ t: Date.now(), stream, line: scrubBase64Images(line) }) + "\n");
    write1("meta", `$ ${cmd} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + "..." : a)).join(" ")}`);

    if (attachments.length && !["codex", "claude"].includes(spec.agent)) write1("meta", `${spec.agent}: images are not supported; continuing without images`);

    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(extraEnv || {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.save({ ...job, pid: child.pid, pidId: procIdentity(child.pid) });
    let lastText = null, cursorText = "", freeError = null, buf = { out: "", err: "" };
    const onData = (stream) => (chunk) => {
      if (spec.agent === "cursor" && stream === "out") cursorText = (cursorText + chunk.toString()).slice(-200000);
      buf[stream] += chunk.toString();
      let i;
      while ((i = buf[stream].indexOf("\n")) >= 0) {
        const line = buf[stream].slice(0, i); buf[stream] = buf[stream].slice(i + 1);
        if (!line.trim()) continue;
        write1(stream, line);
        if (stream === "out") {
          try {
            const o = JSON.parse(line), t = textOf(o);
            if (t) lastText = t;
            if (spec.agent === "free" && o.type === "free.error") freeError = o;
            if (spec.agent === "free" && (o.type === "free.init" || o.type === "free.latency")) this._liveFreeModel(id, o); // show the model while the job runs
          } catch { lastText = line; }
        }
      }
    };
    child.stdout.on("data", onData("out"));
    child.stderr.on("data", onData("err"));
    let killTimer = null;
    const timer = setTimeout(() => {
      write1("meta", `timeout after ${effTimeoutMin} min, killing`);
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
      killTimer.unref?.();
    }, effTimeoutMin * 60000);

    const done = new Promise((res) => child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const runEntry = this.running.get(id);
      if (runEntry?.discardTimer) clearTimeout(runEntry.discardTimer);
      if (playtestCfg?.mcpConfigFile) { try { fs.unlinkSync(playtestCfg.mcpConfigFile); } catch {} }
      if (playtestCfg?.codexHome) { try { fs.rmSync(playtestCfg.codexHome, { recursive: true, force: true }); } catch {} }
      const j = this.get(id);
      j.exitCode = code; j.finished = new Date().toISOString(); j.pid = null; j.pidId = null;
      if (j.status === "discarded") {
        Object.assign(j, this.usage(id));
        if (j.role === "playtest" && playtestCfg) {
          try { j.playtest = parsePlaytestReport("", { repo: this.repo, playtestDir: playtestCfg.playtestDir, playtestId: id, exitCode: code }); } catch {}
        }
        write1("meta", `exit ${code} (discarded)`);
        log.end();
        this.save(j);
        this.running.delete(id);
        return res(j);
      }
      j.status = code === 0 ? "done" : "failed";
      let rateLimited = false;
      // Hit a usage/rate limit? Record a cooldown and re-run the same task on the next worker in the chain.
      if (j.status === "failed") {
        let tail = ""; try { tail = fs.readFileSync(this.file(id, "log"), "utf8").slice(-30000); } catch {}
        rateLimited = RATE_LIMIT.test(tail) && !(j.agent === "free" && freeWorkerRefused(freeError));
        const freeUnavailable = j.agent === "free" && freeWorkerUnavailable(freeError);
        if (rateLimited) recordProviderCooldown(j.agent, { text: tail, home: this.home, reason: "hit a rate limit" });
        if ((rateLimited || freeUnavailable) && !noFallback && j.role !== "playtest") {
          const alt = nextAgent({ tried: j.tried, write, role: j.role || null, home: this.home });
          if (alt) {
            const reason = rateLimited ? "hit a rate limit" : "free provider or model unavailable";
            try {
              const retry = { agent: alt, model: alt === "codex" && freeUnavailable ? "terra" : undefined, effort, task, images: job.images, write, role: j.role || null, title, timeoutMin: effTimeoutMin, parent, tried: j.tried, movedFrom: { id, agent: j.agent, reason }, fixOf: job.fixOf || null, files, skipFixDetect, shootout: j.shootout || null };
              let nj;
              try { nj = this.start(retry); }
              catch (e) {
                if (retry.model !== "terra" || !/No Codex model found for family 'terra'/.test(e.message)) throw e;
                nj = this.start({ ...retry, model: "sol" });
              }
              j.status = "moved"; j.movedTo = nj.id;
              write1("meta", `${reason}: moved to ${alt} (${nj.id})`);
            } catch (e) { write1("meta", `fallback failed: ${e.message}`); }
          }
        }
      } else {
        clearCooldown(j.agent);
      }
      Object.assign(j, this.usage(id));
      if (j.agent === "gemini") {
        recordGeminiRun({ tokens: j.tokens, model: j.model, via: j.via || null, rateLimited });
      }
      j.final = (fs.existsSync(lastFile) && fs.readFileSync(lastFile, "utf8").trim()) || (j.agent === "cursor" ? cursorText.trim() : lastText);
      // Some CLIs answer with local file:// markdown links; keep just the link text.
      if (j.final) j.final = String(j.final).replace(/\[([^\]]+)\]\(file:\/\/[^)]*\)/g, "$1");
      if (j.role === "playtest" && playtestCfg && j.status !== "moved") {
        try {
          j.playtest = parsePlaytestReport(j.final, { repo: this.repo, playtestDir: playtestCfg.playtestDir, playtestId: id, exitCode: code });
        } catch (e) {
          write1("meta", `playtest report parse error: ${e.message}`);
        }
      }
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
        try { if (loadSettings().runTestsBeforeApply) runTests(this, id, { trustedOnly: true }).done.catch(() => {}); } catch {}
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

  /** Record the free model actually in use on the (still running) job file. */
  _liveFreeModel(id, e) {
    try {
      const j = this.get(id);
      if (e.type === "free.init" && e.model) {
        Object.assign(j, { modelUsed: e.model, provider: e.provider || null, latencyMs: Number.isFinite(e.latencyMs) ? e.latencyMs : null, fellBackFrom: e.fellBackFrom || null, fellBackReason: e.fellBackReason || null });
      } else if (e.type === "free.latency" && j.modelUsed === e.model && Number.isFinite(e.ms)) j.latencyMs = e.ms;
      else return;
      this.save(j);
    } catch {}
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
      c = { offset: 0, sum: { input: 0, cached: 0, output: 0 }, found: false, claude: null, cost: null, modelUsed: null, provider: null, latencyMs: null, fellBackFrom: null, fellBackReason: null };
      this._usageCache.set(id, c);
    }
    const applyLine = (l, target) => {
      if (!l) return;
      let e;
      try { const o = JSON.parse(l); if (o.stream !== "out") return; e = JSON.parse(o.line); } catch { return; }
      if (e && e.type === "free.init" && e.model) { // the model that actually answered (job.model keeps what was requested)
        target.modelUsed = e.model; target.provider = e.provider || null;
        target.latencyMs = Number.isFinite(e.latencyMs) ? e.latencyMs : null;
        target.fellBackFrom = e.fellBackFrom || null; target.fellBackReason = e.fellBackReason || null;
        return;
      }
      if (e && e.type === "free.latency" && Number.isFinite(e.ms) && target.modelUsed === e.model) { target.latencyMs = e.ms; return; }
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
        view = { ...c, sum: { ...c.sum }, claude: c.claude ? { ...c.claude } : null };
        applyLine(tail, view);
      }
    }
    const tokens = view.claude ? { ...view.claude } : (view.found ? { ...view.sum } : null);
    return {
      tokens, cost: view.cost,
      ...(view.modelUsed ? { modelUsed: view.modelUsed, provider: view.provider, latencyMs: view.latencyMs, ...(view.fellBackFrom ? { fellBackFrom: view.fellBackFrom, fellBackReason: view.fellBackReason } : {}) } : {}),
    };
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

  stopPlaytest(id, reason = "user") {
    const j = this.get(id);
    if (j.role !== "playtest") throw new Error("not a playtest job");
    const playtestDir = typeof this._testPlaytestDir === "function"
      ? this._testPlaytestDir(id)
      : (this._testPlaytestDir || path.join(this.home, "playtests", id));
    const flag = setStopFlag(playtestDir, reason);
    return { ok: true, id, stopFlag: flag };
  }

  /** Discard a job. `userRequested` (an explicit Discard click) allows force-deleting its branch. */
  discard(id, { userRequested = false } = {}) {
    const j = this.get(id);
    const r = this.running.get(id);
    const signalGroup = () => {
      if (r) {
        if (r.child.exitCode === null) killGroup(r.child, "SIGTERM");
        if (r.discardTimer) clearTimeout(r.discardTimer);
        r.discardTimer = setTimeout(() => {
          if (r.child.exitCode === null) killGroup(r.child, "SIGKILL");
        }, 5000);
        r.discardTimer.unref?.();
      } else if (j.pid && j.pidId && procIdentity(j.pid) === j.pidId) {
        // Started by another Studio process: only signal it if the PID is still the process recorded at spawn
        // (same start time and command), never a bare PID from the job file.
        killGroup(j.pid, "SIGTERM");
      }
    };
    if (j.role === "playtest") {
      const playtestDir = typeof this._testPlaytestDir === "function"
        ? this._testPlaytestDir(id)
        : (this._testPlaytestDir || path.join(this.home, "playtests", id));
      try { setStopFlag(playtestDir, "discarded"); } catch {}
      const graceMs = this._playtestDiscardGraceMs ?? 3000;
      if (r) {
        if (r.discardTimer) clearTimeout(r.discardTimer);
        r.discardTimer = setTimeout(signalGroup, graceMs);
        r.discardTimer.unref?.();
      } else if (j.status === "running" && j.pid) {
        const t = setTimeout(signalGroup, graceMs);
        t.unref?.();
      }
    } else if (r || (j.status === "running" && j.pid)) {
      signalGroup();
    }
    if (j.write) this.cleanup(j, { force: userRequested });
    j.status = "discarded"; return this.save(j);
  }

  /**
   * Remove a write job's worktree and branch. Job files are untrusted, so this only touches what Studio itself
   * created for the job: a worktree registered in `git worktree list` at <home>/worktrees/<id>[-rb-...], and its
   * branch only if it is tokenwise/<that same name> and checked out in that worktree. The branch is deleted with
   * -d (refused if unmerged) unless `force` (the user explicitly discarded the job).
   */
  cleanup(j, { force = false } = {}) {
    if (!j || typeof j.id !== "string" || !JOB_ID_RE.test(j.id)) return;
    stopTests(this, j.id);
    this.removeWorktree(j.id, j.cwd, j.branch, { force });
  }

  removeWorktree(id, cwd, branch, { force = false } = {}) {
    if (typeof cwd !== "string" || path.dirname(cwd) !== path.join(this.home, "worktrees")) return;
    const name = path.basename(cwd);
    if (!JOB_ID_RE.test(name) || !(name === id || name.startsWith(`${id}-rb-`))) return;
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    let registered = null;
    try {
      for (const block of git(this.repo, "worktree", "list", "--porcelain").split("\n\n")) {
        const wt = block.match(/^worktree (.+)$/m)?.[1];
        if (wt && real(wt) === real(cwd)) registered = block.match(/^branch (.+)$/m)?.[1] || "";
      }
    } catch {}
    if (registered === null) return; // not one of this repo's worktrees (or already removed): touch nothing
    try { git(this.repo, "worktree", "remove", "--force", "--", cwd); } catch {}
    if (branch !== `tokenwise/${name}` || registered !== `refs/heads/${branch}`) return;
    try { git(this.repo, "check-ref-format", "--branch", branch); } catch { return; }
    try { git(this.repo, "branch", force ? "-D" : "-d", "--end-of-options", branch); } catch {}
  }
}
