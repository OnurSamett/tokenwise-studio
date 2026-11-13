// Environment check for the UI: which CLIs are installed and signed in. Cached for 60s, never throws.
import { spawnSync } from "node:child_process";
import { findAgy, agyModels } from "./antigravity.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return null;
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } catch { return null; }
};
const installed = (bin) => {
  const r = run(process.platform === "win32" ? "where" : "which", [bin]);
  return !!r && r.code === 0;
};

function check() {
  const claude = installed("claude"), codex = installed("codex"), gemini = installed("gemini"), agy = !!findAgy();
  return {
    git: { installed: installed("git") },
    claude: { installed: claude, signedIn: claude && /"loggedIn"\s*:\s*true/.test(run("claude", ["auth", "status"])?.out || "") },
    codex: { installed: codex, signedIn: codex && /logged in/i.test(run("codex", ["login", "status"])?.out || "") },
    // Gemini CLI's Google sign-in no longer works for individuals, so without Antigravity only an API key counts.
    // Gemini runs through Antigravity (personal Google account) when available, else Gemini CLI with an API key.
    gemini: agy
      ? { installed: true, signedIn: !!agyModels(), via: "antigravity" }
      : { installed: gemini, signedIn: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI), needs: "api-key" },
    local: localCheck(),
    free: freeCheck(),
  };
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
  const via = process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.GROQ_API_KEY ? "groq" : null;
  const optIn = process.env.TOKENWISE_ALLOW_FREE === "1";
  return { installed: !!via, signedIn: !!via && optIn, via, optIn, fix: !via ? "set OPENROUTER_API_KEY or GROQ_API_KEY" : optIn ? null : "TOKENWISE_ALLOW_FREE=1" };
}

let cache = null;
export function doctor() {
  if (!cache || Date.now() - cache.at > 60000) cache = { at: Date.now(), value: check() };
  return cache.value;
}
