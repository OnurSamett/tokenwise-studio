// Regression tests: job records in <repo>/.tokenwise-studio/ can be shipped by a cloned repository and are untrusted.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Jobs, validJobRecord } from "../src/jobs.js";
import { command, resolve } from "../src/workers.js";
import { pruneExpiredShootouts, SHOOTOUT_TTL_MS } from "../src/shootout.js";

const tmp = (p = "tw-untrusted-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function withTempHome(fn) {
  const prevHome = process.env.HOME, prevNotify = process.env.TOKENWISE_NOTIFY;
  const home = tmp("tw-untrusted-home-");
  process.env.HOME = home; process.env.TOKENWISE_NOTIFY = "0";
  const done = () => {
    process.env.HOME = prevHome;
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY; else process.env.TOKENWISE_NOTIFY = prevNotify;
    fs.rmSync(home, { recursive: true, force: true });
  };
  try {
    const r = fn(home);
    if (r && typeof r.then === "function") return r.finally(done);
    done(); return r;
  } catch (e) { done(); throw e; }
}

/** A "cloned" attacker repo: a committed symlink esc -> ../outside, plus a snapshot commit whose tree has esc/pwned.txt as a blob. */
function evilRepo() {
  const base = tmp();
  const repo = path.join(base, "repo"), outside = path.join(base, "outside");
  fs.mkdirSync(repo); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "victim file\n");
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-q"); g("config", "user.email", "t@example.com"); g("config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  fs.symlinkSync("../outside", path.join(repo, "esc"));
  g("add", "-A"); g("commit", "-qm", "init");
  const blobFile = path.join(base, "blob");
  fs.writeFileSync(blobFile, "ATTACKER CONTENT\n");
  const blob = g("hash-object", "-w", blobFile);
  const idx = path.join(base, "idx");
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  execFileSync("git", ["-C", repo, "update-index", "--add", "--cacheinfo", `100644,${blob},esc/pwned.txt`], { env });
  const tree = execFileSync("git", ["-C", repo, "write-tree"], { env, encoding: "utf8" }).trim();
  const snap = g("commit-tree", tree, "-p", "HEAD", "-m", "snap");
  return { base, repo, outside, g, snap };
}

