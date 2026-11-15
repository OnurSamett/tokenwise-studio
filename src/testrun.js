// Test runner for write jobs and combined main-tree checks: detect a project's test command,
// support optional override and lint command in Settings, and run without a shell.
import { spawn } from "./process.js";
import fs from "node:fs";
import path from "node:path";

export const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 6000;
const OVERRIDE = "test.json"; // <home>/test.json: { "command": "npm run check", "lint": "npm run lint" }
const COMBINED_STATE = "combined-test.json";
const COMBINED_LOG = "combined-test.log";

/** npm's `npm init` placeholder, which is not a real test. */
const NPM_PLACEHOLDER = /no test specified/i;

/** Detect the test command of a project folder: { cmd, args, label, source } or null. */
export function detectTestCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  if (has("package.json")) {
    try {
      const t = JSON.parse(read("package.json"))?.scripts?.test;
      if (typeof t === "string" && t.trim() && !NPM_PLACEHOLDER.test(t)) return { cmd: "npm", args: ["test"], label: "npm test", source: "package.json" };
    } catch {}
  }
  if (has("pytest.ini")) return { cmd: "pytest", args: ["-q"], label: "pytest -q", source: "pytest.ini" };
  if (has("pyproject.toml") && /pytest/i.test(read("pyproject.toml"))) return { cmd: "pytest", args: ["-q"], label: "pytest -q", source: "pyproject.toml" };
  if (has("go.mod")) return { cmd: "go", args: ["test", "./..."], label: "go test ./...", source: "go.mod" };
  if (has("Cargo.toml")) return { cmd: "cargo", args: ["test"], label: "cargo test", source: "Cargo.toml" };
  return null;
}

/** Split a command line into an argument array. Quotes group words; there is no shell, so |, &&, $VAR and > stay literal. */
export function splitCommand(line) {
  const out = []; let cur = "", q = null, any = false;
  for (const ch of String(line)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ""; any = false; } }
    else cur += ch;
  }
  if (q) throw new Error("unclosed quote in the command");
  if (cur || any) out.push(cur);
  return out;
}

function validateCommand(raw, label = "test") {
  const c = String(raw ?? "").trim();
  if (c.length > 500) throw new Error(`the ${label} command is too long`);
  if (c) {
    const a = splitCommand(c);
    if (!a.length || /[\\/]\.\.(\/|$)/.test(a[0])) throw new Error(`not a valid ${label} command`);
  }
  return c;
}

export function loadTestConfig(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, OVERRIDE), "utf8"));
    return {
      command: typeof raw?.command === "string" && raw.command.trim() ? raw.command.trim() : "",
      lint: typeof raw?.lint === "string" && raw.lint.trim() ? raw.lint.trim() : "",
    };
  } catch {
    return { command: "", lint: "" };
  }
}

export function saveTestConfig(home, { command, lint } = {}) {
  const cur = loadTestConfig(home);
  const next = {
    command: command !== undefined ? validateCommand(command, "test") : cur.command,
    lint: lint !== undefined ? validateCommand(lint, "lint") : cur.lint,
  };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, OVERRIDE), JSON.stringify(next, null, 2));
  return next;
}

export const loadTestOverride = (home) => loadTestConfig(home).command;
export const loadLintOverride = (home) => loadTestConfig(home).lint;
export const saveTestOverride = (home, command) => saveTestConfig(home, { command }).command;
export const saveLintOverride = (home, lint) => saveTestConfig(home, { lint }).lint;

/** The command to run for a project: the Settings override if set, else the detected one (looked up in `dir`). */
export function testCommandFor(home, dir) {
  const o = loadTestOverride(home);
  if (o) { const [cmd, ...args] = splitCommand(o); return { cmd, args, label: o, source: "settings" }; }
  return detectTestCommand(dir);
}

