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
  assert.deepEqual(localCheck(), { installed: true, signedIn: true, model: "gpt-oss:20b", fix: null, via: "gateway" });
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
