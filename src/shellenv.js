// When studio is started from an app or launcher (not a terminal), it doesn't see the variables the
// user put in ~/.zshrc / ~/.bashrc (API keys, TOKENWISE_* settings, a PATH with Homebrew/npm bins).
// Import just those, once, from the user's login shell. Values are never printed.
import { spawnSync } from "node:child_process";

const WANTED = /^(NVIDIA_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|TOKENWISE_[A-Z0-9_]+|CODEX_HOME|CLAUDE_HOME)$/;

export function importShellEnv() {
  if (process.env.TOKENWISE_NO_SHELL_ENV === "1" || process.platform === "win32") return { imported: 0 };
  const shell = process.env.SHELL || "/bin/zsh";
  const r = spawnSync(shell, ["-ilc", "env -0"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0 || !r.stdout) return { imported: 0 };
  let imported = 0;
  for (const entry of r.stdout.split("\0")) {
    const i = entry.indexOf("="); if (i <= 0) continue;
    const k = entry.slice(0, i), v = entry.slice(i + 1);
    if (k === "PATH") {
      // Add missing PATH entries (e.g. /opt/homebrew/bin) after the current ones.
      const have = new Set((process.env.PATH || "").split(":"));
      const extra = v.split(":").filter((p) => p && !have.has(p));
      if (extra.length) { process.env.PATH = [process.env.PATH, ...extra].filter(Boolean).join(":"); imported++; }
      continue;
    }
    if (WANTED.test(k) && !process.env[k]) { process.env[k] = v; imported++; }
  }
  return { imported };
}
