// Regression tests: job records in <repo>/.tokenwise-studio/ can be shipped by a cloned repository and are untrusted.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Jobs, validJobRecord } from "../src/jobs.js";

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

