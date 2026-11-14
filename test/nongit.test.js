import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { Jobs, gitSetupPreview, isGitRepo, setupGit } from "../src/jobs.js";
import { buildGuide } from "../src/orchestrator.js";
import { handler, initServer } from "../src/ui.js";
import { t, tp } from "../ui/i18n.js";

const tmp = (prefix = "tw-nongit-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const home = tmp("tw-home-");
  process.env.HOME = home;
  const cleanup = () => {
    process.env.HOME = prevHome;
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

async function callHandler(method, urlPath, bodyObj, { csrf = true } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", ...(method === "POST" && csrf ? { "x-tokenwise": "1" } : {}) };
  let status = 200;
  let headers = {};
  const chunks = [];
  const res = {
    writeHead(code, h = {}) { status = code; headers = h; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
  };
  const pending = handler(req, res);
  if (method === "POST") req.end(JSON.stringify(bodyObj ?? {}));
  else req.end();
  await pending;
  const text = Buffer.concat(chunks).toString("utf8");
  const type = headers["content-type"] || "";
  return { status, headers, body: type.includes("application/json") && text ? JSON.parse(text) : text };
}

test("gitSetupPreview and setupGit initialize repo, .gitignore, and initial commit excluding .tokenwise-studio", () => {
  withTempHome(() => {
    const dir = tmp("tw-plain-");
    try {
      fs.writeFileSync(path.join(dir, "index.js"), "console.log('hi');\n");
      fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(dir, "lib", "util.js"), "export const x = 1;\n");
      new Jobs(dir); // creates .tokenwise-studio/ inside non-git folder

      assert.equal(isGitRepo(dir), false);
      const preview = gitSetupPreview(dir);
      assert.deepEqual(preview, {
        isGit: false,
        fileCount: 2,
        hasGitignore: false,
        needsGitignoreEntry: true,
      });

      const res = setupGit(dir);
      assert.equal(res.ok, true);
      assert.equal(res.isGit, true);
      assert.equal(res.fileCount, 2);
      assert.equal(res.gitignoreUpdated, true);
      assert.ok(res.sha);
      assert.equal(isGitRepo(dir), true);

      const gi = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
      assert.ok(gi.includes(".tokenwise-studio/"));

      const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).trim().split("\n").sort();
      assert.deepEqual(tracked, [".gitignore", "index.js", "lib/util.js"]);

      // Running setup again refuses because it is already a git repo.
      assert.throws(() => gitSetupPreview(dir), /already a git repository/);
      assert.throws(() => setupGit(dir), /already a git repository/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("setupGit preserves existing .gitignore without duplicating .tokenwise-studio/", () => {
  withTempHome(() => {
    const dirA = tmp("tw-gi-append-");
    const dirB = tmp("tw-gi-keep-");
    try {
      fs.writeFileSync(path.join(dirA, ".gitignore"), "node_modules/\n");
      fs.writeFileSync(path.join(dirA, "app.js"), "export default 1;\n");
      const pA = gitSetupPreview(dirA);
      assert.equal(pA.hasGitignore, true);
      assert.equal(pA.needsGitignoreEntry, true);
      assert.equal(pA.fileCount, 2);
      const rA = setupGit(dirA);
      assert.equal(rA.gitignoreUpdated, true);
      assert.equal(fs.readFileSync(path.join(dirA, ".gitignore"), "utf8"), "node_modules/\n.tokenwise-studio/\n");

      fs.writeFileSync(path.join(dirB, ".gitignore"), "dist/\n.tokenwise-studio/\n");
      const pB = gitSetupPreview(dirB);
      assert.equal(pB.hasGitignore, true);
      assert.equal(pB.needsGitignoreEntry, false);
      assert.equal(pB.fileCount, 1);
      const rB = setupGit(dirB);
      assert.equal(rB.gitignoreUpdated, false);
      assert.equal(fs.readFileSync(path.join(dirB, ".gitignore"), "utf8"), "dist/\n.tokenwise-studio/\n");
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

test("buildGuide instructs read-only jobs when isGit is false", () => {
  const nonGitGuide = buildGuide("ask", { isGit: false });
  assert.match(nonGitGuide, /NON-GIT PROJECT/);
  assert.match(nonGitGuide, /read-only jobs/i);

  const gitGuide = buildGuide("ask", { isGit: true });
  assert.doesNotMatch(gitGuide, /NON-GIT PROJECT/);
});

test("UI API exposes project.isGit, /api/git-setup preview/execution, CSRF protection, and i18n keys", async () => {
  await withTempHome(async () => {
    const dir = tmp("tw-ui-nongit-");
    try {
      fs.writeFileSync(path.join(dir, "main.py"), "print('ok')\n");
      initServer({ repo: dir });

      const s0 = await callHandler("GET", "/api/state");
      assert.equal(s0.status, 200);
      assert.equal(s0.body.project.isGit, false);

      const prev = await callHandler("GET", "/api/git-setup");
      assert.equal(prev.status, 200);
      assert.equal(prev.body.isGit, false);
      assert.equal(prev.body.fileCount, 1);

      // CSRF protection blocks POST without x-tokenwise header
      const denied = await callHandler("POST", "/api/git-setup", { confirm: true }, { csrf: false });
      assert.equal(denied.status, 403);

      const done = await callHandler("POST", "/api/git-setup", { confirm: true });
      assert.equal(done.status, 200);
      assert.equal(done.body.ok, true);
      assert.equal(done.body.isGit, true);
      assert.equal(done.body.state.project.isGit, true);

      const s1 = await callHandler("GET", "/api/state");
      assert.equal(s1.body.project.isGit, true);

      const htmlRes = await callHandler("GET", "/");
      assert.equal(htmlRes.status, 200);
      assert.ok(htmlRes.body.includes('id="nongit"'));

      // Verify EN/TR strings
      assert.equal(t("git.noRepoNotice", {}, "en"), "Workers can't change files here because this folder isn't a git project");
      assert.equal(t("git.setupBtn", {}, "en"), "Set up git (git init + first commit)");
      assert.ok(tp("git.confirmBody", 3, { gitignore: t("git.confirmGitignoreCreate", {}, "tr") }, "tr").includes("3 dosyayla"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
