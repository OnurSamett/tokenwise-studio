// Worker adapters: turn {agent, model, effort, write} into a headless CLI command.
import { execFileSync } from "node:child_process";

export const AGENTS = ["codex", "claude", "gemini"];
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
export function resolve({ agent, model, effort }) {
  if (!AGENTS.includes(agent)) throw new Error(`agent must be one of ${AGENTS.join(", ")}`);
  const defaults = { codex: "medium", claude: "low", gemini: "medium" };
  const eff = effort || defaults[agent];
  if (eff === "max" || eff === "ultra") throw new Error("effort max/ultra is not allowed from tokenwise-studio; use up to xhigh");
  if (!EFFORTS.includes(eff)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
  let m = model;
  if (agent === "codex") {
    m = codexSlug(model);
    if (m.includes("astra") && process.env.TOKENWISE_CODEX_ASTRA !== "1") {
      throw new Error("Codex astra is blocked (it drains ChatGPT limits fast). Use sol, or set TOKENWISE_CODEX_ASTRA=1.");
    }
  } else if (agent === "claude") {
    m = model || process.env.TOKENWISE_CLAUDE_MODEL || "haiku";
  }
  return { agent, model: m, effort: eff };
}

/** Build the CLI invocation. `lastFile` receives Codex's final message. */
export function command({ agent, model, effort }, { task, cwd, write, lastFile }) {
  if (agent === "codex") {
    return {
      cmd: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "-C", cwd,
        "--sandbox", write ? "workspace-write" : "read-only",
        "-m", model, "-c", `model_reasoning_effort="${effort}"`,
        "-o", lastFile, task],
    };
  }
  if (agent === "claude") {
    return {
      cmd: "claude",
      args: ["-p", task, "--model", model, "--effort", effort,
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
