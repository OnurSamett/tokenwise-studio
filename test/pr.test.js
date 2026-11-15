import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  defaultExec,
  slugOfMessage,
  defaultBranchName,
  parseGitHubRemote,
  buildCompareUrl,
  formatChangesBy,
  buildPrPayload,
  prPreconditions,
  commitAndOpenPr,
} from "../src/pr.js";
import { Jobs } from "../src/jobs.js";
import { SNAPSHOT_PREFIX } from "../src/snapshots.js";
import { prNotice } from "../src/notify.js";
import { initServer, handler } from "../src/ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function initRepoWithBareRemote() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tw-pr-test-"));
  const bare = path.join(base, "origin.git");
  const repo = path.join(base, "work");

  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "pipe" });
  execFileSync("git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });

  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Tester");
  g("remote", "add", "origin", bare);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  g("add", "README.md");
  g("commit", "-m", "initial commit");
  g("push", "-u", "origin", "main");

  const cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  return { base, bare, repo, g, cleanup };
}

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-pr-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function callHandler(method, urlPath, body) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4795", "x-tokenwise": "1" };
  let status = 0;
  let headers = {};
  const chunks = [];
  const res = {
    writeHead(s, h) { status = s; headers = h; },
    end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
  };
  const pending = handler(req, res);
  if (body !== undefined) req.write(JSON.stringify(body));
  req.end();
  await pending;
  return { status, headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
}

