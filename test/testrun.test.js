import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { detectTestCommand, splitCommand, testCommandFor, saveTestOverride, runTests } from "../src/testrun.js";
import { Jobs } from "../src/jobs.js";
import { resolveJobImage, safeRel, captureImages } from "../src/jobimages.js";

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
  assert.deepEqual(testCommandFor(home, d), { cmd: "make", args: ["check"], label: "make check", source: "settings" });
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
