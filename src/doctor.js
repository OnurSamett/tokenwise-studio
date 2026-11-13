// Environment check for the UI: which CLIs are installed and signed in. Cached for 60s, never throws.
import { spawnSync } from "node:child_process";
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
  const claude = installed("claude"), codex = installed("codex"), gemini = installed("gemini");
  return {
    git: { installed: installed("git") },
    claude: { installed: claude, signedIn: claude && /"loggedIn"\s*:\s*true/.test(run("claude", ["auth", "status"])?.out || "") },
    codex: { installed: codex, signedIn: codex && /logged in/i.test(run("codex", ["login", "status"])?.out || "") },
    // Google-account sign-in no longer works for individuals in Gemini CLI, so only an API key counts.
    gemini: { installed: gemini, signedIn: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI), needs: "api-key" },
  };
}

let cache = null;
export function doctor() {
  if (!cache || Date.now() - cache.at > 60000) cache = { at: Date.now(), value: check() };
  return cache.value;
}
