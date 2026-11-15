import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { ROLES, PRESETS, DEFAULT_TEAM, loadTeam, saveTeam, teamOptions, teamGuide } from "../src/team.js";
import { command } from "../src/workers.js";
import { available, nextAgent } from "../src/fallback.js";
import { Jobs } from "../src/jobs.js";
import { buildGuide } from "../src/orchestrator.js";
import { normalize } from "../src/events.js";
import { handler, initServer } from "../src/ui.js";
import { safeHttpUrl, parseCitations, renderMarkdownHtml } from "../ui/citations.js";

const tmp = (prefix = "tw-research-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function withTempHome(fn) {
  const prev = process.env.HOME;
  const home = tmp("tw-rhome-");
  process.env.HOME = home;
  const cleanup = () => {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  };
  try {
    const r = fn(home);
    if (r && typeof r.then === "function") return r.finally(cleanup);
    cleanup();
    return r;
  } catch (e) {
    cleanup();
    throw e;
  }
}

async function callHandler(method, urlPath, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", "sec-fetch-site": "same-origin", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
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
  const isJson = String(headers["content-type"] || "").includes("application/json");
  return { status, headers, text, body: isJson && text ? JSON.parse(text) : null };
}

test("team.js includes research role, presets, and marks free unsupported in teamOptions", () => {
  assert.ok(ROLES.includes("research"));
  assert.deepEqual(PRESETS.quality.research, { agent: "claude", model: "sonnet", effort: "high" });
  assert.deepEqual(PRESETS.balanced.research, { agent: "gemini", model: "hydrogen", effort: "medium" });
  assert.deepEqual(PRESETS.cheap.research, { agent: "gemini", model: "hydrogen", effort: "low" });
  assert.deepEqual(DEFAULT_TEAM.roles.research, PRESETS.balanced.research);

  withTempHome(() => {
    const dir = tmp("tw-team-");
    try {
      for (const preset of ["quality", "balanced", "cheap"]) {
        const saved = saveTeam(dir, { mode: "manual", preset, roles: PRESETS[preset], allow: { free: true, astra: false } });
        assert.deepEqual(saved.roles.research, PRESETS[preset].research);
        assert.deepEqual(loadTeam(dir).roles.research, PRESETS[preset].research);
      }

      const opts = teamOptions();
      assert.ok(opts.roles.some((r) => r.id === "research"));
      assert.ok(opts.agents.free.unsupportedRoles.includes("research"));
      assert.equal(opts.agents.local, undefined);
      assert.deepEqual(opts.agents.claude.unsupportedRoles, []);
      assert.deepEqual(opts.agents.gemini.unsupportedRoles, []);
      assert.deepEqual(opts.agents.codex.unsupportedRoles, []);
      const resRole = opts.roles.find((r) => r.id === "research");
      assert.deepEqual(resRole.unsupportedAgents, ["free"]);
      const imgRole = opts.roles.find((r) => r.id === "images");
      assert.deepEqual(imgRole.supportedAgents, ["codex"]);

      const gQuality = teamGuide({ mode: "manual", roles: PRESETS.quality, allow: { free: true, astra: false } });
      assert.match(gQuality, /Web research: claude sonnet \(high effort\)/);
      const gCheap = teamGuide({ mode: "manual", roles: PRESETS.cheap, allow: { free: true, astra: false } });
      assert.match(gCheap, /Web research: gemini hydrogen \(low effort\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("orchestrator GUIDE teaches read-only role=research delegation with inline [1] citations and Sources", () => {
  for (const mode of ["ask", "auto-apply", "plan-only"]) {
    const guide = buildGuide(mode);
    assert.match(guide, /role="research"/);
    assert.match(guide, /write=false/);
    assert.match(guide, /\[1\]/);
    assert.match(guide, /Sources/);
    assert.match(guide, /actually opened/i);
  }
});

test("workers.js enables web search only for research jobs on Claude and Codex", () => {
  const cResearch = command(
    { agent: "claude", model: "sonnet", effort: "high" },
    { task: "find latest node", cwd: "/tmp", write: false, role: "research", lastFile: "/tmp/last.txt" },
  );
  assert.equal(cResearch.cmd, "claude");
  assert.ok(cResearch.args.includes("--allowedTools"));
  assert.ok(cResearch.args.includes("WebSearch"));
  assert.ok(cResearch.args.includes("WebFetch"));

  const cResearchImg = command(
    { agent: "claude", model: "sonnet", effort: "high" },
    { task: "find latest node", cwd: "/tmp", write: false, role: "research", lastFile: "/tmp/last.txt", images: ["/tmp/a.png"] },
  );
  assert.ok(cResearchImg.args.includes("Read"));
  assert.ok(cResearchImg.args.includes("WebSearch"));
  assert.ok(cResearchImg.args.includes("WebFetch"));

  for (const nonResearch of [null, undefined, "code", "quick", "review"]) {
    const cOther = command(
      { agent: "claude", model: "sonnet", effort: "medium" },
      { task: "read files", cwd: "/tmp", write: false, role: nonResearch, lastFile: "/tmp/last.txt" },
    );
    assert.equal(cOther.args.includes("WebSearch"), false);
    assert.equal(cOther.args.includes("WebFetch"), false);
  }

  const xResearch = command(
    { agent: "codex", model: "gpt-5.3-codex", effort: "medium" },
    { task: "find latest node", cwd: "/tmp", write: false, role: "research", lastFile: "/tmp/last.txt" },
  );
  assert.equal(xResearch.cmd, "codex");
  assert.ok(xResearch.args.includes('web_search="live"'));
  assert.equal(xResearch.args.includes('web_search="disabled"'), false);

  const xCode = command(
    { agent: "codex", model: "gpt-5.3-codex", effort: "medium" },
    { task: "edit files", cwd: "/tmp", write: false, role: "code", lastFile: "/tmp/last.txt" },
  );
  assert.equal(xCode.args.includes('web_search="live"'), false);
  assert.ok(xCode.args.includes('web_search="disabled"'));
});

test("fallback.js and jobs.js enforce research read-only and skip free/local workers", () => {
  withTempHome(() => {
    const repo = tmp("tw-jobs-");
    try {
      assert.equal(available("free", { write: false, role: "research" }), false);
      assert.equal(available("local", { write: false, role: "research" }), false);
      const next = nextAgent({ tried: ["codex", "gemini", "claude"], write: false, role: "research" });
      assert.equal(next, null);

      const jobs = new Jobs(repo);
      assert.throws(
        () => jobs.start({ agent: "claude", model: "sonnet", role: "research", write: true, task: "research with write" }),
        /read-only/,
      );
      assert.throws(
        () => jobs.start({ agent: "free", role: "research", noFallback: true, task: "research on free" }),
        /does not support web research/,
      );
      assert.throws(
        () => jobs.start({ agent: "local", role: "research", noFallback: true, task: "research on local" }),
        /does not support web research/,
      );
      assert.throws(
        () => jobs.start({ agent: "claude", role: "bogus", task: "invalid role" }),
        /unknown role/,
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("events.js preserves [1] citations and https links from Antigravity and formats Claude web tools", () => {
  const agy = normalize("gemini", {
    stream: "out",
    line: JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        duration_seconds: 2,
        response: "See [`src/ui.js`](file:///repo/src/ui.js) and [Release](https://example.com/r) [1].",
      },
    }),
  }, "/repo");
  assert.equal(agy[0].kind, "say");
  assert.equal(agy[0].text, "See `src/ui.js` and [Release](https://example.com/r) [1].");

  const ws = normalize("claude", {
    stream: "out",
    line: JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "node 22 release" } }] },
    }),
  }, "/repo");
  assert.deepEqual(ws, [{ kind: "search", text: "node 22 release" }]);

  const wf = normalize("claude", {
    stream: "out",
    line: JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: "https://nodejs.org" } }] },
    }),
  }, "/repo");
  assert.deepEqual(wf, [{ kind: "read", text: "https://nodejs.org" }]);
});

