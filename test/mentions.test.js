import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";

import { MENTIONS, parseMentions, normalizeMentions, mentionGuide, mentionInfo } from "../ui/mentions.js";
import { buildGuide, Chats } from "../src/orchestrator.js";
import { Jobs } from "../src/jobs.js";
import { saveSettings } from "../src/settings.js";
import { normalizeTeamOverride, overrideGuide, PRESETS } from "../src/team.js";
import { handler, initServer } from "../src/ui.js";
import { DICT } from "../ui/i18n.js";

function withHome(fn) {
  const prev = process.env.HOME, prevFree = process.env.TOKENWISE_ALLOW_FREE, prevNotify = process.env.TOKENWISE_NOTIFY;
  delete process.env.TOKENWISE_ALLOW_FREE; process.env.TOKENWISE_NOTIFY = "0";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-mention-home-"));
  process.env.HOME = home;
  const done = () => {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    if (prevFree === undefined) delete process.env.TOKENWISE_ALLOW_FREE; else process.env.TOKENWISE_ALLOW_FREE = prevFree;
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY; else process.env.TOKENWISE_NOTIFY = prevNotify;
    fs.rmSync(home, { recursive: true, force: true }); };
  return Promise.resolve().then(() => fn(home)).finally(done);
}
function gitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-mention-repo-"));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n"); git("add", "."); git("commit", "-m", "init");
  return repo;
}
function capturingSpawn(captured) {
  return (cmd, args) => {
    captured.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    process.nextTick(() => {
      child.stdout.write(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }) + "\n");
      child.stdout.end(); child.stderr.end(); child.emit("close", 0);
    });
    return child;
  };
}
const guideOf = (call) => call.args[call.args.indexOf("--append-system-prompt") + 1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("parseMentions finds known tokens, reports unknown ones, ignores emails and scoped packages", () => {
  assert.deepEqual(parseMentions("ask @sol and @Sonnet, then @sol again"), { names: ["sol", "sonnet"], unknown: [] });
  assert.deepEqual(parseMentions("@codex fix it"), { names: ["codex"], unknown: [] });
  assert.deepEqual(parseMentions("mail me at a@sol.com, install @types/node"), { names: [], unknown: [] });
  assert.deepEqual(parseMentions("use @gpt9 please"), { names: [], unknown: ["gpt9"] });
  assert.deepEqual(parseMentions(""), { names: [], unknown: [] });
});

test("normalizeMentions accepts only known names, strips @, dedupes and caps the count", () => {
  assert.deepEqual(normalizeMentions(undefined), []);
  assert.deepEqual(normalizeMentions(["@Sol", "sol", "free", "local"]), ["sol", "free", "local"]);
  assert.throws(() => normalizeMentions("sol"), /must be a list/);
  assert.throws(() => normalizeMentions([5]), /strings/);
  assert.throws(() => normalizeMentions(["astra"]), /unknown mention @astra/);
  assert.throws(() => normalizeMentions(["nope"]), /unknown mention/);
  assert.throws(() => normalizeMentions(["sol", "opus", "haiku", "codex", "gemini"]), /at most/);
  for (const m of MENTIONS) assert.equal(mentionInfo(m.name).agent, m.agent);
});

test("mentionGuide names the worker and model; buildGuide adds it only when mentioned", () => {
  const g = mentionGuide(["sol"]);
  assert.match(g, /The user asked to use Codex Sol for this message/);
  assert.match(g, /agent="codex", model="sol"/);
  assert.match(mentionGuide(["local"]), /agent="local"/);
  assert.match(mentionGuide(["codex", "haiku"]), /Codex and Claude Haiku/);
  assert.equal(mentionGuide([]), "");
  assert.match(buildGuide("ask", { mentions: ["sonnet"] }), /The user asked to use Claude Sonnet for this message/);
  assert.doesNotMatch(buildGuide("ask"), /The user asked to use/);
});

test("per-message role override is validated and rendered for the guide", () => {
  assert.equal(normalizeTeamOverride(undefined), null);
  assert.equal(normalizeTeamOverride({}), null);
  assert.deepEqual(normalizeTeamOverride({ code: { agent: "claude", model: "sonnet", effort: "high" } }), { code: { agent: "claude", model: "sonnet", effort: "high" } });
  assert.throws(() => normalizeTeamOverride({ nope: { agent: "codex" } }), /unknown role/);
  assert.throws(() => normalizeTeamOverride({ code: { agent: "evil" } }), /agent must be/);
  assert.throws(() => normalizeTeamOverride({ code: { agent: "codex", model: "astra" } }), /astra/);
  assert.match(overrideGuide({ code: { agent: "claude", model: "sonnet", effort: "high" } }), /For this message only[\s\S]*Writing code: claude sonnet \(high effort\)/);
  assert.equal(overrideGuide(null), "");
  assert.ok(PRESETS.free && PRESETS.free.code.agent === "free");
});

test("Chats.send: the mention reaches the orchestrator guide and the turn; unknown or disallowed ones are refused", async () => {
  await withHome(async () => {
    const repo = gitRepo();
    try {
      const jobs = new Jobs(repo);
      const calls = [];
      const chats = new Chats(jobs, { spawn: capturingSpawn(calls) });
      const c = chats.send({ message: "do it", model: "opus", effort: "low", force: "claude", mentions: ["@sol"], team: { code: { agent: "claude", model: "haiku", effort: "low" } } });
      await wait(60);
      assert.equal(calls.length, 1);
      const guide = guideOf(calls[0]);
      assert.match(guide, /The user asked to use Codex Sol for this message/);
      assert.match(guide, /For this message only the user chose these workers/);
      const saved = chats.get(c.id);
      assert.deepEqual(saved.turns[0].mentions, ["sol"]);
      assert.equal(saved.turns[0].teamOverride.code.model, "haiku");
      await wait(250);
      const log = fs.readFileSync(chats.f(c.id, "jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(log.find((e) => e.stream === "user").mentions, ["sol"]);

      // no mention: no guide line, no field
      chats.send({ id: c.id, message: "again", model: "opus", effort: "low", force: "claude" });
      await wait(60);
      assert.doesNotMatch(guideOf(calls[1]), /The user asked to use/);
      assert.equal(chats.get(c.id).turns[1].mentions, undefined);

      assert.throws(() => chats.send({ message: "x", model: "opus", force: "claude", mentions: ["gpt9"] }), /unknown mention/);
      assert.throws(() => chats.send({ message: "x", model: "opus", force: "claude", mentions: "sol" }), /must be a list/);
      // @free needs the existing opt-in
      assert.throws(() => chats.send({ message: "x", model: "opus", force: "claude", mentions: ["free"] }), /Free models are off/);
      assert.equal(chats.list().length, 1, "refused sends must not create chats");
      saveSettings({ allowFree: true });
      chats.send({ message: "free one", model: "opus", force: "claude", mentions: ["free"] });
      await wait(60);
      assert.match(guideOf(calls[2]), /Free API[\s\S]*agent="free", model="auto"/);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

test("/api/chat validates mentions and /api/mentions lists them; /mentions.js is served", async () => {
  await withHome(async () => {
    const repo = gitRepo();
    try {
      initServer({ repo, spawn: capturingSpawn([]) });
      const call = async (method, url, body) => {
        const req = new PassThrough(); req.method = method; req.url = url;
        req.headers = { host: "127.0.0.1:4790", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
        let status = 200; const chunks = [];
        const res = { writeHead(c) { status = c; }, end(d) { if (d) chunks.push(Buffer.from(String(d))); } };
        const p = handler(req, res);
        if (method === "POST") req.end(JSON.stringify(body ?? {})); else req.end();
        await p;
        return { status, text: Buffer.concat(chunks).toString("utf8") };
      };
      const list = JSON.parse((await call("GET", "/api/mentions")).text);
      assert.ok(list.mentions.some((m) => m.name === "sol" && m.agent === "codex"));
      assert.match((await call("GET", "/mentions.js")).text, /export const MENTIONS/);
      const bad = await call("POST", "/api/chat", { message: "hi", mentions: ["gpt9"] });
      assert.equal(bad.status, 400);
      assert.match(JSON.parse(bad.text).error, /unknown mention/);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

test("every mention has English and Turkish menu text", () => {
  for (const m of MENTIONS) {
    const key = m.model ? null : `mention.agent.${m.name}`;
    if (key) { assert.ok(DICT.en[key], `en ${key}`); assert.ok(DICT.tr[key], `tr ${key}`); }
  }
});
