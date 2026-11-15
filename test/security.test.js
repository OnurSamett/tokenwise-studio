// Regression tests for the v0.10.0 security audit fixes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { resolveTool, untrustedDirs } from "../src/resolve.js";
import { installArgs, latestVersion, verifyLatestRelease, cachedLatest, TAG_RE } from "../src/version.js";
import { allowed, handler, initServer } from "../src/ui.js";
import { parseFileLineRefs } from "../ui/workspace.js";
import { renderMarkdownHtml, parseCitations } from "../ui/citations.js";
import { testEnv, runCombinedCheck, isTestConfigConfirmed, confirmTestConfig } from "../src/testrun.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = (p = "tw-sec-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---- C1 / H2: no npm registry path, commit-pinned updates ----

test("no code path installs or queries the npm registry package", () => {
  for (const f of ["src/version.js", "src/autoupdate.js", "src/cli.js", "docs/install.sh", "docs/install.ps1"]) {
    const t = readSrc(f);
    assert.ok(!/registry\.npmjs\.org/.test(t.replace(/^\s*(#|\/\/).*$/gm, "")), `${f} mentions the registry`);
    assert.ok(!/npm view|tokenwise-studio@latest/.test(t), `${f} queries or installs the npm package`);
  }
  assert.ok(/#\$sha/.test(readSrc("docs/install.ps1")) && /#\$sha/.test(readSrc("docs/install.sh")));
});

test("installArgs requires a release tag and pins its verified commit", () => {
  assert.deepEqual(installArgs("v0.10.1", SHA.toUpperCase()), ["install", "-g", "--ignore-scripts", `github:OnurSamett/tokenwise-studio#${SHA}`]);
  for (const bad of [undefined, "", "main", "latest", "0.10.1", "v1.2", "v1.2.3-beta", "v1.2.3 --foo", "../v1.2.3"]) assert.throws(() => installArgs(bad, SHA), /validated release tag/);
  for (const commit of [undefined, "", "main", "a".repeat(39), "g".repeat(40), SHA + ";echo x"]) assert.throws(() => installArgs("v0.10.1", commit));
  assert.ok(TAG_RE.test("v10.20.30"));
});

const SHA = "a".repeat(40);
function fakeGithub({ tag = "v0.11.0", draft = false, prerelease = false, assets = [{ name: "SHA256SUMS.txt" }], target = "main", tagSha = SHA, cmp = "ahead", pkgVersion = "0.11.0", tagObject = false } = {}) {
  const urls = [];
  const json = (o, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => o });
  const fn = async (url) => {
    urls.push(String(url));
    const u = String(url);
    if (u.endsWith("/releases/latest")) return json({ tag_name: tag, draft, prerelease, assets, target_commitish: target });
    if (u.includes("/git/ref/tags/")) return json({ object: tagObject ? { type: "tag", sha: "b".repeat(40) } : { type: "commit", sha: tagSha } });
    if (u.includes("/git/tags/")) return json({ object: { type: "commit", sha: tagSha } });
    if (u.includes("/compare/")) return json({ status: cmp });
    if (u.endsWith("/package.json")) return json({ version: pkgVersion });
    return json({}, false);
  };
  return { fn, urls };
}

test("verifyLatestRelease accepts a consistent release and rejects every inconsistency", async () => {
  const ok = fakeGithub();
  assert.deepEqual(await verifyLatestRelease(ok.fn), { version: "0.11.0", tag: "v0.11.0", commit: SHA, source: "github" });
  assert.ok(ok.urls.every((u) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(u)), "only GitHub is contacted");
  assert.ok((await verifyLatestRelease(fakeGithub({ tagObject: true }).fn)).commit === SHA, "annotated tags are dereferenced");
  assert.ok(await verifyLatestRelease(fakeGithub({ target: SHA }).fn), "sha target equal to tag commit");
  for (const [name, o] of Object.entries({
    badTag: { tag: "release-1" }, draft: { draft: true }, prerelease: { prerelease: true }, noSums: { assets: [{ name: "app.dmg" }] },
    shaMismatch: { target: "c".repeat(40) }, notContained: { cmp: "diverged" }, behind: { cmp: "behind" }, pkgMismatch: { pkgVersion: "0.9.0" },
  })) await assert.rejects(verifyLatestRelease(fakeGithub(o).fn), undefined, name);
});

test("latestVersion: GitHub only, caches a tag, ignores old npm-era cache entries", async () => {
  const home = tmp("tw-sec-home-"), prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const cache = path.join(home, ".tokenwise-studio", "update.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ version: "9.9.9", source: "npm", checkedAt: Date.now() })); // fresh but from the registry
    const gh = fakeGithub();
    const r = await latestVersion({ fetchFn: gh.fn });
    assert.deepEqual(r, { version: "0.11.0", tag: "v0.11.0", commit: SHA, source: "github" });
    assert.ok(!gh.urls.some((u) => /npmjs/.test(u)));
    assert.equal(JSON.parse(fs.readFileSync(cache, "utf8")).tag, "v0.11.0");
    const again = await latestVersion({ fetchFn: async () => { throw new Error("must use cache"); } });
    assert.equal(again.tag, "v0.11.0");
    assert.equal(again.commit, SHA);
    for (const commit of [undefined, "not-a-sha", "b".repeat(39)]) {
      fs.writeFileSync(cache, JSON.stringify({ version: "0.11.0", tag: "v0.11.0", source: "github", checkedAt: Date.now(), commit }));
      assert.equal(cachedLatest(), null, "cache without a valid commit is a miss");
    }
    assert.equal(await latestVersion({ force: true, fetchFn: fakeGithub({ draft: true }).fn }), null, "unverified release is not offered");
  } finally { process.env.HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- H1: tool resolution never trusts the cwd / project dirs ----

function fakeFs(files) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return { statSync: (p) => { if (!set.has(String(p).toLowerCase())) throw new Error("ENOENT"); return { isFile: () => true }; }, accessSync() {} };
}

test("resolveTool (win32): skips relative PATH entries, the cwd and project dirs; honors PATHEXT", () => {
  const files = ["C:\\proj\\git.cmd", "C:\\proj\\git.exe", "C:\\proj\\bin\\git.exe", "C:\\wt\\git.cmd", "C:\\tools\\git.exe", "C:\\tools\\claude.cmd"];
  const env = { Path: ";.;bin;C:\\proj;C:\\wt;\"C:\\tools\"", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const opt = { platform: "win32", env, cwd: "C:\\proj", avoid: ["C:\\wt"], fsx: fakeFs(files) };
  assert.equal(resolveTool("git", opt), "C:\\tools\\git.exe");
  assert.equal(resolveTool("claude", opt), "C:\\tools\\claude.cmd");
  // Only planted copies exist: nothing is resolved (callers must not fall back to the bare name).
  const planted = { ...opt, fsx: fakeFs(["C:\\proj\\git.cmd", "C:\\wt\\git.cmd", "C:\\proj\\bin\\git.exe"]) };
  assert.equal(resolveTool("git", planted), null);
  // Case-insensitive directory match on Windows, trailing slash tolerated.
  assert.equal(resolveTool("git", { ...opt, env: { Path: "c:\\PROJ\\" }, fsx: fakeFs(files) }), null);
  // Names with a path are never searched.
  assert.equal(resolveTool("..\\git", opt), null);
  assert.equal(resolveTool("C:\\tools\\git.exe", opt), "C:\\tools\\git.exe");
});

test("resolveTool (posix): empty and relative PATH entries are skipped", () => {
  const opt = { platform: "linux", env: { PATH: ":.:rel:/usr/bin" }, cwd: "/work/proj", fsx: fakeFs(["/work/proj/git", "/usr/bin/git"]) };
  assert.equal(resolveTool("git", opt), "/usr/bin/git");
  assert.equal(resolveTool("git", { ...opt, env: { PATH: "/work/proj:/usr/bin" }, fsx: fakeFs(["/work/proj/git"]) }), null);
});

test("Windows server starts with the app dir, not the project, as cwd", () => {
  const cs = readSrc("windows/TokenwiseStudio/Program.cs");
  assert.match(cs, /new ProcessStartInfo\(node\) \{ WorkingDirectory = AppDir/);
});

// ---- M1: ReDoS ----

test("markdown link / file:line scanners stay linear on adversarial 5 KB input", () => {
  const evil = [
    "[x](" + "a(".repeat(2500), "[".repeat(5000), "[x](" + "(a)".repeat(1700), "a".repeat(5000), "a/".repeat(2500),
    "[1] " + "[x](".repeat(1200), "x".repeat(2500) + ":", "http".repeat(1250), "[" + "a".repeat(4990) + "]( ",
  ];
  for (const s of evil) {
    const t0 = performance.now();
    parseFileLineRefs(s); renderMarkdownHtml(s); parseCitations("[1] " + s);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${ms.toFixed(1)}ms on ${JSON.stringify(s.slice(0, 20))}`);
  }
});

test("scanners still work after the ReDoS fix", () => {
  assert.equal(renderMarkdownHtml("see [site](https://example.com/a_(b)) now").includes('href="https://example.com/a_(b)"'), true);
  assert.equal(renderMarkdownHtml("[x](javascript:alert(1))").includes("<a "), false);
  const refs = parseFileLineRefs("first\nsee src/a.js:12 and (lib/b.ts:3:4)\n" + "z".repeat(3000) + " c.js:1");
  assert.deepEqual(refs.map((r) => [r.path, r.line]), [["src/a.js", 12], ["lib/b.ts", 3]]);
  assert.equal(refs[0].index, "first\nsee ".length);
});

// ---- M3: cross-site GET and framing ----

const req = (headers, url = "/api/state", method = "GET") => ({ method, url, headers: { host: "127.0.0.1:4790", ...headers } });

test("allowed(): /api GET needs same-origin / none Sec-Fetch-Site or x-tokenwise; other GETs unaffected", () => {
  assert.equal(allowed(req({})), false, "no signal at all");
  assert.equal(allowed(req({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(allowed(req({ "sec-fetch-site": "same-site" })), false, "another localhost port is same-site");
  assert.equal(allowed(req({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(allowed(req({ referer: "http://127.0.0.1:4790/chat" })), true);
  for (const referer of ["http://127.0.0.1:4791/", "http://localhost:4790/", "http://evil.example/", "invalid", "file:///tmp/x"]) assert.equal(allowed(req({ referer })), false);
  assert.equal(allowed(req({ referer: "http://127.0.0.1:4790/", "sec-fetch-site": "cross-site" })), false);
  assert.equal(allowed(req({ "sec-fetch-site": "none" })), true);
  assert.equal(allowed(req({ "x-tokenwise": "1" })), true);
  assert.equal(allowed(req({ "sec-fetch-site": "cross-site" }, "/")), true, "the page itself may be fetched");
  assert.equal(allowed(req({ "sec-fetch-site": "same-origin", host: "evil.example" })), false, "host check still applies");
});

async function call(headers, url, method = "GET") {
  const r = new PassThrough(); r.method = method; r.url = url; r.headers = { host: "127.0.0.1:4790", ...headers };
  let status = 200, head = {}; const chunks = [];
  const res = { writeHead(c, h) { status = c; head = h || {}; }, end(d) { if (d) chunks.push(Buffer.from(String(d))); }, on() {} };
  const p = handler(r, res); r.end(); await p;
  return { status, head, body: Buffer.concat(chunks).toString() };
}

test("handler: cross-site /api GET is refused, HTML carries frame protections", async () => {
  const home = tmp("tw-sec-home-"), repo = tmp("tw-sec-repo-"), prev = process.env.HOME;
  process.env.HOME = home;
  try {
    initServer({ repo });
    assert.ok(untrustedDirs().includes(repo));
    assert.equal((await call({ "sec-fetch-site": "cross-site" }, "/api/doctor")).status, 403);
    assert.equal((await call({}, "/api/models")).status, 403);
    assert.equal((await call({ "sec-fetch-site": "same-origin" }, "/api/state")).status, 200);
    assert.equal((await call({ "x-tokenwise": "1" }, "/api/state")).status, 200);
    assert.equal((await call({ referer: "http://127.0.0.1:4790/" }, "/api/state")).status, 200);
    const page = await call({ "sec-fetch-site": "none" }, "/");
    assert.equal(page.status, 200);
    assert.equal(page.head["content-security-policy"], "frame-ancestors 'none'");
    assert.equal(page.head["x-frame-options"], "DENY");
  } finally { process.env.HOME = prev; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("Swift launcher and Windows client send x-tokenwise on /api GET health checks", () => {
  assert.match(readSrc("launcher/TokenwiseStudio.swift"), /req\.httpMethod = "GET"\n\s+req\.setValue\("1", forHTTPHeaderField: "x-tokenwise"\)/);
  assert.match(readSrc("windows/TokenwiseStudio/Program.cs"), /probe\.Headers\.Add\("x-tokenwise", "1"\)/);
});

// ---- M2 / L1: Swift navigation pinning (source-level, the app is not runnable in CI) ----

test("Swift launcher pins the server origin, restricts external schemes and confirms unknown folders", () => {
  const sw = readSrc("launcher/TokenwiseStudio.swift");
  assert.match(sw, /func sameOrigin\(/);
  assert.match(sw, /sameOrigin\(url, pinnedServer\)/);
  assert.match(sw, /messageOriginIsPinned\(message\.frameInfo\.securityOrigin\)/);
  assert.ok(!/isLocalHost\(message\.frameInfo/.test(sw));
  assert.match(sw, /isSafeExternalScheme\(url\.scheme\) \{ NSWorkspace\.shared\.open/);
  assert.match(sw, /validateSchemeLink\(repo: q\("repo"\), url: q\("url"\)\)/);
  assert.match(sw, /confirmOpenFromLink/);
});

// ---- L5: test environment and repo-provided commands ----

test("testEnv strips API keys and tokens, keeps the rest", () => {
  const env = testEnv({
    PATH: "/bin", HOME: "/h", NODE_ENV: "x",
    NVIDIA_API_KEY: "1", OPENROUTER_API_KEY: "1", GROQ_API_KEY: "1", MISTRAL_API_KEY: "1", TOKENWISE_FREE_KEY: "1",
    ANTHROPIC_API_KEY: "1", OPENAI_API_KEY: "1", GEMINI_API_KEY: "1", GOOGLE_API_KEY: "1", GITHUB_TOKEN: "1", FOO_API_KEY: "1", AWS_SECRET_ACCESS_KEY: "1",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "NODE_ENV", "PATH"]);
});

test("a repo-provided test command needs confirmation before it runs; edits need it again", async () => {
  const home = tmp("tw-sec-home-"), repo = tmp("tw-sec-repo-"), prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const twHome = path.join(repo, ".tokenwise-studio");
    fs.mkdirSync(twHome, { recursive: true });
    const marker = path.join(repo, "ran.txt");
    const shipped = (cmd) => fs.writeFileSync(path.join(twHome, "test.json"), JSON.stringify({ command: cmd }));
    shipped(`node -e "require('fs').writeFileSync('ran.txt','1')"`);
    const jobs = { home: twHome, repo, combinedChecking: null };
    assert.equal(isTestConfigConfirmed(twHome), false);
    assert.throws(() => runCombinedCheck(jobs), (e) => e.needsConfirmation && /test\.json/.test(e.message));
    assert.equal(fs.existsSync(marker), false, "nothing ran");
    const { done } = runCombinedCheck(jobs, { confirm: true });
    assert.equal((await done).status, "pass");
    assert.equal(fs.existsSync(marker), true);
    assert.equal(isTestConfigConfirmed(twHome), true);
    assert.equal((await runCombinedCheck(jobs).done).status, "pass", "confirmed once, unchanged command");
    shipped(`node -e "0"`);
    assert.throws(() => runCombinedCheck(jobs), (e) => e.needsConfirmation);
    confirmTestConfig(twHome);
    assert.equal(isTestConfigConfirmed(twHome), true);
  } finally { process.env.HOME = prev; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("test children do not inherit API keys", async () => {
  const home = tmp("tw-sec-home-"), repo = tmp("tw-sec-repo-"), prev = process.env.HOME, prevKey = process.env.OPENAI_API_KEY;
  process.env.HOME = home; process.env.OPENAI_API_KEY = "sk-secret";
  try {
    const twHome = path.join(repo, ".tokenwise-studio");
    fs.mkdirSync(twHome, { recursive: true });
    fs.writeFileSync(path.join(twHome, "test.json"), JSON.stringify({ command: `node -e "process.exit(process.env.OPENAI_API_KEY?1:0)"` }));
    const r = await runCombinedCheck({ home: twHome, repo, combinedChecking: null }, { confirm: true }).done;
    assert.equal(r.status, "pass");
  } finally { process.env.HOME = prev; if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

// ---- L3 / L6 ----

test("build scripts: npm ci ignores scripts, node version validated, stale TODO removed; shrinkwrap shipped", () => {
  assert.match(readSrc("scripts/build-dmg.sh"), /npm ci[^\n]*--ignore-scripts/);
  assert.ok(!/TODO: fill/.test(readSrc("scripts/build-dmg.sh")));
  assert.match(readSrc("scripts/select-node.mjs"), /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/);
  assert.ok(fs.existsSync(path.join(ROOT, "npm-shrinkwrap.json")));
  assert.equal(readSrc("npm-shrinkwrap.json"), readSrc("package-lock.json"), "regenerate: cp package-lock.json npm-shrinkwrap.json");
  assert.equal(JSON.parse(readSrc("package.json")).dependencies.zod, "4.6.7");
});


test("Mac app and Sparkle builds require macOS 13.3", () => {
  assert.match(readSrc("src/cli.js"), /<key>LSMinimumSystemVersion<\/key><string>13\.3<\/string>/);
  assert.match(readSrc("scripts/build-dmg.sh"), /Print :LSMinimumSystemVersion[^\n]*13\.3/);
  assert.match(readSrc("scripts/update-appcast.mjs"), /<sparkle:minimumSystemVersion>13\.3</);
});

test("new and restored worktrees register as untrusted", () => {
  assert.match(readSrc("src/jobs.js"), /addUntrustedDir\(cwd\)/);
  assert.match(readSrc("src/jobs.js"), /addUntrustedDir\(path.join\(this.home, "worktrees", root\)\)/);
  assert.match(readSrc("src/conflicts.js"), /addUntrustedDir\(newCwd\)/);
  assert.match(readSrc("windows/TokenwiseStudio/Program.cs"), /info.Environment\["NoDefaultCurrentDirectoryInExePath"\] = "1"/);
});