test("safeHttpUrl allows only http/https URLs", () => {
  assert.equal(safeHttpUrl("https://nodejs.org/en/blog"), "https://nodejs.org/en/blog");
  assert.equal(safeHttpUrl("http://example.com/docs?q=1#top"), "http://example.com/docs?q=1#top");

  for (const bad of [
    "",
    "   ",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/file.txt",
    "mailto:test@example.com",
    "//evil.com/path",
    "/local/path",
    "https://",
  ]) {
    assert.equal(safeHttpUrl(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("parseCitations extracts Sources in multiple formats and keeps body clean", () => {
  const input1 = [
    "Node 22 shipped WebSocket client support [1] and ESM require [2].",
    "",
    "Sources:",
    "[1] Node.js 22 Release — https://nodejs.org/en/blog/announcements/v22-release-announcement",
    "[2] [ESM docs](https://nodejs.org/api/esm.html)",
  ].join("\n");
  const p1 = parseCitations(input1);
  assert.equal(p1.hasSources, true);
  assert.equal(p1.body, "Node 22 shipped WebSocket client support [1] and ESM require [2].");
  assert.equal(p1.sources.length, 2);
  assert.equal(p1.sources[0].num, 1);
  assert.equal(p1.sources[0].title, "Node.js 22 Release");
  assert.equal(p1.sources[0].url, "https://nodejs.org/en/blog/announcements/v22-release-announcement");
  assert.equal(p1.sources[0].host, "nodejs.org");
  assert.equal(p1.sources[1].num, 2);
  assert.equal(p1.sources[1].title, "ESM docs");
  assert.equal(p1.sources[1].url, "https://nodejs.org/api/esm.html");

  const input2 = [
    "Summary with [1] and [2].",
    "",
    "---",
    "### Sources",
    "1. https://www.example.org/wiki/Foo_(bar).",
    "2) Reference Note: http://docs.example.net/guide",
  ].join("\n");
  const p2 = parseCitations(input2);
  assert.equal(p2.body, "Summary with [1] and [2].");
  assert.equal(p2.sources.length, 2);
  assert.equal(p2.sources[0].url, "https://www.example.org/wiki/Foo_(bar)");
  assert.equal(p2.sources[0].host, "example.org");
  assert.equal(p2.sources[1].title, "Reference Note");
  assert.equal(p2.sources[1].url, "http://docs.example.net/guide");

  // Code blocks containing "Sources:" must not be treated as a real Sources section.
  const codeOnly = "Example:\n```\nSources:\n[1] https://example.com\n```\nDone.";
  const p3 = parseCitations(codeOnly);
  assert.equal(p3.hasSources, false);
  assert.equal(p3.sources.length, 0);
  assert.equal(p3.body, codeOnly);

  // Markdown reference definitions at end
  const refInput = "Check [1] for details.\n\n[1]: https://example.com/ref \"Ref Title\"";
  const p4 = parseCitations(refInput);
  assert.equal(p4.hasSources, true);
  assert.equal(p4.body, "Check [1] for details.");
  assert.equal(p4.sources[0].url, "https://example.com/ref");
  assert.equal(p4.sources[0].title, "Ref Title");
});

test("renderMarkdownHtml linkifies http/https citations & links and never linkifies non-http links", () => {
  const mixed = [
    "Valid [1], multi [1, 2], bare (https://example.com/x), inline `[1]`, [md](https://example.org/a).",
    "Non-http [js](javascript:alert(1)), [data](data:text/html,hi), [file](file:///etc/passwd), [ftp](ftp://example.com/f), [badcite][3] and [3] [4].",
    "",
    "Sources:",
    "[1] Good One — https://example.com/1",
    "[2] Good Two — http://example.org/2",
    "[3] Evil JS — javascript:alert(1)",
    "[4] Local File — file:///etc/passwd",
  ].join("\n");

  const parsed = parseCitations(mixed);
  assert.equal(parsed.sources[0].url, "https://example.com/1");
  assert.equal(parsed.sources[1].url, "http://example.org/2");
  assert.equal(parsed.sources[2].url, null);
  assert.equal(parsed.sources[3].url, null);

  const html = renderMarkdownHtml(parsed.body, { sources: parsed.sources });
  assert.match(html, /<a class="cite" href="https:\/\/example\.com\/1" target="_blank" rel="noopener noreferrer"[^>]*>\[1\]<\/a>/);
  assert.match(html, /<a class="cite" href="http:\/\/example\.org\/2" target="_blank" rel="noopener noreferrer"[^>]*>2<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/x<\/a>\)/);
  assert.match(html, /<a href="https:\/\/example\.org\/a" target="_blank" rel="noopener noreferrer">md<\/a>/);
  assert.match(html, /<code>\[1\]<\/code>/);

  // Non-http links and citations pointing to non-http sources must NEVER be linkified.
  assert.equal(/href="javascript:/i.test(html), false);
  assert.equal(/href="data:/i.test(html), false);
  assert.equal(/href="file:/i.test(html), false);
  assert.equal(/href="ftp:/i.test(html), false);

  const onlyUnsafe = renderMarkdownHtml(
    "Click [one](javascript:alert(1)), [two](data:text/html,<svg>), [three](file:///etc/passwd), [four](mailto:a@b.c), [five](ftp://a.b/c), and [1].",
    { sources: [{ num: 1, title: "Bad", url: null, rawUrl: "javascript:alert(1)" }] },
  );
  assert.equal(/<a\b/i.test(onlyUnsafe), false);
});

test("UI handler serves /citations.js and /api/team with research role", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-srv-");
    try {
      initServer({ repo });

      const citRes = await callHandler("GET", "/citations.js");
      assert.equal(citRes.status, 200);
      assert.match(citRes.text, /export function parseCitations/);

      const teamRes = await callHandler("GET", "/api/team");
      assert.equal(teamRes.status, 200);
      assert.ok(teamRes.body.options.roles.some((r) => r.id === "research"));
      assert.ok(teamRes.body.options.agents.free.unsupportedRoles.includes("research"));
      assert.equal(teamRes.body.options.agents.local, undefined);
      assert.deepEqual(teamRes.body.team.roles.research, PRESETS.balanced.research);

      const saveRes = await callHandler("POST", "/api/team", {
        mode: "manual",
        preset: "quality",
        roles: PRESETS.quality,
        allow: { free: true, astra: false },
      });
      assert.equal(saveRes.status, 200);
      assert.deepEqual(saveRes.body.team.roles.research, PRESETS.quality.research);

      const badDelegate = await callHandler("POST", "/api/delegate", {
        agent: "claude",
        role: "research",
        write: true,
        task: "try write research",
      });
      assert.equal(badDelegate.status, 400);
      assert.match(badDelegate.body.error, /read-only/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
