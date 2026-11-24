import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { detectTestCommand, splitCommand, testCommandFor, saveTestOverride, saveLintOverride, lintCommandFor, runTests, runCombinedCheck, combinedCheckRunning } from "../src/testrun.js";
import { Jobs } from "../src/jobs.js";
import { DEFAULTS, loadSettings, saveSettings } from "../src/settings.js";
import { resolveJobImage, safeRel, captureImages } from "../src/jobimages.js";
import { handler, initServer } from "../src/ui.js";
import { PassThrough } from "node:stream";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tw-testrun-home-")); // confirmations are stored under the user home
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tw-test-"));
const put = (d, f, c = "") => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); return d; };

test("detect: npm test script, ignoring the npm placeholder", () => {
  const d = put(tmp(), "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  assert.deepEqual(detectTestCommand(d), { cmd: "npm", args: ["test"], label: "npm test", source: "package.json" });
  const p = put(tmp(), "package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(detectTestCommand(p), null);
  assert.equal(detectTestCommand(put(tmp(), "package.json", "{not json")), null);
});

test("detect: pytest, go, cargo, and the order", () => {
  assert.equal(detectTestCommand(put(tmp(), "pytest.ini", "[pytest]")).label, "pytest -q");
  assert.equal(detectTestCommand(put(tmp(), "pyproject.toml", "[tool.pytest.ini_options]\n")).label, "pytest -q");
  assert.equal(detectTestCommand(put(tmp(), "pyproject.toml", "[project]\nname='x'\n")), null);
  assert.deepEqual(detectTestCommand(put(tmp(), "go.mod", "module x")).args, ["test", "./..."]);
  assert.equal(detectTestCommand(put(tmp(), "Cargo.toml", "[package]")).label, "cargo test");
  const both = put(put(tmp(), "go.mod", "module x"), "package.json", JSON.stringify({ scripts: { test: "x" } }));
  assert.equal(detectTestCommand(both).cmd, "npm"); // package.json comes first
  assert.equal(detectTestCommand(tmp()), null);
});

test("splitCommand: quotes group, no shell operators are interpreted", () => {
  assert.deepEqual(splitCommand('npm run "my test" -- -x'), ["npm", "run", "my test", "--", "-x"]);
  assert.deepEqual(splitCommand("echo a && rm -rf /"), ["echo", "a", "&&", "rm", "-rf", "/"]); // literal args, never run by a shell
  assert.throws(() => splitCommand('echo "oops'));
});

test("override from Settings beats detection", () => {
  const home = tmp(), d = put(tmp(), "go.mod", "module x");
  assert.equal(testCommandFor(home, d).cmd, "go");
  saveTestOverride(home, "make check");
  assert.deepEqual(testCommandFor(home, d), { cmd: "make", args: ["check"], label: "make check", source: "settings", unconfirmed: false });
  saveTestOverride(home, "");
  assert.equal(testCommandFor(home, d).cmd, "go");
});

test("safeRel / resolveJobImage confine to images inside the job", () => {
  assert.equal(safeRel("../x.png"), null); assert.equal(safeRel("/etc/x.png"), null); assert.equal(safeRel("a/b.txt"), null);
  assert.equal(safeRel("a/b.PNG"), path.join("a", "b.PNG"));
});

// A real git repo with a write-job record: used for the image capture, route lookup and test run.
function fixture() {
  const repo = tmp();
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  put(repo, "package.json", JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }));
  put(repo, "README.md", "hi"); g("add", "-A"); g("commit", "-qm", "init");
  const jobs = new Jobs(repo);
  const id = "20260101000000-abcd", cwd = path.join(jobs.home, "worktrees", id);
  g("worktree", "add", "-q", "-b", `tokenwise/${id}`, cwd, "HEAD");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(cwd, "pic.png"), png);
  fs.symlinkSync("/etc/hosts", path.join(cwd, "evil.png"));
  const job = jobs.save({ id, title: "t", task: "t", agent: "codex", model: "sol", effort: "low", write: true, cwd, branch: `tokenwise/${id}`, status: "done", created: new Date().toISOString(), files: ["pic.png", "evil.png", "gone.png"], tried: [] });
  return { repo, jobs, job, id, cwd, png };
}

