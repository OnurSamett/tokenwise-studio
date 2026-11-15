// Worker adapters: turn {agent, model, effort, write} into a headless CLI command.
import { imageNote } from "./uploads.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAgy, agySlug } from "./antigravity.js";
import { freeProviders } from "./freechat.js";
import { ALL_PLAYTEST_ALLOWLIST } from "./studioproxy.js";

/**
 * Create an isolated temporary CODEX_HOME for a Codex playtest worker containing ONLY
 * the `roblox_playtest` MCP server config and (when present as a regular file) `auth.json`.
 * Never copies unrelated config or other MCP servers from the user's ~/.codex.
 */
export function prepareCodexPlaytestHome({
  codexHome = null,
  proxyArgs = [],
  allowedTools = ALL_PLAYTEST_ALLOWLIST,
  sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
} = {}) {
  const targetHome = codexHome || fs.mkdtempSync(path.join(os.tmpdir(), "tw-codex-pt-"));
  fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(targetHome, 0o700); } catch {}

  if (sourceCodexHome && path.resolve(sourceCodexHome) !== path.resolve(targetHome)) {
    const srcAuth = path.join(sourceCodexHome, "auth.json");
    try {
      const st = fs.lstatSync(srcAuth);
      if (st.isFile() && !st.isSymbolicLink()) {
        const dstAuth = path.join(targetHome, "auth.json");
        fs.writeFileSync(dstAuth, fs.readFileSync(srcAuth), { mode: 0o600 });
      }
    } catch {}
  }

  const enabledList = [...(allowedTools || ALL_PLAYTEST_ALLOWLIST)];
  const toml = [
    // File-backed auth can be copied without importing user MCPs or hooks.
    // OS keyring/ephemeral credentials are not portable to a fresh CODEX_HOME.
    // https://learn.chatgpt.com/docs/auth#credential-storage
    'cli_auth_credentials_store = "file"',
    "[mcp_servers.roblox_playtest]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(proxyArgs || [])}`,
    `enabled_tools = ${JSON.stringify(enabledList)}`,
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(targetHome, "config.toml"), toml, { mode: 0o600 });
  return targetHome;
}

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

const FREE_PROVIDER_RE = /^(nvidia|openrouter|groq|mistral|custom):(.+)$/;
const FREE_MODEL_CHARS = /^[\w.\/:-]{1,120}$/;

/** Parse a requested free model string into an auto choice, a provider:id, an explicit id, or a bare ranking hint. */
export function parseFreeModel(model) {
  const m = String(model || "").trim();
  if (!m || m === "auto") return { kind: "auto", model: "auto" };
  const sel = m.match(FREE_PROVIDER_RE);
  if (sel) {
    if ((sel[1] === "nvidia" || sel[1] === "openrouter") && !sel[2].includes("/")) {
      return { kind: "hint", provider: sel[1], hint: sel[2], model: "auto" };
    }
    return { kind: "provider_model", provider: sel[1], id: sel[2], model: m };
  }
  if (!m.includes("/") && !m.includes(":")) {
    return { kind: "hint", provider: null, hint: m, model: "auto" };
  }
  return { kind: "id", id: m, model: m };
}

/** Validate a free-agent model argument and convert bare aliases to ranking hints. */
export function normalizeFreeModelArg(model) {
  if (model === undefined || model === null) return { model: undefined, hint: null, provider: null };
  if (typeof model !== "string") throw new Error("free model must be a string");
  const raw = model.trim();
  if (!raw || raw === "auto") return { model: "auto", hint: null, provider: null };
  if (!FREE_MODEL_CHARS.test(raw)) {
    throw new Error("free model must be 'auto' or '<provider>:<id>' (nvidia|openrouter|groq|mistral|custom)");
  }
  if (raw.includes(":") && !FREE_PROVIDER_RE.test(raw)) {
    throw new Error("free model must be 'auto' or '<provider>:<id>' (nvidia|openrouter|groq|mistral|custom)");
  }
  const parsed = parseFreeModel(raw);
  if (parsed.kind === "hint") {
    return { model: "auto", hint: parsed.hint, provider: parsed.provider || null };
  }
  return { model: parsed.model, hint: null, provider: parsed.provider || null };
}

/** Validate and normalise a request; throws with a readable message on policy violations. */
export function resolve({ agent, model, effort, hint = null, provider = null, allowAstra = false }) {
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
    const parsed = parseFreeModel(model || process.env.TOKENWISE_FREE_MODEL || "auto");
    const freeHint = hint || (parsed.kind === "hint" ? parsed.hint : null);
    const freeProvider = provider || (parsed.kind === "hint" ? parsed.provider : null);
    return {
      agent,
      model: parsed.model,
      effort: eff,
      ...(freeHint ? { hint: freeHint, ...(freeProvider ? { provider: freeProvider } : {}) } : {}),
    };
  } else if (agent === "gemini" && findAgy() && !process.env.GEMINI_API_KEY) {
    // Prefer Antigravity (personal Google account); fall back to Gemini CLI when an API key is set.
    m = agySlug(model, eff);
    return { agent, model: m, effort: eff, via: "antigravity" };
  }
  return { agent, model: m, effort: eff };
}

