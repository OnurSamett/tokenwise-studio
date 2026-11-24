import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { localCheck, clearDoctorCache } from "../src/doctor.js";

const KEYS = ["TOKENWISE_OLLAMA_BASE", "OLLAMA_API_KEY", "TOKENWISE_LOCAL_MODEL", "PATH"];
const saved = {};
const servers = [];

beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; clearDoctorCache(); });
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (servers.length) servers.pop().kill();
  clearDoctorCache();
});

function startServer(models, key = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["test/helpers/fake-models-server.mjs", models, key], { stdio: ["ignore", "pipe", "inherit"] });
    servers.push(child);
    child.once("error", reject);
    child.stdout.once("data", (d) => resolve(Number(String(d).trim())));
  });
}
function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test("remote gateway: model present is ready", async () => {
  const port = await startServer("gpt-oss:20b,other", "secret");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${port}/`;
  process.env.OLLAMA_API_KEY = "secret";
  process.env.TOKENWISE_LOCAL_MODEL = "gpt-oss:20b";
  assert.deepEqual(localCheck(), { installed: true, signedIn: true, model: "gpt-oss:20b", fix: null, via: "gateway", worker: false });
});

test("remote gateway: base already ending in /v1 is not doubled", async () => {
  const port = await startServer("gpt-oss:20b");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${port}/v1`;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.TOKENWISE_LOCAL_MODEL;
  assert.equal(localCheck().signedIn, true);
});

test("remote gateway: model absent", async () => {
  const port = await startServer("other");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${port}`;
  process.env.TOKENWISE_LOCAL_MODEL = "gpt-oss:20b";
  const r = localCheck();
  assert.equal(r.signedIn, false);
  assert.equal(r.fix, "ollama pull gpt-oss:20b on the gateway host");
});

test("remote gateway: wrong key gives 401 hint and never leaks the key", async () => {
  const port = await startServer("gpt-oss:20b", "right-key");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${port}`;
  process.env.OLLAMA_API_KEY = "wrong-key";
  process.env.TOKENWISE_LOCAL_MODEL = "gpt-oss:20b";
  const r = localCheck();
  assert.equal(r.signedIn, false);
  assert.equal(r.fix, "check OLLAMA_API_KEY");
  assert.ok(!JSON.stringify(r).includes("wrong-key"));
});

test("remote gateway: missing key gives 401 hint", async () => {
  const port = await startServer("gpt-oss:20b", "right-key");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${port}`;
  delete process.env.OLLAMA_API_KEY;
  assert.equal(localCheck().fix, "check OLLAMA_API_KEY");
});

test("remote gateway: unreachable server", async () => {
  const port = await closedPort();
  const base = `http://127.0.0.1:${port}`;
  process.env.TOKENWISE_OLLAMA_BASE = base;
  const r = localCheck();
  assert.equal(r.signedIn, false);
  assert.equal(r.fix, `gateway unreachable: ${base}`);
});

test("without TOKENWISE_OLLAMA_BASE the original ollama path is used", () => {
  delete process.env.TOKENWISE_OLLAMA_BASE;
  process.env.PATH = "/nonexistent-dir";
  const r = localCheck();
  assert.equal(r.installed, false);
  assert.equal(r.fix, "brew install ollama");
  assert.equal(r.via, undefined);
});

test("orchAvailable('local') follows the doctor result (installed && signedIn)", async () => {
  const { orchAvailable } = await import("../src/orchestrator.js");
  const good = await startServer("gpt-oss:20b");
  process.env.TOKENWISE_LOCAL_MODEL = "gpt-oss:20b";
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${good}`;
  clearDoctorCache();
  assert.equal(orchAvailable("local", undefined, {}), true);

  const empty = await startServer("other");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${empty}`;
  clearDoctorCache();
  assert.equal(orchAvailable("local", undefined, {}), false);
});

test("remote gateway: OLLAMA_API_KEY is never sent over plain http to a non-loopback host", async () => {
  const { ollamaKeyAllowed } = await import("../src/freechat.js");
  for (const u of ["https://gw.example.com", "http://127.0.0.1:11434", "http://localhost:11434/v1", "http://[::1]:11434"]) assert.equal(ollamaKeyAllowed(u), true, u);
  for (const u of ["http://192.168.1.10:11434", "http://100.101.102.103:11434", "http://gw.example.com", "http://127.0.0.1.evil.com", "ftp://127.0.0.1", "127.0.0.1:11434", "nonsense"]) assert.equal(ollamaKeyAllowed(u), false, u);

  // The doctor refuses before any request is made (the address below would not answer anyway).
  process.env.TOKENWISE_OLLAMA_BASE = "http://user:pw@192.0.2.1:11434";
  process.env.OLLAMA_API_KEY = "secret";
  const r = localCheck();
  assert.equal(r.signedIn, false);
  assert.equal(r.fix, "refusing to send OLLAMA_API_KEY over plain http — use https:// or loopback");
  assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("pw@"));

  // Without a key nothing secret is sent, so plain http stays allowed (and userinfo is not echoed).
  delete process.env.OLLAMA_API_KEY;
  const port = await closedPort();
  process.env.TOKENWISE_OLLAMA_BASE = `http://user:pw@127.0.0.1:${port}`;
  assert.equal(localCheck().fix, `gateway unreachable: http://127.0.0.1:${port}`);
});

test("free/local orchestrator refuses to send OLLAMA_API_KEY to a plain-http gateway", async () => {
  const { runFreeOrchestrator } = await import("../src/freeagent.js");
  process.env.TOKENWISE_OLLAMA_BASE = "http://192.0.2.1:11434";
  process.env.OLLAMA_API_KEY = "secret";
  const events = [];
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ollama-key-"));
  let r;
  try { r = await runFreeOrchestrator({ agent: "local", repo, prompt: "hi", emit: (e) => events.push(e), permissionMode: "plan-only" }); }
  finally { fs.rmSync(repo, { recursive: true, force: true }); }
  assert.equal(r.ok, false);
  assert.match(r.message, /refusing to send OLLAMA_API_KEY over plain http/);
  assert.ok(events.some((e) => e.type === "free.error"));
});
