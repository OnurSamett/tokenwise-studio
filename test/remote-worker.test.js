import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { clearDoctorCache } from "../src/doctor.js";
import { available } from "../src/fallback.js";
import { orchAvailable } from "../src/orchestrator.js";
import { teamOptions } from "../src/team.js";

const KEYS = ["TOKENWISE_OLLAMA_BASE", "OLLAMA_API_KEY", "TOKENWISE_LOCAL_MODEL"];
const saved = {};
const servers = [];

beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; clearDoctorCache(); });
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (servers.length) servers.pop().kill();
  clearDoctorCache();
});

function startServer(models) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["test/helpers/fake-models-server.mjs", models, ""], { stdio: ["ignore", "pipe", "inherit"] });
    servers.push(child);
    child.once("error", reject);
    child.stdout.once("data", (d) => resolve(Number(String(d).trim())));
  });
}

test("remote gateway ready: orchestrator may use local, CLI worker and team options may not", async () => {
  const port = await startServer("gpt-oss:20b");
  process.env.TOKENWISE_OLLAMA_BASE = `http://127.0.0.1:${port}`;
  process.env.TOKENWISE_LOCAL_MODEL = "gpt-oss:20b";
  delete process.env.OLLAMA_API_KEY;
  assert.equal(orchAvailable("local", null, {}), true);
  assert.equal(available("local", { write: true }), false);
  assert.equal(teamOptions().agents.local, undefined);
});
