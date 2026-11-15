import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { Jobs } from "../src/jobs.js";
import { handler, initServer } from "../src/ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (prefix = "tw-conf-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha256File = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const prevNotify = process.env.TOKENWISE_NOTIFY;
  const home = tmp("tw-conf-home-");
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
  const repo = tmp("tw-conf-repo-");
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
  fs.writeFileSync(path.join(repo, "clean.txt"), "alpha\nbeta\ngamma\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return { repo, g };
}

function makeWriteJob(repo, jobs, id, mutateFn, opts = {}) {
  const cwd = path.join(jobs.home, "worktrees", id);
  const branch = `tokenwise/${id}`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, cwd, "HEAD"], { stdio: "pipe" });
  mutateFn(cwd);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe" });
  const files = execFileSync("git", ["-C", cwd, "diff", "--cached", "--no-renames", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const diff = execFileSync("git", ["-C", cwd, "diff", "--cached", "--no-renames", "--binary", "HEAD"]);
  fs.writeFileSync(jobs.file(id, "diff"), diff);
  return jobs.save({
    id,
    title: opts.title || `job ${id}`,
    task: opts.task || "edit files",
    agent: opts.agent || "claude",
    model: opts.model || "haiku",
    effort: opts.effort || "low",
    write: true,
    parent: opts.parent ?? null,
    cwd,
    branch,
    status: opts.status || "done",
    created: opts.created || new Date().toISOString(),
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

test("overlapping finished-but-unapplied write jobs are detected accurately", () => {
  withTempHome(() => {
    const { repo } = initRepo();
    try {
      const jobs = new Jobs(repo);
      const j1 = makeWriteJob(repo, jobs, "20261115000001-j1", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "j1-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
        fs.writeFileSync(path.join(cwd, "clean.txt"), "alpha-1\nbeta\ngamma\n");
      }, { agent: "codex", model: "sol", title: "Update top" });

      const j2 = makeWriteJob(repo, jobs, "20261115000002-j2", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nj2-bottom\n");
      }, { agent: "claude", model: "sonnet", title: "Update bottom" });

      // Discarded and running jobs must NOT be flagged as overlaps.
      makeWriteJob(repo, jobs, "20261115000003-j3", (cwd) => {
        fs.writeFileSync(path.join(cwd, "clean.txt"), "discarded\n");
      }, { status: "discarded", title: "Discarded job" });
      makeWriteJob(repo, jobs, "20261115000004-j4", (cwd) => {
        fs.writeFileSync(path.join(cwd, "clean.txt"), "running\n");
      }, { status: "running", title: "Running job" });

      const c1 = jobs.conflicts(j1.id);
      assert.equal(c1.clean, true);
      assert.equal(c1.ok, false);
      assert.equal(c1.overlaps.length, 1);
      assert.equal(c1.overlaps[0].file, "shared.txt");
      assert.deepEqual(c1.overlaps[0].jobs, [
        { id: j2.id, agent: "claude", model: "sonnet", title: "Update bottom" },
      ]);
      assert.equal(c1.files["shared.txt"].status, "overlap");
      assert.equal(c1.files["clean.txt"].status, "ok");
      assert.deepEqual(c1.files["clean.txt"].alsoChangedBy, []);

      // Once j1 is merged, j2 no longer overlaps any unapplied job and still applies cleanly via 3-way.
      jobs.merge(j1.id);
      const c2 = jobs.conflicts(j2.id);
      assert.equal(c2.ok, true);
      assert.equal(c2.clean, true);
      assert.deepEqual(c2.overlaps, []);
      assert.equal(c2.files["shared.txt"].status, "ok");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("clean vs conflicting apply-check never modifies working tree or index, and partial Apply works for clean files", () => {
  withTempHome(() => {
    const { repo, g } = initRepo();
    try {
      const jobs = new Jobs(repo);
      const j = makeWriteJob(repo, jobs, "20261115000005-mix", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nworker-bottom\n");
        fs.writeFileSync(path.join(cwd, "clean.txt"), "alpha-worker\nbeta\ngamma\n");
        fs.writeFileSync(path.join(cwd, "new.txt"), "created by worker\n");
      });

      // 1. Non-overlapping staged edit in main tree -> still clean via 3-way.
      fs.writeFileSync(path.join(repo, "shared.txt"), "user-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      g("add", "shared.txt");
      const cleanRes = jobs.conflicts(j.id);
      assert.equal(cleanRes.clean, true);
      assert.equal(cleanRes.files["shared.txt"].status, "ok");

      // 2. Conflicting committed change on shared.txt, plus untracked collision on new.txt, plus unstaged edit on other file.
      fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nmain-conflict\n");
      g("add", "shared.txt");
      g("commit", "-qm", "conflict on shared");
      fs.writeFileSync(path.join(repo, "new.txt"), "already untracked\n");

      const indexFile = path.join(repo, ".git", "index");
      const indexHashBefore = sha256File(indexFile);
      const headBefore = g("rev-parse", "HEAD").trim();
      const statusBefore = g("status", "--porcelain");
      const sharedBefore = fs.readFileSync(path.join(repo, "shared.txt"), "utf8");
      const cleanBefore = fs.readFileSync(path.join(repo, "clean.txt"), "utf8");
      const newBefore = fs.readFileSync(path.join(repo, "new.txt"), "utf8");

      const confRes = jobs.conflicts(j.id);
      assert.equal(confRes.clean, false);
      assert.equal(confRes.ok, false);
      assert.equal(confRes.files["shared.txt"].status, "conflict");
      assert.equal(confRes.files["shared.txt"].appliesCleanly, false);
      assert.equal(confRes.files["shared.txt"].reason, "conflict");
      assert.equal(confRes.files["new.txt"].status, "conflict");
      assert.equal(confRes.files["new.txt"].appliesCleanly, false);
      assert.equal(confRes.files["new.txt"].reason, "exists");
      assert.equal(confRes.files["clean.txt"].status, "ok");
      assert.equal(confRes.files["clean.txt"].appliesCleanly, true);

      // Verify check did NOT modify working tree, index, status, or HEAD.
      assert.equal(sha256File(indexFile), indexHashBefore);
      assert.equal(g("rev-parse", "HEAD").trim(), headBefore);
      assert.equal(g("status", "--porcelain"), statusBefore);
      assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), sharedBefore);
      assert.equal(fs.readFileSync(path.join(repo, "clean.txt"), "utf8"), cleanBefore);
      assert.equal(fs.readFileSync(path.join(repo, "new.txt"), "utf8"), newBefore);

      // 3. Unstaged edit on clean.txt also prevents clean apply (since merge uses --3way / --index).
      fs.writeFileSync(path.join(repo, "clean.txt"), "unstaged edit\nbeta\ngamma\n");
      const unstagedRes = jobs.conflicts(j.id);
      assert.equal(unstagedRes.files["clean.txt"].appliesCleanly, false);
      assert.equal(unstagedRes.files["clean.txt"].reason, "unstaged");
      g("checkout", "--", "clean.txt");

      // 4. Full merge must refuse before touching anything; partial merge of clean.txt succeeds!
      assert.throws(() => jobs.merge(j.id), /cannot apply: conflict in/);
      assert.equal(jobs.get(j.id).status, "done");
      assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), sharedBefore);
      assert.equal(fs.readFileSync(path.join(repo, "clean.txt"), "utf8"), cleanBefore);

      const mergedClean = jobs.merge(j.id, ["clean.txt"]);
      assert.equal(mergedClean.status, "merged");
      assert.deepEqual(mergedClean.applied, ["clean.txt"]);
      assert.equal(fs.readFileSync(path.join(repo, "clean.txt"), "utf8"), "alpha-worker\nbeta\ngamma\n");
      assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), sharedBefore);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("rebaseJob succeeds on non-overlapping moved HEAD and returns failedHunks on conflict for follow-up worker", async () => {
  await withTempHome(async () => {
    const { repo, g } = initRepo();
    const binDir = tmp("tw-conf-bin-");
    const taskDump = path.join(binDir, "task.txt");
    const prevPath = process.env.PATH;

    try {
      // Fake `claude` worker binary to verify resolveConflict starts a follow-up write job without calling a real AI model.
      const fakeClaude = path.join(binDir, "claude");
      fs.writeFileSync(fakeClaude, [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'const idx = args.indexOf("-p");',
        `if (idx >= 0) fs.writeFileSync(${JSON.stringify(taskDump)}, args[idx + 1] || "");`,
        'console.log(JSON.stringify({ type: "result", result: "resolved" }));',
      ].join("\n"), { mode: 0o755 });
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;

      const jobs = new Jobs(repo);

      // Job A: edits bottom of shared.txt; HEAD moves on top (non-overlapping) -> rebase succeeds.
      const jA = makeWriteJob(repo, jobs, "20261115000006-rb1", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nrb1-bottom\n");
      });
      // Job B: also edits line1 of shared.txt; HEAD will conflict with line1 -> rebase fails.
      const jB = makeWriteJob(repo, jobs, "20261115000007-rb2", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "rb2-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      }, { agent: "claude", model: "haiku", effort: "low", title: "Edit header", task: "Change line1 to rb2-top" });

      fs.writeFileSync(path.join(repo, "shared.txt"), "main-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      g("add", "shared.txt");
      g("commit", "-qm", "move head on line1");

      const oldCwdA = jA.cwd;
      const oldBranchA = jA.branch;
      const rbA = jobs.rebase(jA.id);
      assert.equal(rbA.ok, true);
      assert.equal(rbA.rebased, true);
      assert.equal(rbA.conflicts.clean, true);
      assert.notEqual(rbA.job.cwd, oldCwdA);
      assert.equal(fs.existsSync(oldCwdA), false);
      assert.equal(g("branch", "--list", oldBranchA).trim(), "");

      const rbB = jobs.rebase(jB.id);
      assert.equal(rbB.ok, false);
      assert.equal(rbB.rebased, false);
      assert.deepEqual(rbB.conflictingFiles, ["shared.txt"]);
      assert.equal(rbB.failedHunks.length, 1);
      assert.equal(rbB.failedHunks[0].file, "shared.txt");
      assert.match(rbB.failedHunks[0].hunks, /rb2-top/);
      assert.match(rbB.failedHunks[0].conflictMarkers, /<<<<<<< ours/);

      // Ensure failed rebase cleaned up jB's temporary worktree/branch and kept jB intact.
      const worktrees = g("worktree", "list", "--porcelain");
      assert.equal(worktrees.includes(`${jB.id}-rb-`), false);
      assert.equal(worktrees.includes(rbA.job.cwd), true);
      assert.equal(jobs.get(jB.id).status, "done");

      // Ask the worker to resolve via HTTP API endpoint.
      initServer({ repo });
      const rbApiRes = await callHandler("POST", `/api/rebase/${jB.id}`, {});
      assert.equal(rbApiRes.status, 200);
      assert.equal(rbApiRes.body.ok, false);
      assert.deepEqual(rbApiRes.body.conflictingFiles, ["shared.txt"]);

      const diffRes = await callHandler("GET", `/api/diff/${jB.id}`);
      assert.equal(diffRes.status, 200);
      assert.equal(diffRes.body.conflicts.clean, false);
      assert.equal(diffRes.body.conflicts.files["shared.txt"].status, "conflict");

      const mergeErr = await callHandler("POST", `/api/merge/${jB.id}`, {});
      assert.equal(mergeErr.status, 400);
      assert.match(mergeErr.body.error, /conflict in shared\.txt/);

      const resRes = await callHandler("POST", `/api/resolve/${jB.id}`, {
        conflictingFiles: rbB.conflictingFiles,
        failedHunks: rbB.failedHunks,
      });
      assert.equal(resRes.status, 200);
      const followUp = resRes.body;
      const waitDone = async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const cur = jobs.get(followUp.id);
          if (cur.status !== "running") return cur;
          await new Promise((r) => setTimeout(r, 25));
        }
        return jobs.get(followUp.id);
      };
      try {
        assert.equal(followUp.agent, "claude");
        assert.equal(followUp.model, "haiku");
        assert.equal(followUp.write, true);
        assert.match(followUp.task, /shared\.txt/);
        assert.match(followUp.task, /rb2-top/);
        assert.match(followUp.task, /<<<<<<< ours/);

        const finished = await waitDone();
        assert.equal(finished.status, "done");
        assert.match(fs.readFileSync(taskDump, "utf8"), /shared\.txt/);
      } finally {
        await waitDone().catch(() => {});
      }
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("MCP job_status and job_diff include conflicts field for sequencing applies", async () => {
  await withTempHome(async (home) => {
    const { repo, g } = initRepo();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "src", "mcp.js")],
      env: { ...process.env, HOME: home, TOKENWISE_REPO: repo, TOKENWISE_NOTIFY: "0" },
    });

    try {
      const jobs = new Jobs(repo);
      const j1 = makeWriteJob(repo, jobs, "20261115000008-m1", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "m1-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      }, { agent: "codex", model: "sol", title: "M1" });

      const j2 = makeWriteJob(repo, jobs, "20261115000009-m2", (cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "m2-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      }, { agent: "claude", model: "sonnet", title: "M2" });

      // Move HEAD to conflict with both on line1.
      fs.writeFileSync(path.join(repo, "shared.txt"), "head-top\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
      g("add", "shared.txt");
      g("commit", "-qm", "head conflict");

      await client.connect(transport);

      const statusRes = await client.callTool({ name: "job_status", arguments: { id: j1.id } });
      const statusData = JSON.parse(statusRes.content[0].text);
      assert.equal(statusData.id, j1.id);
      assert.equal(statusData.conflicts.clean, false);
      assert.equal(statusData.conflicts.ok, false);
      assert.equal(statusData.conflicts.overlaps[0].file, "shared.txt");
      assert.equal(statusData.conflicts.overlaps[0].jobs[0].id, j2.id);
      assert.equal(statusData.conflicts.applyConflicts[0].file, "shared.txt");

      const listRes = await client.callTool({ name: "job_status", arguments: {} });
      const listData = JSON.parse(listRes.content[0].text);
      assert.equal(listData.length, 2);
      assert.ok(listData.every((item) => item.conflicts && item.conflicts.clean === false));

      const diffRes = await client.callTool({ name: "job_diff", arguments: { id: j1.id } });
      const diffData = JSON.parse(diffRes.content[0].text);
      assert.equal(diffData.id, j1.id);
      assert.match(diffData.diff, /m1-top/);
      assert.equal(diffData.conflicts.clean, false);
      assert.equal(diffData.conflicts.files["shared.txt"].status, "conflict");
      assert.equal(diffData.conflicts.files["shared.txt"].alsoChangedBy[0].id, j2.id);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