test("captureImages copies real images only; resolveJobImage serves them and refuses everything else", () => {
  const { jobs, job, id, png } = fixture();
  const got = captureImages(jobs, job, job.files);
  assert.deepEqual(got.map((i) => i.path), ["pic.png"]); // symlink and missing file skipped
  const r = resolveJobImage(jobs, id, "pic.png");
  assert.equal(r.type, "image/png"); assert.deepEqual(fs.readFileSync(r.abs), png);
  assert.throws(() => resolveJobImage(jobs, id, "evil.png"), /not found/); // symlink out of the worktree
  assert.throws(() => resolveJobImage(jobs, id, "../../../jobs/x.png"), /not an image/);
  assert.throws(() => resolveJobImage(jobs, id, "README.md"), /not an image/);
  assert.throws(() => resolveJobImage(jobs, "../etc", "pic.png"), /bad job id/);
  assert.throws(() => resolveJobImage(jobs, "nope-1", "pic.png"), /unknown job/);
});

test("runTests passes in the worktree, refuses a second parallel run and read-only jobs", async () => {
  const { jobs, id } = fixture();
  const { done } = runTests(jobs, id);
  assert.throws(() => runTests(jobs, id), /already running/);
  const j = await done;
  assert.equal(j.test.status, "pass"); assert.equal(j.test.exitCode, 0); assert.match(j.test.tail, /npm test|node -e/);
  assert.equal(jobs.get(id).test.status, "pass");
  jobs.save({ ...jobs.get(id), write: false });
  assert.throws(() => runTests(jobs, id), /read-only/);
});

test("runTests reports failure and times out", async () => {
  const { jobs, id, cwd } = fixture();
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('boom');process.exit(3)\"" } }));
  const j = await runTests(jobs, id).done;
  assert.equal(j.test.status, "fail"); assert.equal(j.test.exitCode, 3); assert.match(j.test.tail, /boom/);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"setTimeout(()=>{},60000)\"" } }));
  const t = await runTests(jobs, id, { timeoutMs: 400 }).done;
  assert.equal(t.test.status, "timeout");
});

