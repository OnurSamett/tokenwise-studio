// Google Antigravity CLI ("agy"): the way to run Gemini with a personal Google account now that
// Gemini CLI's Google sign-in no longer works for individuals. Ships inside Gemini.app on macOS.
import { execFileSync, spawnSync } from "./process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGY_MCP_NAME = "tokenwise-studio";
export const MCP_SERVER_PATH = fileURLToPath(new URL("./mcp.js", import.meta.url));

const CANDIDATES = [
  "/Applications/Gemini.app/Contents/Helpers/agy",
  "/Applications/Antigravity.app/Contents/Helpers/agy",
];

let agyPath;
export function findAgy() {
  if (process.env.TOKENWISE_AGY) return fs.existsSync(process.env.TOKENWISE_AGY) ? process.env.TOKENWISE_AGY : null;
  if (agyPath !== undefined) return agyPath;
  agyPath = CANDIDATES.find((p) => fs.existsSync(p)) || null;
  if (!agyPath) {
    const r = spawnSync("sh", ["-c", "command -v agy"], { encoding: "utf8", timeout: 3000 });
    agyPath = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }
  return agyPath;
}

let models = null, modelsAt = 0, modelsAgy = null;
/** Model ids available to the signed-in account, or null when agy is missing / not signed in. */
export function agyModels() {
  const agy = findAgy(); if (!agy) return null;
  if (models && modelsAgy === agy && Date.now() - modelsAt < 5 * 60000) return models;
  try {
    const out = execFileSync(agy, ["models"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    models = out.split("\n").map((l) => l.split("\t")[0].trim()).filter((id) => /^[\w.-]+$/.test(id) && id.includes("-"));
    modelsAt = Date.now();
    modelsAgy = agy;
    return models.length ? models : null;
  } catch { return null; }
}

/**
 * Antigravity bakes effort into the model id (e.g. gemini-3.8-flash-low).
 * Accepts a family ("hydrogen" = fast default, "argon" = frontier, "flash" = older) or a full id, plus our effort level.
 */
export function agySlug(model, effort) {
  const list = agyModels() || [];
  if (model && list.includes(model)) return model;
  const fam = (model || process.env.TOKENWISE_GEMINI_MODEL || "hydrogen").toLowerCase();
  const order = { low: ["low", "medium"], medium: ["medium", "low", "high"], high: ["high", "medium"], xhigh: ["xhigh", "high"] }[effort] || ["medium"];
  const cands = list.filter((id) => id.startsWith("gemini") && id.includes(`-${fam}-`));
  for (const e of order) { const hit = cands.find((id) => id.endsWith(`-${e}`)); if (hit) return hit; }
  if (cands[0]) return cands[0];
  throw new Error(`No Antigravity Gemini model for '${fam}'. Available: ${list.filter((x) => x.startsWith("gemini")).join(", ") || "none (sign in: run agy once)"}`);
}

/** Build argv for `agy mcp add <name> <nodePath> <mcpPath>` (execFile, no shell). */
export function agyMcpAddArgs(arg1 = {}, mcpPathArg, nameArg) {
  if (typeof arg1 === "string") {
    const nodePath = arg1 || process.execPath;
    const mcpPath = mcpPathArg || MCP_SERVER_PATH;
    const name = nameArg || AGY_MCP_NAME;
    return ["mcp", "add", name, nodePath, mcpPath];
  }
  const { name = AGY_MCP_NAME, nodePath = process.execPath, mcpPath = MCP_SERVER_PATH } = arg1 || {};
  return ["mcp", "add", name, nodePath, mcpPath];
}

/** Build argv for `agy mcp remove <name>` (execFile, no shell). */
export function agyMcpRemoveArgs(arg1 = {}) {
  if (typeof arg1 === "string") {
    return ["mcp", "remove", arg1 || AGY_MCP_NAME];
  }
  const { name = AGY_MCP_NAME } = arg1 || {};
  return ["mcp", "remove", name];
}

export function agyMcpStateFile(home = os.homedir()) {
  return path.join(home, ".tokenwise-studio", "antigravity-mcp.json");
}

export function readAgyMcpState(home = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(agyMcpStateFile(home), "utf8"));
  } catch {
    return null;
  }
}

let injectedMcpRunner = null;
/** Inject a runner `(bin, args) => void` in tests so real user Antigravity config is never touched. */
export function setAgyMcpRunner(fn) {
  injectedMcpRunner = typeof fn === "function" ? fn : null;
}

function defaultMcpRunner(bin, args) {
  if ((process.env.TOKENWISE_TEST === "1" || process.env.TOKENWISE_NO_REAL_AGY_MCP === "1") && !bin.startsWith(os.tmpdir())) {
    return "";
  }
  return execFileSync(bin, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Register or unregister tokenwise-studio in Antigravity's global MCP config via `execFileSync` (no shell).
 * Remembers registration state in ~/.tokenwise-studio/antigravity-mcp.json so enabling only runs `add` once
 * unless `force: true` is passed (e.g. during `tokenwise-studio setup`).
 */
export function syncGeminiMcp(enabled, {
  agyBin,
  name = AGY_MCP_NAME,
  nodePath = process.execPath,
  mcpPath = MCP_SERVER_PATH,
  runner,
  force = false,
  home,
  homeDir,
} = {}) {
  const effHome = home || homeDir || os.homedir();
  const bin = agyBin !== undefined ? agyBin : findAgy();
  if (!bin) return { ok: false, skipped: true, reason: "agy not installed" };
  const exec = runner || injectedMcpRunner || defaultMcpRunner;
  const stateFile = agyMcpStateFile(effHome);
  const prev = readAgyMcpState(effHome);

  if (enabled) {
    const args = agyMcpAddArgs({ name, nodePath, mcpPath });
    if (
      !force &&
      prev &&
      prev.registered === true &&
      prev.name === name &&
      prev.nodePath === nodePath &&
      prev.mcpPath === mcpPath
    ) {
      return { ok: true, action: "noop", alreadyRegistered: true, bin, args };
    }
    try {
      exec(bin, args);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        registered: true,
        enabled: true,
        name,
        nodePath,
        mcpPath,
        updatedAt: new Date().toISOString(),
      }, null, 2));
      return { ok: true, action: "add", bin, args };
    } catch (e) {
      return { ok: false, action: "add", bin, args, error: e.message };
    }
  }

  const args = agyMcpRemoveArgs({ name });
  try {
    exec(bin, args);
  } catch (e) {
    // `agy mcp remove` when not present is harmless; still record unregistered state if not a fatal runner error
    if (runner || injectedMcpRunner) {
      // let injected runner still record state below unless it threw intentionally
    } else if (!/not found|no such|does not exist/i.test(String(e.message || ""))) {
      return { ok: false, action: "remove", bin, args, error: e.message };
    }
  }
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      registered: false,
      enabled: false,
      name,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
  return { ok: true, action: "remove", bin, args };
}