function plant(jobs, job) {
  fs.writeFileSync(jobs.file(job.id, "job"), JSON.stringify(job, null, 2));
  return job;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Undo of a planted job refuses to write or delete through a symlinked directory (H-1 PoC)", () => {
  withTempHome(() => {
    const { base, repo, outside, g, snap } = evilRepo();
    try {
      const jobs = new Jobs(repo);
      // Even if the snapshot is a proper pre-apply ref, a symlinked parent directory is refused and nothing is written.
      g("update-ref", "refs/tokenwise/pre-apply/20260101000000-evil", snap);
      plant(jobs, { id: "20260101000000-evil", title: "Fix typo in README", created: "2026-01-01T00:00:00.000Z", write: true,
        status: "merged", applySnapshot: "refs/tokenwise/pre-apply/20260101000000-evil", applied: ["esc/pwned.txt"] });
      assert.throws(() => jobs.undo("20260101000000-evil"), /symlink/);
      assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false, "nothing written outside the repo");
      assert.equal(jobs.get("20260101000000-evil").status, "merged");

      // Delete variant: path missing from the snapshot tree would rm the target through the symlink.
      plant(jobs, { id: "20260101000001-evil", title: "x", created: "2026-01-01T00:00:01.000Z", write: true,
        status: "merged", applySnapshot: "refs/tokenwise/pre-apply/20260101000000-evil", applied: ["esc/keep.txt"] });
      assert.throws(() => jobs.undo("20260101000001-evil"), /symlink/);
      assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "victim file\n");

      // A raw SHA (what a planted job ships) is not accepted as a snapshot at all.
      plant(jobs, { id: "20260101000002-evil", title: "x", created: "2026-01-01T00:00:02.000Z", write: true,
        status: "merged", applySnapshot: snap, applied: ["README.md"] });
      assert.throws(() => jobs.undo("20260101000002-evil"), /invalid pre-apply snapshot ref/);
      assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hi\n");
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test("Undo refuses when the project root itself is reached through a symlink chain escaping it", () => {
  withTempHome(() => {
    const { base, repo, outside, g, snap } = evilRepo();
    try {
      // a/ is a real dir, but a/b -> ../../outside (escapes) : still refused, nothing written.
      fs.mkdirSync(path.join(repo, "a"));
      fs.symlinkSync("../../outside", path.join(repo, "a", "b"));
      g("update-ref", "refs/tokenwise/pre-apply/x", snap);
      const jobs = new Jobs(repo);
      plant(jobs, { id: "j1", created: "2026-01-01T00:00:00.000Z", status: "merged", write: true,
        applySnapshot: "refs/tokenwise/pre-apply/x", applied: ["README.md", "a/b/pwned.txt"] });
      assert.throws(() => jobs.undo("j1"), /symlink/);
      assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
      assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hi\n", "no partial undo");
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test("job records with bad ids or unsafe paths are ignored on load", () => {
  withTempHome(() => {
    const { base, repo } = evilRepo();
    try {
      const jobs = new Jobs(repo);
      const ok = { id: "20260101000000-good", created: "2026-01-01T00:00:00.000Z", status: "done" };
      plant(jobs, ok);
      fs.writeFileSync(path.join(jobs.home, "jobs", "abs.json"), JSON.stringify({ id: "abs", created: "x", applied: ["/etc/passwd"] }));
      fs.writeFileSync(path.join(jobs.home, "jobs", "dots.json"), JSON.stringify({ id: "dots", created: "x", files: ["a/../../b"] }));
      fs.writeFileSync(path.join(jobs.home, "jobs", "badid.json"), JSON.stringify({ id: "../x", created: "x" }));
      fs.writeFileSync(path.join(jobs.home, "jobs", "pid.json"), JSON.stringify({ id: "pid", created: "x", pid: "-1" }));
      fs.writeFileSync(path.join(jobs.home, "jobs", "nocreated.json"), JSON.stringify({ id: "nocreated" }));
      fs.writeFileSync(path.join(jobs.home, "jobs", "other.json"), JSON.stringify({ id: "mismatch", created: "x" }));
      assert.deepEqual(jobs.list().map((j) => j.id).sort(), ["20260101000000-good", "mismatch"]);
      assert.throws(() => jobs.get("abs"), /invalid job record/);
      assert.throws(() => jobs.get("other"), /invalid job record/);
      assert.throws(() => jobs.get("../../etc/x"), /unknown job/);
      assert.equal(jobs.get(ok.id).id, ok.id);
      assert.equal(validJobRecord({ id: "a", created: "x", applied: ["C:\\\\x"] }), false);
      assert.equal(validJobRecord({ id: "a", created: "x", applied: ["src/a.js"], pid: 12 }), true);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test("opening a project with planted shootout/discard data deletes no user branch and kills no PID (M-1 PoC)", async () => {
  await withTempHome(async () => {
    const { base, repo, g } = evilRepo();
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    try {
      g("branch", "feature-y");
      g("checkout", "-q", "-b", "feature-x"); fs.writeFileSync(path.join(repo, "w.txt"), "unmerged\n"); g("add", "w.txt"); g("commit", "-qm", "wip"); g("checkout", "-q", "-");
      // A user's own linked worktree that a planted job points at.
      const userWt = path.join(base, "user-wt");
      g("worktree", "add", "-q", "-b", "feature-z", userWt, "HEAD");
      fs.writeFileSync(path.join(userWt, "dirty.txt"), "uncommitted\n");

      const jobs = new Jobs(repo);
      const old = new Date(Date.now() - SHOOTOUT_TTL_MS - 3600e3).toISOString();
      plant(jobs, { id: "20260101000000-aaaa", created: old, status: "done", write: true, shootout: "so-evil", branch: "feature-y", cwd: path.join(jobs.home, "worktrees", "20260101000000-aaaa") });
      plant(jobs, { id: "20260101000000-bbbb", created: old, status: "running", write: true, shootout: "so-evil", branch: "feature-x", cwd: userWt, pid: sleeper.pid });
      pruneExpiredShootouts(jobs);
      jobs.discard("20260101000000-bbbb", { userRequested: true });

      const branches = g("branch", "--format=%(refname:short)").split("\n");
      for (const b of ["feature-x", "feature-y", "feature-z"]) assert.ok(branches.includes(b), `branch ${b} kept`);
      assert.equal(fs.readFileSync(path.join(userWt, "dirty.txt"), "utf8"), "uncommitted\n", "user worktree untouched");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(pidAlive(sleeper.pid), "PID from the job file was not signalled");
    } finally {
      try { process.kill(sleeper.pid, "SIGKILL"); } catch {}
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

test("a PID recorded with its process identity by a Studio process is still stopped on discard", { skip: process.platform === "win32" }, async () => {
  await withTempHome(async () => {
    const { base, repo } = evilRepo();
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    try {
      const pidId = execFileSync("ps", ["-o", "lstart=,comm=", "-p", String(sleeper.pid)], { encoding: "utf8" }).trim();
      const jobs = new Jobs(repo);
      plant(jobs, { id: "20260101000000-cccc", created: "2026-01-01T00:00:00.000Z", status: "running", write: false, pid: sleeper.pid, pidId: "Thu Jan  1 00:00:00 1970 sleep" });
      jobs.discard("20260101000000-cccc");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(pidAlive(sleeper.pid), "identity mismatch: not signalled");
      plant(jobs, { id: "20260101000000-dddd", created: "2026-01-01T00:00:00.000Z", status: "running", write: false, pid: sleeper.pid, pidId });
      jobs.discard("20260101000000-dddd");
      const end = Date.now() + 2000;
      while (pidAlive(sleeper.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.equal(pidAlive(sleeper.pid), false);
    } finally {
      try { process.kill(sleeper.pid, "SIGKILL"); } catch {}
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

test("cleanup removes Studio's own worktree and branch; -d keeps an unmerged branch unless the user discarded", () => {
  withTempHome(() => {
    const { base, repo, g } = evilRepo();
    try {
      const jobs = new Jobs(repo);
      const mk = (id) => {
        const cwd = path.join(jobs.home, "worktrees", id), branch = `tokenwise/${id}`;
        g("worktree", "add", "-q", "-b", branch, cwd, "HEAD");
        return plant(jobs, { id, created: "2026-01-01T00:00:00.000Z", status: "done", write: true, cwd, branch });
      };
      const a = mk("20260101000000-a1a1");
      jobs.discard(a.id);
      assert.equal(fs.existsSync(a.cwd), false);
      assert.ok(!g("branch").includes(a.branch), "merged branch deleted with -d");

      const b = mk("20260101000000-b2b2");
      execFileSync("git", ["-C", b.cwd, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "worker commit"]);
      jobs.discard(b.id);
      assert.ok(g("branch").includes(b.branch), "unmerged branch kept without explicit user discard");

      const c = mk("20260101000000-c3c3");
      execFileSync("git", ["-C", c.cwd, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "worker commit"]);
      jobs.discard(c.id, { userRequested: true });
      assert.ok(!g("branch").includes(c.branch), "user discard force-deletes");
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test("gemini/cursor folder-trust flags only for a worktree Studio created (M-2)", async () => {
  const cur = resolve({ agent: "cursor" });
  assert.ok(!command(cur, { task: "t", cwd: "/tmp/repo", write: false }).args.includes("--trust"));
  assert.ok(command(cur, { task: "t", cwd: "/tmp/wt", write: true, trustWorkspace: true }).args.includes("--trust"));
  const gem = { agent: "gemini", model: "gemini-2.5-pro", effort: "medium" };
  assert.ok(!command(gem, { task: "t", cwd: "/tmp/repo", write: false }).args.includes("--skip-trust"));
  assert.ok(command(gem, { task: "t", cwd: "/tmp/wt", write: true, trustWorkspace: true }).args.includes("--skip-trust"));

  await withTempHome(async () => {
    const { base, repo } = evilRepo();
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gemini"), `#!${process.execPath}\nconsole.log(JSON.stringify({ type: "result", result: "ok" }));\n`, { mode: 0o755 });
    const prev = { PATH: process.env.PATH, AGY: process.env.TOKENWISE_AGY, GK: process.env.GEMINI_API_KEY };
    process.env.PATH = `${bin}${path.delimiter}${prev.PATH}`; process.env.TOKENWISE_AGY = path.join(base, "no-agy"); delete process.env.GEMINI_API_KEY;
    try {
      const jobs = new Jobs(repo);
      const argsOf = async (write) => {
        const j = jobs.start({ agent: "gemini", model: "gemini-2.5-pro", task: "t", write, noFallback: true });
        await jobs.wait(j.id, 10);
        return fs.readFileSync(jobs.file(j.id, "log"), "utf8").split("\n")[0];
      };
      assert.ok(!(await argsOf(false)).includes("--skip-trust"), "read-only job in the user's repo is not trusted");
      assert.ok((await argsOf(true)).includes("--skip-trust"), "Studio-made worktree is trusted");
    } finally {
      process.env.PATH = prev.PATH;
      if (prev.AGY === undefined) delete process.env.TOKENWISE_AGY; else process.env.TOKENWISE_AGY = prev.AGY;
      if (prev.GK !== undefined) process.env.GEMINI_API_KEY = prev.GK;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