function makeStubExec({ ghAuthOk = true, ghInstalled = true, prUrl = "https://github.com/acme/demo/pull/42", onGh } = {}) {
  const ghCalls = [];
  const exec = async (cmd, args, opts) => {
    if (cmd === "gh") {
      ghCalls.push([...args]);
      if (onGh) return onGh(args, opts);
      if (!ghInstalled) {
        const err = new Error("spawn gh ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      if (args[0] === "auth" && args[1] === "status") {
        if (!ghAuthOk) {
          const err = new Error("not logged in");
          err.code = 1;
          err.stderr = "You are not logged into any GitHub hosts.";
          throw err;
        }
        return { stdout: "github.com\n  ✓ Logged in to github.com", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: `${prUrl}\n`, stderr: "" };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    }
    return defaultExec(cmd, args, opts);
  };
  return { exec, ghCalls };
}

test("slugOfMessage, defaultBranchName, parseGitHubRemote, and buildCompareUrl", () => {
  assert.equal(slugOfMessage("Open a pull request from applied changes"), "open-a-pull-request-from-applied-changes");
  assert.equal(defaultBranchName("Fix auth: ğüşıöç!"), "tokenwise/fix-auth-gusioc");
  assert.equal(defaultBranchName("   ---   "), "tokenwise/changes");

  assert.deepEqual(parseGitHubRemote("git@github.com:OnurSamett/tokenwise-studio.git"), {
    host: "github.com",
    owner: "OnurSamett",
    repo: "tokenwise-studio",
    baseUrl: "https://github.com/OnurSamett/tokenwise-studio",
  });
  assert.deepEqual(parseGitHubRemote("https://secret-token@github.com/acme/demo.git"), {
    host: "github.com",
    owner: "acme",
    repo: "demo",
    baseUrl: "https://github.com/acme/demo",
  });
  assert.equal(parseGitHubRemote("/tmp/local-bare.git"), null);

  assert.equal(
    buildCompareUrl("git@github.com:acme/demo.git", "main", "tokenwise/my-fix"),
    "https://github.com/acme/demo/compare/main...tokenwise%2Fmy-fix?expand=1",
  );
});

test("formatChangesBy and buildPrPayload omit paths, secrets, and chat content", () => {
  const jobs = [
    {
      id: "j1",
      agent: "codex",
      model: "gpt-5.3-codex-sol",
      status: "merged",
      task: "Secret task in /Users/alice/private/secret-repo with TOKEN=sk-live-12345",
      final: "Edited /Users/alice/private/secret-repo/.env",
      cwd: "/Users/alice/private/secret-repo/.tokenwise-studio/worktrees/j1",
    },
    { id: "j2", agent: "codex", model: "sol", status: "merged", task: "Another chat prompt" },
    { id: "j3", agent: "claude", model: "claude-haiku-4-5", status: "merged", task: "More chat content" },
  ];
  assert.equal(formatChangesBy(jobs), "Changes by: Codex Sol (2 jobs), Claude Haiku (1 job)");

  const payload = buildPrPayload({ message: "Add PR support\n\nIncludes branch creation and push.", jobs });
  assert.equal(payload.title, "Add PR support");
  assert.equal(payload.body, "Includes branch creation and push.\n\nChanges by: Codex Sol (2 jobs), Claude Haiku (1 job)");
  assert.equal(payload.body.includes("/Users/"), false);
  assert.equal(payload.body.includes("sk-live-12345"), false);
  assert.equal(payload.body.includes("Secret task"), false);
  assert.equal(payload.body.includes("Another chat prompt"), false);
});

test("prPreconditions checks staged changes, detached HEAD, origin remote, and gh status", async () => {
  const { repo, g, cleanup } = initRepoWithBareRemote();
  try {
    const { exec: ghOk } = makeStubExec({ ghInstalled: true, ghAuthOk: true });
    const { exec: ghMissing } = makeStubExec({ ghInstalled: false });
    const { exec: ghUnauth } = makeStubExec({ ghInstalled: true, ghAuthOk: false });

    // No staged changes yet
    let pre = await prPreconditions(repo, { exec: ghOk });
    assert.equal(pre.isGit, true);
    assert.equal(pre.hasStaged, false);
    assert.equal(pre.detached, false);
    assert.equal(pre.currentBranch, "main");
    assert.equal(pre.hasOrigin, true);
    assert.equal(pre.ghReady, true);
    assert.equal(pre.canPush, false);

    // Stage a file
    fs.writeFileSync(path.join(repo, "app.js"), "export const x = 1;\n");
    g("add", "app.js");

    pre = await prPreconditions(repo, { exec: ghOk });
    assert.equal(pre.hasStaged, true);
    assert.equal(pre.canPush, true);
    assert.equal(pre.canOpenPr, true);

    pre = await prPreconditions(repo, { exec: ghMissing });
    assert.equal(pre.ghInstalled, false);
    assert.equal(pre.ghReady, false);
    assert.equal(pre.canPush, true);
    assert.equal(pre.canOpenPr, false);

    pre = await prPreconditions(repo, { exec: ghUnauth });
    assert.equal(pre.ghInstalled, true);
    assert.equal(pre.ghAuthenticated, false);
    assert.equal(pre.ghReady, false);
    assert.equal(pre.canPush, true);

    // Detached HEAD
    const headSha = g("rev-parse", "HEAD").trim();
    g("checkout", "--detach", headSha);
    pre = await prPreconditions(repo, { exec: ghOk });
    assert.equal(pre.detached, true);
    assert.equal(pre.currentBranch, null);
    assert.equal(pre.canPush, false);
    g("checkout", "main");

    // Missing origin
    g("remote", "remove", "origin");
    pre = await prPreconditions(repo, { exec: ghOk });
    assert.equal(pre.hasOrigin, false);
    assert.equal(pre.canPush, false);
  } finally {
    cleanup();
  }
});

test("commitAndOpenPr creates branch, commits, pushes to bare remote, runs stubbed gh, and respects returnToOriginal", async () => {
  await withTempHome(async () => {
    const { bare, repo, g, cleanup } = initRepoWithBareRemote();
    try {
      const jobs = new Jobs(repo);
      const j1 = jobs.save({
        id: "202611150001-aa",
        agent: "codex",
        model: "sol",
        status: "merged",
        write: true,
        applied: ["feature.js"],
        files: ["feature.js"],
        created: "2026-11-15T00:01:00Z",
        task: "Do NOT leak this secret task or /Users/secret/path",
      });
      const j2 = jobs.save({
        id: "202611150002-bb",
        agent: "claude",
        model: "claude-haiku-4-5",
        status: "merged",
        write: true,
        applied: ["feature.js"],
        files: ["feature.js"],
        created: "2026-11-15T00:02:00Z",
        task: "Also secret chat content",
      });

      fs.writeFileSync(path.join(repo, "feature.js"), "export const feat = true;\n");
      g("add", "feature.js");

      const { exec, ghCalls } = makeStubExec({ prUrl: "https://github.com/acme/demo/pull/99" });
      const res = await commitAndOpenPr({
        repo,
        message: "Add awesome feature",
        jobs,
        exec,
      });

      assert.equal(res.ok, true);
      assert.equal(res.branch, "tokenwise/add-awesome-feature");
      assert.equal(res.originalBranch, "main");
      assert.equal(res.currentBranch, "tokenwise/add-awesome-feature");
      assert.equal(res.returned, false);
      assert.equal(res.pushed, true);
      assert.equal(res.prUrl, "https://github.com/acme/demo/pull/99");
      assert.equal(res.changesBy, "Changes by: Codex Sol (1 job), Claude Haiku (1 job)");

      // Local repo stayed on the new branch and working tree is clean
      assert.equal(g("symbolic-ref", "--short", "HEAD").trim(), "tokenwise/add-awesome-feature");
      assert.equal(g("diff", "--cached", "--name-only").trim(), "");

      // Bare remote received the pushed branch and commit
      const bareHead = execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/tokenwise/add-awesome-feature"], { encoding: "utf8" }).trim();
      assert.equal(bareHead, g("rev-parse", "HEAD").trim());
      const bareFile = execFileSync("git", ["--git-dir", bare, "show", "refs/heads/tokenwise/add-awesome-feature:feature.js"], { encoding: "utf8" });
      assert.equal(bareFile, "export const feat = true;\n");

      // Snapshot recorded and jobs marked committedAt
      const refs = g("for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX.slice(0, -1));
      assert.ok(refs.includes("-commit"));
      assert.ok(jobs.get(j1.id).committedAt);
      assert.ok(jobs.get(j2.id).committedAt);

      // Verify stubbed gh pr create args & safe PR body
      const createCall = ghCalls.find((c) => c[0] === "pr" && c[1] === "create");
      assert.ok(createCall);
      assert.deepEqual(createCall.slice(0, 6), [
        "pr", "create", "--head", "tokenwise/add-awesome-feature", "--title", "Add awesome feature",
      ]);
      const bodyIdx = createCall.indexOf("--body");
      assert.ok(bodyIdx >= 0);
      assert.equal(createCall[bodyIdx + 1], "Changes by: Codex Sol (1 job), Claude Haiku (1 job)");

      // Now switch back to main, stage another change, and test returnToOriginal: true + gh missing
      g("checkout", "main");
      fs.writeFileSync(path.join(repo, "second.js"), "export const second = 2;\n");
      g("add", "second.js");

      const { exec: execNoGh } = makeStubExec({ ghInstalled: false });
      const res2 = await commitAndOpenPr({
        repo,
        message: "Second change",
        branch: "custom/second-branch",
        returnToOriginal: true,
        jobs,
        exec: execNoGh,
      });

      assert.equal(res2.branch, "custom/second-branch");
      assert.equal(res2.currentBranch, "main");
      assert.equal(res2.returned, true);
      assert.equal(res2.pushed, true);
      assert.equal(res2.ghAvailable, false);
      assert.equal(res2.prUrl, null);
      assert.equal(g("symbolic-ref", "--short", "HEAD").trim(), "main");
      const bareSecond = execFileSync("git", ["--git-dir", bare, "show", "refs/heads/custom/second-branch:second.js"], { encoding: "utf8" });
      assert.equal(bareSecond, "export const second = 2;\n");
    } finally {
      cleanup();
    }
  });
});

test("GET /api/pr and POST /api/commit (mode: pr) work end-to-end with stubbed gh", async () => {
  await withTempHome(async () => {
    const { bare, repo, g, cleanup } = initRepoWithBareRemote();
    try {
      fs.writeFileSync(path.join(repo, "api.js"), "export const ok = true;\n");
      g("add", "api.js");
      const { exec } = makeStubExec({ prUrl: "https://github.com/acme/demo/pull/7" });
      initServer({ repo, exec });

      const preRes = await callHandler("GET", "/api/pr");
      assert.equal(preRes.status, 200);
      assert.equal(preRes.body.canPush, true);
      assert.equal(preRes.body.canOpenPr, true);
      assert.equal(preRes.body.currentBranch, "main");

      const commitRes = await callHandler("POST", "/api/commit", {
        mode: "pr",
        message: "Open a pull request from applied changes",
        branch: "tokenwise/pr-api-test",
        returnToOriginal: false,
      });
      assert.equal(commitRes.status, 200);
      assert.equal(commitRes.body.ok, true);
      assert.equal(commitRes.body.prUrl, "https://github.com/acme/demo/pull/7");
      assert.equal(commitRes.body.branch, "tokenwise/pr-api-test");
      assert.equal(commitRes.body.currentBranch, "tokenwise/pr-api-test");
      assert.ok(execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/tokenwise/pr-api-test"], { encoding: "utf8" }).trim());
    } finally {
      cleanup();
    }
  });
});

test("prNotice localizes EN/TR and MCP server exposes no PR/commit/push tool", () => {
  const enOpen = prNotice({ branch: "tokenwise/fix", prUrl: "https://github.com/a/b/pull/1", lang: "en" });
  assert.equal(enOpen.title, "Pull request opened");
  assert.ok(enOpen.message.includes("tokenwise/fix"));
  assert.ok(enOpen.message.includes("https://github.com/a/b/pull/1"));

  const trPush = prNotice({ branch: "tokenwise/fix", lang: "tr" });
  assert.equal(trPush.title, "Dal GitHub'a push'landı");
  assert.ok(trPush.message.includes("tokenwise/fix"));

  const mcpSrc = fs.readFileSync(path.join(ROOT, "src", "mcp.js"), "utf8");
  const tools = [...mcpSrc.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.equal(tools.some((name) => /(?:^|[_-])pr(?:$|[_-])|pull|push|commit/i.test(name)), false);
});