test("runCombinedCheck reuses detection/override + lint in main tree and enforces single-run guard", async () => {
  const { repo, jobs } = fixture();
  try {
    // 1. Reuses package.json detection in the MAIN working tree (not worktree).
    const marker = path.join(repo, "cwd-marker.txt");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"require('fs').writeFileSync('cwd-marker.txt', process.cwd()); console.log('main-test-ok')\"" },
    }));
    const first = runCombinedCheck(jobs);
    assert.equal(combinedCheckRunning(jobs), true);
    // Single-run guard refuses concurrent start.
    assert.throws(() => runCombinedCheck(jobs), /already running/);
    const res1 = await first.done;
    assert.equal(res1.status, "pass");
    assert.equal(combinedCheckRunning(jobs), false);
    assert.equal(fs.realpathSync(fs.readFileSync(marker, "utf8")), fs.realpathSync(repo));
    assert.match(res1.tail, /main-test-ok/);

    // 2. Settings test override + optional lint command both run in sequence.
    saveTestOverride(jobs.home, 'node -e "console.log(\'override-ok\')"');
    saveLintOverride(jobs.home, 'node -e "console.log(\'lint-ok\')"');
    assert.equal(lintCommandFor(jobs.home).label, 'node -e "console.log(\'lint-ok\')"');
    const res2 = await runCombinedCheck(jobs).done;
    assert.equal(res2.status, "pass");
    assert.match(res2.tail, /override-ok/);
    assert.match(res2.tail, /lint-ok/);

    // 3. Lint failure fails the combined check.
    saveLintOverride(jobs.home, 'node -e "console.log(\'lint-bad\');process.exit(2)"');
    const res3 = await runCombinedCheck(jobs).done;
    assert.equal(res3.status, "fail");
    assert.equal(res3.exitCode, 2);
    assert.match(res3.tail, /lint-bad/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("runCombinedCheck times out and kills process group", async () => {
  const { repo, jobs } = fixture();
  try {
    saveTestOverride(jobs.home, 'node -e "setTimeout(()=>{},60000)"');
    const res = await runCombinedCheck(jobs, { timeoutMs: 400 }).done;
    assert.equal(res.status, "timeout");
    assert.equal(combinedCheckRunning(jobs), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("checkAfterApply setting defaults to false, validates, and triggers combined check via API", async () => {
  const prevHome = process.env.HOME;
  const home = tmp();
  process.env.HOME = home;
  const { repo, jobs, id, cwd } = fixture();
  try {
    assert.equal(DEFAULTS.checkAfterApply, false);
    assert.equal(loadSettings().checkAfterApply, false);
    assert.throws(() => saveSettings({ checkAfterApply: "yes" }), /boolean|true or false/);
    assert.equal(saveSettings({ checkAfterApply: true }).checkAfterApply, true);

    // Prepare a valid diff on the fixture job.
    fs.writeFileSync(path.join(cwd, "README.md"), "updated\n");
    execFileSync("git", ["-C", cwd, "add", "README.md"], { stdio: "pipe" });
    fs.writeFileSync(jobs.file(id, "diff"), execFileSync("git", ["-C", cwd, "diff", "--cached", "--binary", "HEAD"]));
    jobs.save({ ...jobs.get(id), files: ["README.md"] });

    // Configure test + lint commands via POST /api/testcmd.
    initServer({ repo });
    const call = async (method, urlPath, bodyObj) => {
      const req = new PassThrough();
      req.method = method; req.url = urlPath;
      req.headers = { host: "127.0.0.1:4790", "sec-fetch-site": "same-origin", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
      let status = 200; const chunks = [];
      const res = { writeHead(c) { status = c; }, end(d) { if (d) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); } };
      const p = handler(req, res);
      if (method === "POST") req.end(JSON.stringify(bodyObj ?? {})); else req.end();
      await p;
      return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    };

    const cmdRes = await call("POST", "/api/testcmd", {
      command: 'node -e "console.log(\'auto-test-pass\')"',
      lint: 'node -e "console.log(\'auto-lint-pass\')"',
    });
    assert.equal(cmdRes.status, 200);
    assert.match(cmdRes.body.lint, /auto-lint-pass/);

    const mergeRes = await call("POST", `/api/merge/${id}`, {});
    assert.equal(mergeRes.status, 200);

    // Wait for automatic combined check triggered by checkAfterApply=true to settle.
    const deadline = Date.now() + 5000;
    let checkRes;
    while (Date.now() < deadline) {
      checkRes = await call("GET", "/api/combinedcheck");
      if (checkRes.body.check && !checkRes.body.running) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(checkRes.body.check.status, "pass");
    assert.match(checkRes.body.tail, /auto-test-pass/);
    assert.match(checkRes.body.tail, /auto-lint-pass/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("job_test never runs a test script the worker wrote in its worktree (H-2 PoC)", async () => {
  const { jobs, id, cwd } = fixture();
  const { createOrchestratorTools } = await import("../src/mcp.js");
  const marker = path.join(tmp(), "job_test_rce");
  // A prompt-injected worker edits package.json "test" inside its own worktree.
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"` } }));
  jobs.save({ ...jobs.get(id), files: ["package.json"] });
  const tools = createOrchestratorTools({ jobs, permissionMode: "ask" });

  // No user-set command: job_test refuses instead of detecting `npm test` from the worktree.
  let r = await tools.callTool("job_test", { id });
  assert.match(r.text, /no trusted test command/);
  assert.equal(fs.existsSync(marker), false);

  // A user-set `npm test` would still read the worker's package.json: refused while the job changed it.
  saveTestOverride(jobs.home, "npm test");
  r = await tools.callTool("job_test", { id });
  assert.match(r.text, /changed package\.json/);
  assert.equal(fs.existsSync(marker), false);

  // A user-set command that does not go through package.json runs, in the worktree, without API keys or tokens.
  const prev = { k: process.env.OPENAI_API_KEY, t: process.env.HF_TOKEN };
  process.env.OPENAI_API_KEY = "sk-secret"; process.env.HF_TOKEN = "hf-secret";
  try {
    saveTestOverride(jobs.home, `node -e "process.exit(process.env.OPENAI_API_KEY || process.env.HF_TOKEN || !process.cwd().endsWith('${id}') ? 1 : 0)"`);
    r = await tools.callTool("job_test", { id, rerun: true });
    assert.equal(JSON.parse(r.text).status, "pass", r.text);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (prev.k === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev.k;
    if (prev.t === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = prev.t;
  }
});

test("trustedOnly ignores an unconfirmed project-shipped test.json", () => {
  const { jobs, id } = fixture();
  fs.writeFileSync(path.join(jobs.home, "test.json"), JSON.stringify({ command: "node -e 0" }));
  assert.throws(() => runTests(jobs, id, { trustedOnly: true }), /no trusted test command/);
});
