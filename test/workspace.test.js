import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  MAX_FILE_BYTES,
  listRepoFiles,
  readRepoTextFile,
  resolveRepoImage,
  worktreeDiff,
  normalizeChatFilePath,
  chatFiles,
} from "../src/workspace.js";
import { Jobs } from "../src/jobs.js";
import { Chats } from "../src/orchestrator.js";
import { initServer, handler } from "../src/ui.js";
import { parseFileLineRefs, detectLanguage, tokenizeLines, renderHighlightedLinesHtml } from "../ui/workspace.js";
import { renderMarkdownHtml } from "../ui/citations.js";

const tmp = (prefix = "tw-ws-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function callHandler(method, url, { headers = {} } = {}) {
  let status = 200;
  let resHeaders = {};
  const chunks = [];
  const res = {
    writeHead(c, h = {}) { status = c; resHeaders = h; },
    end(d) { if (d) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); },
    on() {},
  };
  await handler(
    { method, url, headers: { host: "127.0.0.1:4777", "sec-fetch-site": "same-origin", ...headers } },
    res,
  );
  const raw = Buffer.concat(chunks);
  const text = raw.toString("utf8");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status, headers: resHeaders, raw, text, json };
}

function initGitRepo(dir) {
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test User");
  return g;
}

async function withTempHome(fn) {
  const home = tmp("tw-ws-home-");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("workspace path confinement and freeagent blocklist", () => {
  const base = tmp("tw-ws-confine-");
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".tokenwise-studio"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".ssh"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(path.join(repo, "src", "ok.luau"), "local x = 1\n", "utf8");
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n", "utf8");
  fs.writeFileSync(path.join(repo, ".env"), "API_KEY=123\n", "utf8");
  fs.writeFileSync(path.join(repo, ".env.production"), "API_KEY=456\n", "utf8");
  fs.writeFileSync(path.join(repo, ".envrc"), "export X=1\n", "utf8");
  fs.writeFileSync(path.join(repo, ".dev.vars"), "TOKEN=abc\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "server.key"), "PRIVATE", "utf8");
  fs.writeFileSync(path.join(repo, "cert.pem"), "CERT", "utf8");
  fs.writeFileSync(path.join(repo, "id_rsa"), "SSH", "utf8");
  fs.writeFileSync(path.join(repo, "credentials.json"), "{}", "utf8");
  fs.writeFileSync(path.join(repo, "secrets.yaml"), "k: v", "utf8");
  fs.writeFileSync(path.join(repo, "ſecrets.json"), "{}", "utf8"); // NFKC lookalike for "secrets.json"
  fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n", "utf8");
  fs.writeFileSync(path.join(repo, ".tokenwise-studio", "chats.json"), "[]", "utf8");
  fs.writeFileSync(path.join(repo, ".ssh", "id_ed25519"), "KEY", "utf8");

  // Symlinks pointing outside repo and internal symlink to secret file
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "escape-file.txt"));
  fs.symlinkSync(outside, path.join(repo, "escape-dir"));
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "src", "alias.txt"));

  try {
    const ok = readRepoTextFile(repo, "src/ok.luau");
    assert.equal(ok.path, "src/ok.luau");
    assert.equal(ok.content, "local x = 1\n");

    const blocked = [
      "../outside/secret.txt",
      "src/../../outside/secret.txt",
      "/etc/passwd",
      "\\etc\\passwd",
      "src/ok.luau\0.txt",
      "escape-file.txt",
      "escape-dir/secret.txt",
      "src/alias.txt",
      ".env",
      ".env.production",
      ".envrc",
      ".dev.vars",
      "src/server.key",
      "cert.pem",
      "id_rsa",
      "credentials.json",
      "secrets.yaml",
      "ſecrets.json",
      ".git/config",
      ".tokenwise-studio/chats.json",
      ".ssh/id_ed25519",
    ];
    for (const p of blocked) {
      assert.throws(() => readRepoTextFile(repo, p), (err) => err && err.status >= 400, `expected refusal for ${p}`);
    }
    assert.throws(() => resolveRepoImage(repo, "escape-file.txt"), (err) => err && err.status >= 400);
    assert.throws(() => resolveRepoImage(repo, "src/ok.luau"), (err) => err && err.status === 415);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("workspace text-only enforcement, maxBytes truncation, 1 MB cap, and UTF-8 safety", () => {
  const repo = tmp("tw-ws-bytes-");
  try {
    // 1. Binary rejection (NUL bytes and binary extension)
    fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(repo, "pixel.png"), pngBytes);

    assert.throws(() => readRepoTextFile(repo, "bin.dat"), /binary/);
    assert.throws(() => readRepoTextFile(repo, "pixel.png"), /binary/);
    const img = resolveRepoImage(repo, "pixel.png");
    assert.equal(img.type, "image/png");

    // 2. maxBytes truncation across multi-byte UTF-8 boundary ("ğ" is 2 bytes)
    fs.writeFileSync(path.join(repo, "tr.txt"), "ağbğc", "utf8"); // bytes: 1 + 2 + 1 + 2 + 1 = 7
    const cut = readRepoTextFile(repo, "tr.txt", { maxBytes: 2 }); // cuts inside first "ğ"
    assert.equal(cut.truncated, true);
    assert.equal(cut.content, "a");
    assert.equal(cut.content.includes("\uFFFD"), false);

    // 3. 1 MB hard cap enforced even when maxBytes > MAX_FILE_BYTES
    const big = Buffer.alloc(MAX_FILE_BYTES + 2048, 0x78); // "x"
    fs.writeFileSync(path.join(repo, "big.txt"), big);
    const readBig = readRepoTextFile(repo, "big.txt", { maxBytes: MAX_FILE_BYTES * 5 });
    assert.equal(readBig.truncated, true);
    assert.equal(readBig.bytesRead, MAX_FILE_BYTES);
    assert.equal(readBig.content.length, MAX_FILE_BYTES);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("workspace ignore rules: respects .gitignore, hides .tokenwise-studio and .git, lazy-loads & pages", () => {
  const repo = tmp("tw-ws-ignore-");
  try {
    const g = initGitRepo(repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\ndist/\n", "utf8");
    fs.mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".tokenwise-studio", "chats"), { recursive: true });

    fs.writeFileSync(path.join(repo, "README.md"), "# Hello\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "a.js"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "b.luau"), "return 1\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "c.py"), "x = 1\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "nested", "deep.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(repo, "debug.log"), "ignored\n", "utf8");
    fs.writeFileSync(path.join(repo, "dist", "bundle.js"), "ignored\n", "utf8");
    // Even if .tokenwise-studio is NOT in .gitignore, it must stay hidden!
    fs.writeFileSync(path.join(repo, ".tokenwise-studio", "state.json"), "{}\n", "utf8");

    g("add", ".gitignore", "README.md", "src/a.js");
    g("commit", "-m", "init");

    // Root listing: lazy (src is a dir entry, not its children), hides .git, .tokenwise-studio, ignored files
    const root = listRepoFiles(repo, { dir: "" });
    const rootNames = root.entries.map((e) => `${e.type}:${e.name}`);
    assert.deepEqual(rootNames, ["dir:src", "file:.gitignore", "file:README.md"]);
    assert.equal(root.entries.some((e) => e.name === ".git" || e.name === ".tokenwise-studio" || e.name === "dist" || e.name === "debug.log"), false);

    // Subdirectory listing + paging
    const page1 = listRepoFiles(repo, { dir: "src", offset: 0, limit: 2 });
    assert.equal(page1.total, 4);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextCursor, 2);
    assert.deepEqual(page1.entries.map((e) => e.name), ["nested", "a.js"]);

    const page2 = listRepoFiles(repo, { dir: "src", offset: page1.nextCursor, limit: 2 });
    assert.equal(page2.hasMore, false);
    assert.equal(page2.nextCursor, null);
    assert.deepEqual(page2.entries.map((e) => e.name), ["b.luau", "c.py"]);

    // Refuses listing .git or .tokenwise-studio directly
    assert.throws(() => listRepoFiles(repo, { dir: ".git" }), (err) => err && err.status === 403);
    assert.throws(() => listRepoFiles(repo, { dir: ".tokenwise-studio" }), (err) => err && err.status === 403);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("worktreeDiff returns staged and unstaged diffs and handles non-git dirs", () => {
  const nonGit = tmp("tw-ws-nongit-");
  const repo = tmp("tw-ws-diff-");
  try {
    assert.deepEqual(worktreeDiff(nonGit), { isGit: false, staged: [], unstaged: [] });

    const g = initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "a.js"), "const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(repo, "b.js"), "const b = 1;\n", "utf8");
    g("add", ".");
    g("commit", "-m", "init");

    fs.writeFileSync(path.join(repo, "a.js"), "const a = 2;\n", "utf8");
    g("add", "a.js");
    fs.writeFileSync(path.join(repo, "b.js"), "const b = 99;\n", "utf8");

    const diff = worktreeDiff(repo);
    assert.equal(diff.isGit, true);
    assert.equal(diff.staged.length, 1);
    assert.equal(diff.staged[0].path, "a.js");
    assert.equal(diff.staged[0].staged, true);
    assert.equal(diff.staged[0].add, 1);
    assert.equal(diff.staged[0].del, 1);

    assert.equal(diff.unstaged.length, 1);
    assert.equal(diff.unstaged[0].path, "b.js");
    assert.equal(diff.unstaged[0].staged, false);
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("file:line link parser extracts valid workspace refs and ignores URLs, hosts, times, and unsafe paths", () => {
  const sample = [
    "Check src/x.luau:42 and (ui/index.html:10-20) and `./README.md:3`.",
    "Also src/ui.js:220:5 and **test/workspace.test.js:12**.",
    "Ignore https://example.com/src/x.luau:42 and http://127.0.0.1:4777/api and file:///etc/passwd:1.",
    "Ignore 127.0.0.1:4777, localhost:3000, example.com:8080/path, 12:30, v1.2:3, foo.js:0.",
    "Ignore ../secret.js:1, /etc/passwd:1, .env:2, .git/config:4, .tokenwise-studio/a.json:1.",
  ].join("\n");

  const refs = parseFileLineRefs(sample);
  assert.deepEqual(
    refs.map((r) => ({ path: r.path, line: r.line, col: r.col, endLine: r.endLine })),
    [
      { path: "src/x.luau", line: 42, col: null, endLine: null },
      { path: "ui/index.html", line: 10, col: null, endLine: 20 },
      { path: "README.md", line: 3, col: null, endLine: null },
      { path: "src/ui.js", line: 220, col: 5, endLine: null },
      { path: "test/workspace.test.js", line: 12, col: null, endLine: null },
    ],
  );

  const html = renderMarkdownHtml("Look at `src/x.luau:42` and ui/index.html:15, not https://example.com/a.js:9.", { fileLinks: true });
  assert.match(html, /<button type="button" class="file-ref code-ref" data-file="src\/x\.luau" data-line="42"[^>]*><code>src\/x\.luau:42<\/code><\/button>/);
  assert.match(html, /<button type="button" class="file-ref" data-file="ui\/index\.html" data-line="15"[^>]*>ui\/index\.html:15<\/button>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\.js:9"/);
  assert.equal(/data-file="https:/.test(html), false);
});

test("syntax highlighter supports lua/luau, js/ts, json, md, py and escapes HTML", () => {
  assert.equal(detectLanguage("src/main.luau"), "lua");
  assert.equal(detectLanguage("src/app.tsx"), "js");
  assert.equal(detectLanguage("package.json"), "json");
  assert.equal(detectLanguage("README.md"), "md");
  assert.equal(detectLanguage("tool.py"), "py");
  assert.equal(detectLanguage("notes.unknown"), "plain");

  const luaHtml = renderHighlightedLinesHtml("--[[ multi\ncomment ]]\nlocal x = \"<tag>\" .. tostring(42)", "lua", { highlightLine: 3 });
  assert.match(luaHtml, /data-line="3"/);
  assert.match(luaHtml, /cv-line is-target/);
  assert.match(luaHtml, /tok-com/);
  assert.match(luaHtml, /tok-kw">local<\/span>/);
  assert.match(luaHtml, /&lt;tag&gt;/);
  assert.equal(luaHtml.includes("<tag>"), false);

  const jsonToks = tokenizeLines('{"name": "tw", "ok": true, "n": 3}', "json")[0];
  assert.ok(jsonToks.some((t) => t.type === "key" && t.value === '"name"'));
  assert.ok(jsonToks.some((t) => t.type === "str" && t.value === '"tw"'));
  assert.ok(jsonToks.some((t) => t.type === "lit" && t.value === "true"));
  assert.ok(jsonToks.some((t) => t.type === "num" && t.value === "3"));

  const pyToks = tokenizeLines('@dec\ndef f():\n  """doc"""\n  return None', "py");
  assert.equal(pyToks[0][0].type, "type");
  assert.equal(pyToks[1][0].type, "kw");
  assert.equal(pyToks[2][1].type, "str");
  assert.ok(pyToks[3].some((t) => t.type === "lit" && t.value === "None"));

  const mdToks = tokenizeLines("# Title\n- item `code`", "md");
  assert.equal(mdToks[0][0].type, "hd");
  assert.ok(mdToks[1].some((t) => t.type === "str" && t.value === "`code`"));
});

test("HTTP workspace endpoints enforce Host check and serve /api/files, /api/file, /api/file-raw, /api/worktree-diff", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-ws-http-");
    try {
      const g = initGitRepo(repo);
      fs.writeFileSync(path.join(repo, "hello.js"), "const hi = 1;\n", "utf8");
      fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n", "utf8");
      fs.writeFileSync(path.join(repo, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
      g("add", "hello.js", "logo.svg");
      g("commit", "-m", "init");
      fs.writeFileSync(path.join(repo, "hello.js"), "const hi = 2;\n", "utf8");

      initServer({ repo });

      const filesRes = await callHandler("GET", "/api/files");
      assert.equal(filesRes.status, 200);
      assert.ok(filesRes.json.entries.some((e) => e.name === "hello.js"));

      const fileRes = await callHandler("GET", "/api/file?path=hello.js");
      assert.equal(fileRes.status, 200);
      assert.equal(fileRes.json.content, "const hi = 2;\n");

      const envRes = await callHandler("GET", "/api/file?path=.env");
      assert.equal(envRes.status, 403);

      const rawRes = await callHandler("GET", "/api/file-raw?path=logo.svg");
      assert.equal(rawRes.status, 200);
      assert.match(rawRes.headers["content-type"] || "", /image\/svg\+xml/);

      const diffRes = await callHandler("GET", "/api/worktree-diff");
      assert.equal(diffRes.status, 200);
      assert.equal(diffRes.json.unstaged.length, 1);
      assert.equal(diffRes.json.unstaged[0].path, "hello.js");

      const wsJsRes = await callHandler("GET", "/workspace.js");
      assert.equal(wsJsRes.status, 200);
      assert.match(wsJsRes.text, /export function parseFileLineRefs/);

      // Host header check on all GET endpoints
      for (const p of ["/api/files", "/api/file?path=hello.js", "/api/file-raw?path=logo.svg", "/api/worktree-diff"]) {
        const bad = await callHandler("GET", p, { headers: { host: "evil.example" } });
        assert.equal(bad.status, 403, `expected 403 for foreign Host on ${p}`);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("normalizeChatFilePath confines paths and blocks secrets/URLs/traversal", () => {
  const repo = "/tmp/my-repo";
  const cwd = "/tmp/my-repo/.tokenwise-studio/worktrees/j1";
  assert.equal(normalizeChatFilePath("src/app.js", { repo }), "src/app.js");
  assert.equal(normalizeChatFilePath("./README.md", { repo }), "README.md");
  assert.equal(normalizeChatFilePath("/tmp/my-repo/src/app.js", { repo }), "src/app.js");
  assert.equal(normalizeChatFilePath(`${cwd}/src/new.js`, { repo, cwd }), "src/new.js");
  assert.equal(normalizeChatFilePath("https://example.com/a.js", { repo }), null);
  assert.equal(normalizeChatFilePath("/etc/passwd", { repo }), null);
  assert.equal(normalizeChatFilePath("../secret.txt", { repo }), null);
  assert.equal(normalizeChatFilePath(".env", { repo }), null);
  assert.equal(normalizeChatFilePath(".env.local", { repo }), null);
  assert.equal(normalizeChatFilePath("credentials.json", { repo }), null);
  assert.equal(normalizeChatFilePath(".git/config", { repo }), null);
  assert.equal(normalizeChatFilePath(".tokenwise-studio/chats/c1.json", { repo }), null);
  assert.equal(normalizeChatFilePath("src/", { repo }), null);
});

test("chatFiles aggregates orchestrator reads and worker diffs (new/edited/applied/read), grouped newest first, and serves /api/chatfiles/:id", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-ws-chatfiles-");
    try {
      const g = initGitRepo(repo);
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.writeFileSync(path.join(repo, "README.md"), "# App\n", "utf8");
      fs.writeFileSync(path.join(repo, "src", "a.js"), "export const a = 1;\n", "utf8");
      fs.writeFileSync(path.join(repo, "src", "b.js"), "export const b = 1;\n", "utf8");
      fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n", "utf8");
      g("add", "README.md", "src/a.js", "src/b.js");
      g("commit", "-m", "init");

      const jobs = new Jobs(repo);
      const chats = new Chats(jobs);
      const chatId = "chat-1";
      chats.save({ id: chatId, title: "Refactor", created: "2026-11-15T00:00:00.000Z", turns: [] });
      chats.save({ id: "chat-other", title: "Other", created: "2026-11-15T00:00:00.000Z", turns: [] });

      // Orchestrator log events: Read README.md (t=100), Read src/b.js (t=200), Read README.md again (t=500),
      // plus WebFetch URL, outside path, .env (all must be filtered out).
      const claudeTool = (name, input) => JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name, input }] },
      });
      const chatLines = [
        { t: 100, stream: "out", agent: "claude", line: claudeTool("Read", { file_path: path.join(repo, "README.md") }) },
        { t: 200, stream: "out", agent: "claude", line: claudeTool("Read", { file_path: "src/b.js" }) },
        { t: 250, stream: "out", agent: "claude", line: claudeTool("Read", { file_path: ".env" }) },
        { t: 260, stream: "out", agent: "claude", line: claudeTool("Read", { file_path: "/etc/passwd" }) },
        { t: 270, stream: "out", agent: "claude", line: claudeTool("WebFetch", { url: "https://example.com/docs" }) },
        { t: 280, stream: "out", agent: "claude", line: claudeTool("Read", { file_path: "src" }) },
        { t: 500, stream: "out", agent: "claude", line: claudeTool("Read", { file_path: "./README.md" }) },
      ];
      fs.writeFileSync(chats.f(chatId, "jsonl"), chatLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      // Unapplied finished write job (j-done): edits src/b.js and creates src/new-util.js
      jobs.save({
        id: "j-done",
        parent: chatId,
        agent: "codex",
        model: "sol",
        effort: "medium",
        title: "Add helper",
        write: true,
        status: "done",
        created: "2026-11-15T00:01:00.000Z",
        finished: "2026-11-15T00:02:00.000Z",
        files: ["src/b.js", "src/new-util.js"],
      });
      fs.writeFileSync(jobs.file("j-done", "diff"), [
        "diff --git a/src/b.js b/src/b.js",
        "index 1111111..2222222 100644",
        "--- a/src/b.js",
        "+++ b/src/b.js",
        "@@ -1 +1,2 @@",
        " export const b = 1;",
        "+export const b2 = 2;",
        "diff --git a/src/new-util.js b/src/new-util.js",
        "new file mode 100644",
        "index 0000000..3333333",
        "--- /dev/null",
        "+++ b/src/new-util.js",
        "@@ -0,0 +1 @@",
        "+export const u = 1;",
        "",
      ].join("\n"));

      // Applied write job (j-merged): partial apply (only src/a.js applied; src/ignored.js dropped)
      jobs.save({
        id: "j-merged",
        parent: chatId,
        agent: "claude",
        model: "sonnet",
        effort: "low",
        title: "Update a.js",
        write: true,
        status: "merged",
        created: "2026-11-15T00:00:30.000Z",
        finished: "2026-11-15T00:01:00.000Z",
        files: ["src/a.js", "src/ignored.js"],
        applied: ["src/a.js"],
      });
      fs.writeFileSync(jobs.file("j-merged", "diff"), [
        "diff --git a/src/a.js b/src/a.js",
        "index 1111111..4444444 100644",
        "--- a/src/a.js",
        "+++ b/src/a.js",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export const a2 = 2;",
        "",
      ].join("\n"));

      // Worker read job (free worker reads src/c.js successfully and fails on missing.js)
      jobs.save({
        id: "j-read",
        parent: chatId,
        agent: "free",
        model: "auto",
        effort: "low",
        title: "Inspect c.js",
        write: false,
        status: "done",
        created: "2026-11-15T00:00:10.000Z",
        finished: "2026-11-15T00:00:20.000Z",
        files: [],
      });
      fs.writeFileSync(jobs.file("j-read", "log"), [
        JSON.stringify({ t: 350, stream: "out", line: JSON.stringify({ type: "free.tool", kind: "read", text: "src/c.js" }) }),
        JSON.stringify({ t: 360, stream: "out", line: JSON.stringify({ type: "free.tool", kind: "read", text: "missing.js", error: "ENOENT" }) }),
      ].join("\n") + "\n");

      // Discarded and undone jobs + other chat job must not leak into chat-1
      jobs.save({ id: "j-disc", parent: chatId, agent: "codex", write: true, status: "discarded", created: "2026-11-15T00:03:00.000Z", files: ["src/discarded.js"] });
      jobs.save({ id: "j-undo", parent: chatId, agent: "codex", write: true, status: "undone", created: "2026-11-15T00:03:10.000Z", files: ["src/undone.js"], applied: ["src/undone.js"] });
      jobs.save({ id: "j-other", parent: "chat-other", agent: "codex", write: true, status: "done", created: "2026-11-15T00:04:00.000Z", files: ["src/other-chat.js"] });

      const result = chatFiles({ repo, chats, jobs, chatId });
      assert.equal(result.chatId, chatId);
      assert.deepEqual(result.counts, { unapplied: 2, changed: 0, applied: 1, read: 2, total: 5 });

      // Check grouping order: unapplied (newest/seq first) -> applied -> read (newest first)
      assert.deepEqual(
        result.files.map((f) => ({ path: f.path, action: f.action, group: f.group, unapplied: f.unapplied })),
        [
          { path: "src/new-util.js", action: "new", group: "unapplied", unapplied: true },
          { path: "src/b.js", action: "edited", group: "unapplied", unapplied: true },
          { path: "src/a.js", action: "applied", group: "applied", unapplied: false },
          { path: "README.md", action: "read", group: "read", unapplied: false },
          { path: "src/c.js", action: "read", group: "read", unapplied: false },
        ],
      );
      assert.equal(result.files[0].jobId, "j-done");
      assert.equal(result.files[0].add, 1);
      assert.equal(result.files[1].jobId, "j-done");
      assert.equal(result.files[2].jobId, "j-merged");

      // HTTP endpoint verification
      initServer({ repo });
      const res = await callHandler("GET", `/api/chatfiles/${chatId}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.counts, result.counts);
      assert.equal(res.json.files.length, 5);

      const missingRes = await callHandler("GET", "/api/chatfiles/does-not-exist");
      assert.equal(missingRes.status, 404);

      const badHost = await callHandler("GET", `/api/chatfiles/${chatId}`, { headers: { host: "evil.example" } });
      assert.equal(badHost.status, 403);

      const htmlRes = await callHandler("GET", "/");
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.text, /id="ws-tab-chat"/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