/** Optional lint command configured in Settings > Tests. */
export function lintCommandFor(home) {
  const l = loadLintOverride(home);
  if (!l) return null;
  const [cmd, ...args] = splitCommand(l);
  return { cmd, args, label: l, source: "settings" };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const testLogFile = (jobs, id) => path.join(jobs.home, "jobs", `${id}.test.log`);
export const combinedCheckFile = (jobs) => path.join(jobs.home, COMBINED_STATE);
export const combinedLogFile = (jobs) => path.join(jobs.home, COMBINED_LOG);

function readTail(filePath, bytes = TAIL_BYTES) {
  try {
    const st = fs.statSync(filePath), fd = fs.openSync(filePath, "r");
    try {
      const n = Math.min(bytes, st.size), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

/** Last bytes of a job's test output (also works while the run is still going). */
export const testTail = (jobs, id, bytes = TAIL_BYTES) => readTail(testLogFile(jobs, id), bytes);

/** Last bytes of the combined main-tree check output. */
export const combinedTail = (jobs, bytes = TAIL_BYTES) => readTail(combinedLogFile(jobs), bytes);

/** Is a test run in progress for this job (in this or another process)? */
export function testRunning(job) {
  const t = job.test;
  return !!t && t.status === "running" && (!t.pid || alive(t.pid));
}

export function loadCombinedCheck(jobs) {
  try { return JSON.parse(fs.readFileSync(combinedCheckFile(jobs), "utf8")); } catch { return null; }
}

function saveCombinedCheck(jobs, data) {
  fs.mkdirSync(jobs.home, { recursive: true });
  fs.writeFileSync(combinedCheckFile(jobs), JSON.stringify(data, null, 2));
  return data;
}

/** Is a combined check currently running in the main working tree? */
export function combinedCheckRunning(jobs) {
  if (jobs.combinedChecking?.active) return true;
  const c = loadCombinedCheck(jobs);
  return !!c && c.status === "running" && !!c.pid && alive(c.pid);
}

const killTree = (child, sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };

/** Run one or more command steps sequentially in `cwd`, streaming output to `logFile` with a shared timeout. */
function executeSteps(steps, cwd, logFile, { timeoutMs = TEST_TIMEOUT_MS, onChild, onFinish }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `$ ${steps[0].label}\n`);
  const out = fs.createWriteStream(logFile, { flags: "a" });
  let curChild = null, killTimer = null, settled = false, timedOut = false;

  return new Promise((resolve) => {
    const finish = (status, exitCode, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (note) out.write(`\n${note}\n`);
      out.end(() => resolve(onFinish(status, exitCode)));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (curChild) {
        killTree(curChild, "SIGTERM");
        killTimer = setTimeout(() => killTree(curChild, "SIGKILL"), 5000);
        killTimer.unref?.();
      }
    }, timeoutMs);

    const runStep = (idx) => {
      const spec = steps[idx];
      if (idx > 0) out.write(`\n$ ${spec.label}\n`);
      let child;
      try {
        child = spawn(spec.cmd, spec.args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (e) {
        return finish("error", null, `could not start: ${e.message}`);
      }
      curChild = child;
      onChild?.(child);
      child.stdout.on("data", (c) => out.write(c));
      child.stderr.on("data", (c) => out.write(c));
      child.on("error", (e) => finish("error", null, `could not start ${spec.cmd}: ${e.message}`));
      child.on("close", (code, sig) => {
        if (timedOut) finish("timeout", code, `timed out after ${Math.round(timeoutMs / 60000)} min`);
        else if (sig) finish("fail", code, `stopped by ${sig}`);
        else if (code !== 0) finish("fail", code);
        else if (idx + 1 < steps.length) runStep(idx + 1);
        else finish("pass", 0);
      });
    };

    runStep(0);
  });
}

/**
 * Start the test run for a finished write job. Returns { job, done } where done resolves with the final job.
 * Throws when the job is not a finished write job, has no test command, or is already being tested.
 */
export function runTests(jobs, id, { timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const j = jobs.get(id);
  if (!j.write) throw new Error("tests run in the worktree of a write job; this job is read-only");
  if (j.status !== "done") throw new Error(`job is ${j.status}; tests can run once it is done and before it is applied`);
  // The working directory must be this job's own worktree.
  const wt = path.join(jobs.home, "worktrees");
  let cwd;
  try { cwd = fs.realpathSync(j.cwd); } catch { throw new Error("the job's worktree no longer exists"); }
  const root = fs.realpathSync(wt);
  if (path.dirname(cwd) !== root || path.basename(cwd) !== j.id) throw new Error("the job's folder is not one of its worktrees");
  if (testRunning(j)) throw new Error("tests are already running for this job");
  const spec = testCommandFor(jobs.home, cwd);
  if (!spec) throw new Error("no test command found (no npm test script, pytest, go.mod or Cargo.toml). Set one in Settings.");

  const started = Date.now();
  const test = { status: "running", command: spec.label, source: spec.source, started: new Date(started).toISOString(), finished: null, exitCode: null, durationMs: null, pid: null, tail: "" };
  jobs.save({ ...j, test });

  const done = executeSteps([spec], cwd, testLogFile(jobs, id), {
    timeoutMs,
    onChild: (child) => {
      jobs.testing.set(id, child);
      test.pid = child.pid;
      try { jobs.save({ ...jobs.get(id), test: { ...test } }); } catch {}
    },
    onFinish: (status, exitCode) => {
      jobs.testing.delete(id);
      let cur;
      try { cur = jobs.get(id); } catch { return null; } // job removed meanwhile
      cur.test = { ...test, status, exitCode, finished: new Date().toISOString(), durationMs: Date.now() - started, pid: null, tail: testTail(jobs, id) };
      jobs.save(cur);
      return cur;
    },
  });
  return { job: jobs.get(id), done };
}

/**
 * Run the project's test command (detected or overridden in Settings) plus optional lint command
 * in the MAIN working tree with a 10-minute timeout. Refuses while a previous run is active.
 */
export function runCombinedCheck(jobs, { timeoutMs = TEST_TIMEOUT_MS } = {}) {
  if (combinedCheckRunning(jobs)) throw new Error("combined check is already running");
  let cwd;
  try { cwd = fs.realpathSync(jobs.repo); } catch { throw new Error("project folder no longer exists"); }
  const testSpec = testCommandFor(jobs.home, cwd);
  const lintSpec = lintCommandFor(jobs.home);
  const steps = [testSpec, lintSpec].filter(Boolean);
  if (!steps.length) throw new Error("no test or lint command found (no npm test script, pytest, go.mod or Cargo.toml). Set one in Settings.");

  const started = Date.now();
  const label = steps.map((s) => s.label).join(" && ");
  const source = [testSpec?.source, lintSpec?.source].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("+") || "settings";
  const state = {
    status: "running",
    command: label,
    commands: steps.map((s) => s.label),
    source,
    started: new Date(started).toISOString(),
    finished: null,
    exitCode: null,
    durationMs: null,
    pid: null,
    tail: "",
  };
  jobs.combinedChecking = { active: true, child: null };
  saveCombinedCheck(jobs, state);

  const done = executeSteps(steps, cwd, combinedLogFile(jobs), {
    timeoutMs,
    onChild: (child) => {
      jobs.combinedChecking = { active: true, child };
      state.pid = child.pid;
      try { saveCombinedCheck(jobs, state); } catch {}
    },
    onFinish: (status, exitCode) => {
      jobs.combinedChecking = null;
      const finalState = {
        ...state,
        status,
        exitCode,
        finished: new Date().toISOString(),
        durationMs: Date.now() - started,
        pid: null,
        tail: combinedTail(jobs),
      };
      saveCombinedCheck(jobs, finalState);
      return finalState;
    },
  });
  return { check: state, done };
}

/** Make a test run quiet when a job's worktree is removed (discard / apply). */
export function stopTests(jobs, id) {
  const c = jobs.testing.get(id);
  if (c) killTree(c, "SIGKILL");
}

/** Stop an active combined check if running. */
export function stopCombinedCheck(jobs) {
  const c = jobs.combinedChecking?.child;
  if (c) killTree(c, "SIGKILL");
}
