// Test runner for write jobs: detect a project's test command and run it inside the job's worktree.
// No shell: the command is an argument array. One run at a time per job, 10 minute timeout,
// output streamed to <home>/jobs/<id>.test.log, result stored on the job as job.test.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 6000;
const OVERRIDE = "test.json"; // <home>/test.json: { "command": "npm run check" }

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
  if (q) throw new Error("unclosed quote in the test command");
  if (cur || any) out.push(cur);
  return out;
}

export function loadTestOverride(home) {
  try { const c = JSON.parse(fs.readFileSync(path.join(home, OVERRIDE), "utf8"))?.command; return typeof c === "string" && c.trim() ? c.trim() : ""; } catch { return ""; }
}
export function saveTestOverride(home, command) {
  const c = String(command ?? "").trim();
  if (c.length > 500) throw new Error("the test command is too long");
  if (c) { const a = splitCommand(c); if (!a.length || /[\\/]\.\.(\/|$)/.test(a[0])) throw new Error("not a valid test command"); }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, OVERRIDE), JSON.stringify({ command: c }, null, 2));
  return c;
}

/** The command to run for a project: the Settings override if set, else the detected one (looked up in `dir`). */
export function testCommandFor(home, dir) {
  const o = loadTestOverride(home);
  if (o) { const [cmd, ...args] = splitCommand(o); return { cmd, args, label: o, source: "settings" }; }
  return detectTestCommand(dir);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const testLogFile = (jobs, id) => path.join(jobs.home, "jobs", `${id}.test.log`);

/** Last bytes of a job's test output (also works while the run is still going). */
export function testTail(jobs, id, bytes = TAIL_BYTES) {
  try {
    const f = testLogFile(jobs, id), st = fs.statSync(f), fd = fs.openSync(f, "r");
    try {
      const n = Math.min(bytes, st.size), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

/** Is a test run in progress for this job (in this or another process)? */
export function testRunning(job) {
  const t = job.test;
  return !!t && t.status === "running" && (!t.pid || alive(t.pid));
}

const killTree = (child, sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };

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

  const logf = testLogFile(jobs, id);
  fs.writeFileSync(logf, `$ ${spec.label}\n`);
  const started = Date.now();
  const test = { status: "running", command: spec.label, source: spec.source, started: new Date(started).toISOString(), finished: null, exitCode: null, durationMs: null, pid: null, tail: "" };
  jobs.save({ ...j, test });

  const out = fs.createWriteStream(logf, { flags: "a" });
  let child, settled = false, timedOut = false;
  const done = new Promise((resolve) => {
    const finish = (status, exitCode, note) => {
      if (settled) return; settled = true; clearTimeout(timer); jobs.testing.delete(id);
      if (note) out.write(`\n${note}\n`);
      out.end(() => {
        let cur; try { cur = jobs.get(id); } catch { return resolve(null); } // job removed meanwhile
        cur.test = { ...test, status, exitCode, finished: new Date().toISOString(), durationMs: Date.now() - started, pid: null, tail: testTail(jobs, id) };
        jobs.save(cur);
        resolve(cur);
      });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child, "SIGTERM"); setTimeout(() => killTree(child, "SIGKILL"), 5000).unref(); }, timeoutMs);
    try {
      child = spawn(spec.cmd, spec.args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) { return finish("error", null, `could not start: ${e.message}`); }
    jobs.testing.set(id, child);
    test.pid = child.pid;
    try { jobs.save({ ...jobs.get(id), test: { ...test } }); } catch {}
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => out.write(c));
    child.on("error", (e) => finish("error", null, `could not start ${spec.cmd}: ${e.message}`));
    child.on("close", (code, sig) => {
      jobs.testing.delete(id);
      if (timedOut) finish("timeout", code, `timed out after ${Math.round(timeoutMs / 60000)} min`);
      else if (sig) finish("fail", code, `stopped by ${sig}`);
      else finish(code === 0 ? "pass" : "fail", code);
    });
  });
  return { job: jobs.get(id), done };
}

/** Make a test run quiet when a job's worktree is removed (discard / apply). */
export function stopTests(jobs, id) {
  const c = jobs.testing.get(id);
  if (c) killTree(c, "SIGKILL");
}
