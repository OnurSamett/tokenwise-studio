import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { Jobs } from "../src/jobs.js";
import { createSnapshot, SNAPSHOT_PREFIX, MAX_SNAPSHOTS } from "../src/snapshots.js";
import { handler, initServer } from "../src/ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (prefix = "tw-undo-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const prevNotify = process.env.TOKENWISE_NOTIFY;
  const home = tmp("tw-undo-home-");
  process.env.HOME = home;
  process.env.TOKENWISE_NOTIFY = "0";
  const cleanup = () => {
    process.env.HOME = prevHome;
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY;
    else process.env.TOKENWISE_NOTIFY = prevNotify;
    fs.rmSync(home, { recursive: true, force: true });
  };
  try {
    const res = fn(home);
    if (res && typeof res.then === "function") return res.finally(cleanup);
    cleanup();
    return res;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function initRepo() {
  const repo = tmp("tw-undo-repo-");
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "untouched-base\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return { repo, g };
}

function makeWriteJob(repo, jobs, id, mutateFn) {
  const cwd = path.join(jobs.home, "worktrees", id);
  const branch = `tokenwise/${id}`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, cwd, "HEAD"], { stdio: "pipe" });
  mutateFn(cwd);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  const files = execFileSync("git", ["-C", cwd, "diff", "--cached", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const diff = execFileSync("git", ["-C", cwd, "diff", "--cached", "--binary", "HEAD"]);
  fs.writeFileSync(jobs.file(id, "diff"), diff);
  return jobs.save({
    id,
    title: `job ${id}`,
    task: "edit",
    agent: "codex",
    model: "sol",
    effort: "medium",
    write: true,
    cwd,
    branch,
    status: "done",
    created: new Date().toISOString(),
    files,
    tried: [],
  });
}

async function callHandler(method, urlPath, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", "sec-fetch-site": "same-origin", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
  let status = 200;
  const chunks = [];
  const res = {
    writeHead(code) { status = code; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
  };
  const pending = handler(req, res);
  if (method === "POST") req.end(JSON.stringify(bodyObj ?? {}));
  else req.end();
  await pending;
  const text = Buffer.concat(chunks).toString("utf8");
  return { status, body: text ? JSON.parse(text) : null };
}

test("apply then undo restores bytes (including binary) and index without moving HEAD or touching other files", () => {
  withTempHome(() => {
    const { repo, g } = initRepo();
    try {
      const jobs = new Jobs(repo);
      const headBefore = g("rev-parse", "HEAD").trim();
      const branchBefore = g("rev-parse", "--abbrev-ref", "HEAD").trim();

      // Prepare pre-apply state:
      // - a.txt has a staged user edit at top (index == worktree != HEAD), which 3-way merges with worker's edit at bottom
      // - other.txt has staged AND different unstaged edits (must not be touched by snapshot or undo)
      // - untracked.txt exists untracked on disk
      fs.writeFileSync(path.join(repo, "a.txt"), "staged-top\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
      g("add", "a.txt");
      fs.writeFileSync(path.join(repo, "other.txt"), "other-staged\n");
      g("add", "other.txt");
      fs.writeFileSync(path.join(repo, "other.txt"), "other-unstaged\n");
      fs.writeFileSync(path.join(repo, "untracked.txt"), "keep-untracked\n");

      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const job = makeWriteJob(repo, jobs, "20261114000001-u1", (cwd) => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\nworker-bottom\n");
        fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "sub", "new.png"), png);
      });

      const merged = jobs.merge(job.id);
      assert.equal(merged.status, "merged");
      assert.ok(merged.applySnapshot.startsWith(`${SNAPSHOT_PREFIX}`));
      assert.ok(merged.applySnapshot.endsWith(`-${job.id}`));

      // Snapshot exists and captures both working tree (including untracked) and index, without moving HEAD.
      assert.equal(g("rev-parse", "HEAD").trim(), headBefore);
      assert.equal(g("rev-parse", "--abbrev-ref", "HEAD").trim(), branchBefore);
      assert.equal(g("show", `${merged.applySnapshot}:untracked.txt`), "keep-untracked\n");
      assert.equal(g("show", `${merged.applySnapshot}^2:a.txt`), "staged-top\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
      assert.equal(g("show", `${merged.applySnapshot}^2:other.txt`), "other-staged\n");
      assert.equal(g("show", `${merged.applySnapshot}:other.txt`), "other-unstaged\n");

      // Applied files are in the working tree & index now.
      assert.equal(fs.existsSync(path.join(repo, "sub", "new.png")), true);
      assert.deepEqual(fs.readFileSync(path.join(repo, "sub", "new.png")), png);
      assert.match(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), /worker-bottom/);
      assert.match(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), /staged-top/);

      // Undo restores exact pre-apply working tree and index for applied files only.
      const undone = jobs.undo(job.id);
      assert.equal(undone.status, "undone");
      assert.equal(g("rev-parse", "HEAD").trim(), headBefore);
      assert.equal(g("rev-parse", "--abbrev-ref", "HEAD").trim(), branchBefore);
      assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "staged-top\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
      assert.equal(g("show", ":a.txt"), "staged-top\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
      assert.equal(fs.existsSync(path.join(repo, "sub", "new.png")), false);
      assert.equal(g("ls-files", "sub/new.png").trim(), "");

      // Unrelated files remain untouched (both index and working tree).
      assert.equal(g("show", ":other.txt"), "other-staged\n");
      assert.equal(fs.readFileSync(path.join(repo, "other.txt"), "utf8"), "other-unstaged\n");
      assert.equal(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8"), "keep-untracked\n");

      // Cannot undo the same job twice.
      assert.throws(() => jobs.undo(job.id), /undone/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("undo refuses with clear file list after later working-tree edit, index change, or commit", () => {
  withTempHome(() => {
    const { repo, g } = initRepo();
    try {
      const jobs = new Jobs(repo);

      // 1. Working-tree edit after apply -> refuses and names edited file.
      const j1 = makeWriteJob(repo, jobs, "20261114000002-e1", (cwd) => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "changed-by-worker\nline2\nline3\nline4\nline5\n");
        fs.writeFileSync(path.join(cwd, "added.txt"), "new file\n");
      });
      jobs.merge(j1.id);
      fs.writeFileSync(path.join(repo, "added.txt"), "edited later by user\n");
      assert.throws(() => jobs.undo(j1.id), /changed since apply.*added\.txt/);
      assert.equal(jobs.get(j1.id).status, "merged");

      // 2. Index change (unstage) on another applied job -> refuses and names unstaged file.
      g("reset", "--hard", "-q", "HEAD");
      g("clean", "-fdq");
      const j2 = makeWriteJob(repo, jobs, "20261114000003-e2", (cwd) => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "worker-2\nline2\nline3\nline4\nline5\n");
      });
      jobs.merge(j2.id);
      g("reset", "-q", "HEAD", "--", "a.txt");
      assert.throws(() => jobs.undo(j2.id), /changed since apply.*a\.txt/);

      // 3. Commit touching applied file -> refuses and names committed file.
      g("add", "a.txt");
      g("commit", "-qm", "user commit");
      assert.throws(() => jobs.undo(j2.id), /changed since apply.*a\.txt/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("snapshot does not alter branch/index/worktree and prunes to last 30 refs per repo", () => {
  withTempHome(() => {
    const { repo, g } = initRepo();
    try {
      fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
      g("add", "a.txt");
      fs.writeFileSync(path.join(repo, "a.txt"), "working\n");
      fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");

      const headBefore = g("rev-parse", "HEAD").trim();
      const statusBefore = g("status", "--porcelain");

      for (let i = 1; i <= 35; i++) {
        const res = createSnapshot(repo, `job-${String(i).padStart(2, "0")}`);
        assert.ok(res.ref.startsWith(SNAPSHOT_PREFIX));
      }

      assert.equal(g("rev-parse", "HEAD").trim(), headBefore);
      assert.equal(g("status", "--porcelain"), statusBefore);

      const refs = g("for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX.slice(0, -1))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      assert.equal(refs.length, MAX_SNAPSHOTS);
      assert.equal(refs.some((r) => r.endsWith("-job-01")), false);
      assert.equal(refs.some((r) => r.endsWith("-job-05")), false);
      assert.equal(refs.some((r) => r.endsWith("-job-06")), true);
      assert.equal(refs.some((r) => r.endsWith("-job-35")), true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("POST /api/commit records pre-apply snapshot and POST /api/undo/:id undoes applied job", async () => {
  await withTempHome(async () => {
    const { repo, g } = initRepo();
    try {
      const jobs = new Jobs(repo);
      const j = makeWriteJob(repo, jobs, "20261114000004-api", (cwd) => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "api-applied\nline2\nline3\nline4\nline5\n");
      });
      initServer({ repo });

      const mergeRes = await callHandler("POST", `/api/merge/${j.id}`, {});
      assert.equal(mergeRes.status, 200);
      assert.equal(mergeRes.body.status, "merged");

      const undoRes = await callHandler("POST", `/api/undo/${j.id}`, {});
      assert.equal(undoRes.status, 200);
      assert.equal(undoRes.body.status, "undone");
      assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");

      // Re-stage a change and commit via POST /api/commit: must record a snapshot before committing.
      fs.writeFileSync(path.join(repo, "a.txt"), "ready-to-commit\n");
      g("add", "a.txt");
      const refsBefore = g("for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX.slice(0, -1)).split("\n").filter(Boolean);
      const commitRes = await callHandler("POST", "/api/commit", { message: "studio commit" });
      assert.equal(commitRes.status, 200);
      assert.equal(commitRes.body.ok, true);
      const refsAfter = g("for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX.slice(0, -1)).split("\n").filter(Boolean);
      assert.equal(refsAfter.length, refsBefore.length + 1);
      assert.ok(refsAfter.some((r) => r.endsWith("-commit")));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("MCP server exposes no undo tool (user-only)", () => {
  const mcpSrc = fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8");
  const tools = [...mcpSrc.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(tools.includes("job_merge"));
  assert.equal(tools.some((t) => /undo/i.test(t)), false);
});
