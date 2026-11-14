// Worker adapters: turn {agent, model, effort, write} into a headless CLI command.
import { imageNote } from "./uploads.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAgy, agySlug } from "./antigravity.js";
import { freeProviders } from "./freechat.js";

export const AGENTS = ["codex", "claude", "gemini", "local", "free"];
const FREEAGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "freeagent.js");
const EFFORTS = ["low", "medium", "high", "xhigh"];

let codexCatalog = null;
function codexSlug(model) {
  const fam = model || process.env.TOKENWISE_CODEX_MODEL || "sol";
  if (!["luna", "terra", "sol", "astra"].includes(fam)) return fam; // full slug given
  if (!codexCatalog) {
    try {
      const raw = JSON.parse(execFileSync("codex", ["debug", "models"], { encoding: "utf8", timeout: 30000 }));
      codexCatalog = (raw.models || raw).filter((m) => m && m.visibility === "list");
      codexCatalog.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    } catch {
      codexCatalog = [];
    }
  }
  const hit = codexCatalog.find((m) => String(m.slug).endsWith("-" + fam));
  if (!hit) throw new Error(`No Codex model found for family '${fam}'`);
  return hit.slug;
}

/** Validate and normalise a request; throws with a readable message on policy violations. */
export function resolve({ agent, model, effort, allowAstra = false }) {
  if (!AGENTS.includes(agent)) throw new Error(`agent must be one of ${AGENTS.join(", ")}`);
  const defaults = { codex: "medium", claude: "low", gemini: "medium", local: "medium", free: "medium" };
  const eff = effort || defaults[agent];
  if (eff === "max" || eff === "ultra") throw new Error("effort max/ultra is not allowed from tokenwise-studio; use up to xhigh");
  if (!EFFORTS.includes(eff)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  let m = model;
  if (agent === "codex") {
    m = codexSlug(model);
    if (m.includes("astra") && process.env.TOKENWISE_CODEX_ASTRA !== "1" && !allowAstra) {
      throw new Error("Codex astra is blocked (it drains ChatGPT limits fast). Use sol, or set TOKENWISE_CODEX_ASTRA=1.");
    }
  } else if (agent === "claude") {
    m = model || process.env.TOKENWISE_CLAUDE_MODEL || "haiku";
  } else if (agent === "local") {
    m = model || process.env.TOKENWISE_LOCAL_MODEL || "gpt-oss:20b";
  } else if (agent === "free") {
    m = model || process.env.TOKENWISE_FREE_MODEL || "auto";
  } else if (agent === "gemini" && findAgy() && !process.env.GEMINI_API_KEY) {
    // Prefer Antigravity (personal Google account); fall back to Gemini CLI when an API key is set.
    m = agySlug(model, eff);
    return { agent, model: m, effort: eff, via: "antigravity" };
  }
  return { agent, model: m, effort: eff };
}

/** Build the CLI invocation. `lastFile` receives Codex's final message. */
export function command({ agent, model, effort, via }, { task, cwd, write, role = null, lastFile, images = [] }) {
  if (agent === "gemini" && via === "antigravity") {
    const args = ["-p", task, "--model", model, "--output-format", "stream-json", "--print-timeout", "0s",
      "--mode", write ? "accept-edits" : "plan"];
    // Headless mode can't ask for permission. Write jobs (in their own worktree) may edit files and run
    // commands, but only inside Antigravity's terminal sandbox, like Codex's workspace-write sandbox.
    if (write) args.push("--sandbox", "--settings", JSON.stringify({ permissions: { allow: ["write_file(*)", "command(*)"] } }));
    return { cmd: findAgy(), args };
  }
  if (agent === "local") {
    // Codex CLI driving a local Ollama model: a full agent with Codex's sandbox, no plan limits.
    return {
      cmd: "codex",
      args: ["exec", "--json", "--oss", "--local-provider", "ollama", "--skip-git-repo-check", "-C", cwd,
        "--sandbox", write ? "workspace-write" : "read-only",
        "-m", model, "-c", `model_reasoning_effort="${effort}"`,
        "-o", lastFile, task],
    };
  }
  if (agent === "free") {
    // Free-tier chat APIs driven by our own small tool loop (src/freeagent.js): reads the repo,
    // and in write mode edits files inside the worktree (no commands; see freeagent.js).
    let env = {};
    const sel = model && model !== "auto" ? model.match(/^(nvidia|openrouter|groq|mistral|custom):(.+)$/) : null;
    if (sel) {
      // "provider:model": try that provider/model first, keep the other configured providers as fallback.
      let others = [];
      try { others = freeProviders().map((p) => p.name).filter((n) => n !== sel[1]); } catch {}
      env = { TOKENWISE_FREE_PROVIDERS: [sel[1], ...others].join(","), [`TOKENWISE_${sel[1].toUpperCase()}_MODEL`]: sel[2] };
    } else if (model && model !== "auto") env = { TOKENWISE_FREE_MODEL: model };
    return { cmd: process.execPath, args: [FREEAGENT, ...(write ? ["--write"] : []), task], env };
  }
  if (agent === "codex") {
    return {
      cmd: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "-C", cwd,
        "--sandbox", write ? "workspace-write" : "read-only",
        "-m", model, "-c", `model_reasoning_effort="${effort}"`,
        "-c", role === "research" ? 'web_search="live"' : 'web_search="disabled"',
        "-o", lastFile, ...images.flatMap((p) => ["-i", p]), "--", task],
    };
  }
  if (agent === "claude") {
    const allowed = [
      ...(images.length ? ["Read"] : []),
      ...(role === "research" ? ["WebSearch", "WebFetch"] : []),
    ];
    return {
      cmd: "claude",
      args: ["-p", [task, imageNote(images)].filter(Boolean).join("\n\n"), "--model", model, "--effort", effort,
        ...images.flatMap((p) => ["--add-dir", path.dirname(p)]),
        ...(allowed.length ? ["--allowedTools", ...allowed] : []),
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", write ? "acceptEdits" : "plan"],
    };
  }
  // gemini
  // --skip-trust: headless Gemini refuses untrusted folders; workers already run read-only or in their own worktree.
  const args = ["-p", task, "-o", "stream-json", "--skip-trust", "--approval-mode", write ? "auto_edit" : "plan"];
  if (model) args.push("-m", model);
  return { cmd: "gemini", args };
}

/** Best-effort extraction of human-readable text from one JSON line of any CLI. */
export function textOf(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (typeof evt.result === "string") return evt.result; // claude final
  if (evt.event === "result" && evt.result) return evt.result.response || null; // antigravity final
  if (evt.type === "free.message") return evt.text || null; // free API answer
  if (evt.type === "free.error") return null;
  const item = evt.item || evt.msg || evt;
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (typeof item.content === "string") return item.content;
  if (item.message && Array.isArray(item.message.content)) {
    const t = item.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    if (t) return t;
  }
  if (typeof item.command === "string") return "$ " + item.command;
  return null;
}