/** Build the CLI invocation. `lastFile` receives Codex's final message. */
export function command({ agent, model, effort, via, hint: specHint, provider: specProvider }, { task, cwd, write, role = null, lastFile, images = [], playtest = null }) {
  if (role === "playtest" && agent !== "claude" && agent !== "codex") {
    throw new Error(`${agent} does not support Roblox playtest; use claude or codex`);
  }
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
    const parsed = parseFreeModel(model);
    const hint = specHint || (parsed.kind === "hint" ? parsed.hint : null);
    const prov = specProvider || (parsed.kind === "hint" ? parsed.provider : null);
    const otherProviders = (first) => {
      try { return freeProviders().map((p) => p.name).filter((n) => n !== first); } catch { return []; }
    };
    if (parsed.kind === "provider_model") {
      // "provider:model": try that provider/model first, keep the other configured providers as fallback.
      env = { TOKENWISE_FREE_PROVIDERS: [parsed.provider, ...otherProviders(parsed.provider)].join(","), [`TOKENWISE_${parsed.provider.toUpperCase()}_MODEL`]: parsed.id };
    } else if (hint) {
      env = { TOKENWISE_FREE_HINT: hint, TOKENWISE_FREE_MODEL: "" };
      if (prov) env.TOKENWISE_FREE_PROVIDERS = [prov, ...otherProviders(prov)].join(",");
    } else if (parsed.kind === "id") {
      env = { TOKENWISE_FREE_MODEL: parsed.id };
    }
    return { cmd: process.execPath, args: [FREEAGENT, ...(write ? ["--write"] : []), task], env };
  }
  if (agent === "codex") {
    if (role === "playtest" && playtest) {
      const prompt = playtest.systemPrompt ? `<instructions>\n${playtest.systemPrompt}\n</instructions>\n\n${task}` : task;
      const enabledTools = [...(playtest.allowedTools || ALL_PLAYTEST_ALLOWLIST)];
      const codexHome = prepareCodexPlaytestHome({
        codexHome: playtest.codexHome || null,
        proxyArgs: playtest.proxyArgs || [],
        allowedTools: enabledTools,
        ...(playtest.sourceCodexHome
          ? { sourceCodexHome: playtest.sourceCodexHome }
          : playtest.userHomeDir
            ? { sourceCodexHome: path.join(playtest.userHomeDir, ".codex") }
            : {}),
      });
      const mcpFlags = [
        "-c", `mcp_servers.roblox_playtest.command=${JSON.stringify(process.execPath)}`,
        "-c", `mcp_servers.roblox_playtest.args=${JSON.stringify(playtest.proxyArgs || [])}`,
        "-c", `mcp_servers.roblox_playtest.enabled_tools=${JSON.stringify(enabledTools)}`,
        "-c", 'mcp_servers.roblox_playtest.default_tools_approval_mode="approve"',
      ];
      return {
        cmd: "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "-C", cwd,
          "--sandbox", "read-only",
          "-m", model, "-c", `model_reasoning_effort="${effort}"`,
          "-c", 'web_search="disabled"',
          ...mcpFlags,
          "-o", lastFile, ...images.flatMap((p) => ["-i", p]), "--", prompt],
        env: { CODEX_HOME: codexHome },
      };
    }
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
    if (role === "playtest" && playtest) {
      const mcpTools = (playtest.allowedTools || ALL_PLAYTEST_ALLOWLIST).map((n) => `mcp__roblox-playtest__${n}`);
      const repoRoot = cwd || playtest.repo || process.cwd();
      const readScopes = [
        `Read(${repoRoot}/**)`,
        ...(playtest.playtestDir ? [`Read(${playtest.playtestDir}/**)`] : []),
      ];
      const allowed = [...readScopes, "Glob", "Grep", ...mcpTools];
      const maxCalls = Number(playtest.maxCalls ?? playtest.limits?.maxCalls ?? 40) || 40;
      const maxTurns = String(maxCalls + 10);
      const addDirs = [...images.map((p) => path.dirname(p)), ...(playtest.playtestDir ? [playtest.playtestDir] : [])];
      return {
        cmd: "claude",
        args: [
          "-p", [task, imageNote(images)].filter(Boolean).join("\n\n"),
          "--model", model, "--effort", effort,
          "--max-turns", maxTurns,
          "--mcp-config", playtest.mcpConfigFile,
          "--strict-mcp-config",
          "--permission-mode", "default",
          "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task", "Agent",
          "--allowedTools", ...allowed,
          ...(playtest.systemPrompt ? ["--append-system-prompt", playtest.systemPrompt] : []),
          ...addDirs.flatMap((d) => ["--add-dir", d]),
          "--output-format", "stream-json", "--verbose",
        ],
      };
    }
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
