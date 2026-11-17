// Environment check for the UI: which CLIs are installed and signed in. Cached for 60s, never throws.
import { spawnSync } from "./process.js";
import { cursorAgentBin } from "./cursor.js";
import { findAgy, agyModels } from "./antigravity.js";
import { freeProviders } from "./freechat.js";
import { loadSettings } from "./settings.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const run = (cmd, args, timeout = 8000) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return null;
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } catch { return null; }
};
const installed = (bin) => {
  const r = run(process.platform === "win32" ? "where" : "which", [bin]);
  return !!r && r.code === 0;
};

const AGENTS = ["git", "claude", "codex", "gemini", "cursor", "local", "free"];
function checkAgent(agent) {
  if (agent === "git") return { installed: installed("git") };
  if (agent === "claude") { const ok = installed("claude"); return { installed: ok, signedIn: ok && /"loggedIn"\s*:\s*true/.test(run("claude", ["auth", "status"])?.out || "") }; }
  if (agent === "codex") { const ok = installed("codex"); return { installed: ok, signedIn: ok && /logged in/i.test(run("codex", ["login", "status"])?.out || "") }; }
  if (agent === "gemini") { const agy = !!findAgy(); return agy ? { installed: true, signedIn: !!agyModels(), via: "antigravity" } : { installed: installed("gemini"), signedIn: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI), needs: "api-key" }; }
  if (agent === "cursor") { const bin = cursorAgentBin(), ok = bin !== "cursor-agent" || installed(bin), status = ok ? run(bin, ["status"], 20000) : null, text = status?.out || ""; return { installed: ok, signedIn: !!status && status.code === 0 && !/not (?:logged in|authenticated)|unauthenticated/i.test(text) && /logged in|authenticated/i.test(text) }; }
  if (agent === "local") return localCheck();
  if (agent === "free") return freeCheck();
  return null;
}

// Local model via Ollama (driven by Codex CLI's --oss mode): ready when the server answers and the model is pulled.
function localCheck() {
  const model = process.env.TOKENWISE_LOCAL_MODEL || "gpt-oss:20b";
  if (!installed("ollama")) return { installed: false, signedIn: false, model, fix: "brew install ollama" };
  const r = run("ollama", ["list"]);
  if (!r || r.code !== 0) return { installed: true, signedIn: false, model, fix: "brew services start ollama" };
  const has = r.out.split("\n").some((l) => l.split(/\s+/)[0] === model || l.startsWith(model + " "));
  return { installed: true, signedIn: has, model, fix: has ? null : `ollama pull ${model}` };
}

// Free-tier chat API (read-only). Configured by a key; used only after the user opts in.
function freeCheck() {
  const list = freeProviders().map((p) => p.name);
  const via = list.join(" → ") || null;
  const s = loadSettings();
  const optIn = Boolean(s.allowFree || s.freeMode);
  return { installed: list.length > 0, signedIn: list.length > 0 && optIn, via, providers: list, optIn, fix: !list.length ? "export NVIDIA_API_KEY=…" : optIn ? null : "enable in Settings or TOKENWISE_ALLOW_FREE=1" };
}

const cache = new Map();
const refreshing = new Map();
let cacheGeneration = 0;
export function clearDoctorCache() { cache.clear(); cacheGeneration++; }
function cached(agent) {
  if (agent === "free") return freeCheck();
  const hit = cache.get(agent);
  if (hit && Date.now() - hit.at <= 60000) return hit.value;
  const value = checkAgent(agent);
  cache.set(agent, { at: Date.now(), value });
  return value;
}
export function doctor(agent = null) {
  if (agent) return { [agent]: cached(agent) };
  return Object.fromEntries(AGENTS.map((name) => [name, cached(name)]));
}
// UI status is advisory: never block a message on unrelated provider discovery.
export function doctorSnapshot() {
  const result = {};
  for (const agent of AGENTS) {
    if (agent === "free") { result[agent] = freeCheck(); continue; }
    const hit = cache.get(agent);
    if (!hit || Date.now() - hit.at > 60000) void refreshAgent(agent).catch(() => {});
    result[agent] = hit?.value || { installed: false, signedIn: false, checking: true };
  }
  return result;
}
function refreshAgent(agent) {
  const hit = cache.get(agent);
  if (agent === "free") return Promise.resolve(freeCheck());
  if (hit && Date.now() - hit.at <= 60000) return Promise.resolve(hit.value);
  if (refreshing.has(agent)) return refreshing.get(agent);
  const generation = cacheGeneration;
  const promise = new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./doctor-worker.js", import.meta.url), {
      workerData: { agent },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
    });
    let completed = false;
    worker.once("message", (value) => { completed = true; if (generation === cacheGeneration) cache.set(agent, { at: Date.now(), value }); resolve(value); });
    worker.once("error", reject);
    worker.once("exit", (code) => { if (!completed) reject(new Error(`provider check exited ${code} without a result`)); });
  }).finally(() => refreshing.delete(agent));
  refreshing.set(agent, promise);
  return promise;
}
// Checks run concurrently in isolated workers; requesting one provider never waits on another.
export async function doctorAsync(agent = null) {
  if (agent) return { [agent]: await refreshAgent(agent) };
  const entries = await Promise.all(AGENTS.map(async (name) => [name, await refreshAgent(name)]));
  return Object.fromEntries(entries);
}
