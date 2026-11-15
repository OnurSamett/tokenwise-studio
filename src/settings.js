// User settings stored in ~/.tokenwise-studio/settings.json, merged with defaults.
// Environment variables take higher priority and lock their corresponding fields in the UI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WORKER_AGENTS = ["codex", "gemini", "claude", "free", "local"];
export const ORCH_AGENTS = ["claude", "codex", "gemini", "free", "local"];
export const PERMISSION_MODES = ["ask", "auto-apply", "plan-only"];
export const ORCH_MODELS = ["opus", "sonnet", "haiku", "sol", "terra", "luna", "hydrogen", "argon", "free", "local"];
export const EFFORTS = ["low", "medium", "high", "xhigh"];
export const ORCH_FALLBACK_MODES = ["auto", "ask", "off"];
export const LANGUAGES = ["auto", "en", "tr"];
export const AUTO_UPDATE_MODES = ["auto", "notify", "off"];
export const PLAYTEST_MODELS = ["sonnet", "haiku", "opus", "codex:sol", "codex:terra"];

export const DEFAULTS = Object.freeze({
  language: "auto",
  permissionMode: "ask",
  defaultModel: "opus",
  defaultEffort: "medium",
  orchFallback: "auto",
  orchFallbackOrder: [...ORCH_AGENTS], // claude -> codex -> gemini -> free -> local
  allowGeminiOrchestrator: true, // adds tokenwise to Antigravity's global MCP settings (on by default)
  freeMode: false, // Free mode — no plan usage: orchestrator & all workers forced to free/local
  limitThreshold: 90,
  saveClaudeForPlanning: true, // keep Claude for planning and steer workers away once Claude passes pacingThreshold
  pacingThreshold: 70, // 50–89%, below limitThreshold
  fallbackOrder: [...WORKER_AGENTS],
  allowFree: false,
  fastMode: false,
  notifications: true,
  updateCheck: true,
  autoUpdate: "notify", // notify: only tell (default); auto: install verified GitHub releases in the background; off: neither
  autoUpdateMigrated: false, // internal: true once the user has chosen an update mode themselves (a stored "auto" from before v0.10.1 is read as "notify" until then)
  autoUpdateNoteSeen: true, // internal: false shows a one-time note that "auto" was reset to "notify"
  runTestsBeforeApply: false, // run the project tests in a write job's worktree when it finishes
  checkAfterApply: false, // run combined tests and lint in the main working tree after every Apply
  turnBudget: 0, // tokens per orchestrator turn (orchestrator + its workers); 0 = off
  compactChats: true, // summarize long chats and start a fresh session when context grows past threshold
  compactThreshold: 120_000, // orchestrator context token threshold (60k–400k)
  animations: true, // effort-aware working indicator and worker progress motion
  playtestEnabled: false, // default-off gate for Roblox Studio MCP playtesting
  playtestModel: "sonnet", // Claude Sonnet by default; Gemini cannot use per-session MCP
  playtestMaxCalls: 40, // max MCP tool calls per playtest
  playtestMaxScreenshots: 25, // max viewport captures per playtest
  playtestMaxMinutes: 10, // max playtest duration in minutes
  playtestAllowInput: false, // allow keyboard/mouse/navigation input simulation in Roblox Studio playtests (default off)
});

const cloneDefaults = () => ({
  ...DEFAULTS,
  orchFallbackOrder: [...DEFAULTS.orchFallbackOrder],
  fallbackOrder: [...DEFAULTS.fallbackOrder],
});
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const settingsFile = () => path.join(os.homedir(), ".tokenwise-studio", "settings.json");

export const VALIDATORS = {
  language: (v) => LANGUAGES.includes(v) || `language must be one of ${LANGUAGES.join(", ")}`,
  permissionMode: (v) => PERMISSION_MODES.includes(v) || `permissionMode must be one of ${PERMISSION_MODES.join(", ")}`,
  defaultModel: (v) => ORCH_MODELS.includes(v) || `defaultModel must be one of ${ORCH_MODELS.join(", ")}`,
  defaultEffort: (v) => EFFORTS.includes(v) || `defaultEffort must be one of ${EFFORTS.join(", ")}`,
  orchFallback: (v) => ORCH_FALLBACK_MODES.includes(v) || `orchFallback must be one of ${ORCH_FALLBACK_MODES.join(", ")}`,
  orchFallbackOrder: (v) =>
    (Array.isArray(v) && v.length === ORCH_AGENTS.length && new Set(v).size === ORCH_AGENTS.length && v.every((a) => ORCH_AGENTS.includes(a))) ||
    `orchFallbackOrder must be a permutation of ${ORCH_AGENTS.join(", ")}`,
  allowGeminiOrchestrator: (v) => typeof v === "boolean" || "allowGeminiOrchestrator must be true or false",
  freeMode: (v) => typeof v === "boolean" || "freeMode must be true or false",
  limitThreshold: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 50 && v <= 100) || "limitThreshold must be a number between 50 and 100",
  saveClaudeForPlanning: (v) => typeof v === "boolean" || "saveClaudeForPlanning must be true or false",
  pacingThreshold: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 50 && v <= 89) || "pacingThreshold must be a number between 50 and 89",
  fallbackOrder: (v) =>
    (Array.isArray(v) && v.length === WORKER_AGENTS.length && new Set(v).size === WORKER_AGENTS.length && v.every((a) => WORKER_AGENTS.includes(a))) ||
    `fallbackOrder must be a permutation of ${WORKER_AGENTS.join(", ")}`,
  allowFree: (v) => typeof v === "boolean" || "allowFree must be true or false",
  fastMode: (v) => typeof v === "boolean" || "fastMode must be true or false",
  notifications: (v) => typeof v === "boolean" || "notifications must be true or false",
  autoUpdate: (v) => AUTO_UPDATE_MODES.includes(v) || `autoUpdate must be one of ${AUTO_UPDATE_MODES.join(", ")}`,
  autoUpdateMigrated: (v) => typeof v === "boolean" || "autoUpdateMigrated must be true or false",
  autoUpdateNoteSeen: (v) => typeof v === "boolean" || "autoUpdateNoteSeen must be true or false",
  updateCheck: (v) => typeof v === "boolean" || "updateCheck must be true or false",
  runTestsBeforeApply: (v) => typeof v === "boolean" || "runTestsBeforeApply must be true or false",
  checkAfterApply: (v) => typeof v === "boolean" || "checkAfterApply must be true or false",
  turnBudget: (v) => v === 0 || (Number.isInteger(v) && v >= 10_000 && v <= 50_000_000) || "turnBudget must be 0 (off) or a token count between 10000 and 50000000",
  compactChats: (v) => typeof v === "boolean" || "compactChats must be true or false",
  compactThreshold: (v) => (Number.isInteger(v) && v >= 60_000 && v <= 400_000) || "compactThreshold must be a token count between 60000 and 400000",
  animations: (v) => typeof v === "boolean" || "animations must be true or false",
  playtestEnabled: (v) => typeof v === "boolean" || "playtestEnabled must be true or false",
  playtestModel: (v) => PLAYTEST_MODELS.includes(v) || `playtestModel must be one of ${PLAYTEST_MODELS.join(", ")}`,
  playtestMaxCalls: (v) => (Number.isInteger(v) && v >= 1 && v <= 200) || "playtestMaxCalls must be an integer between 1 and 200",
  playtestMaxScreenshots: (v) => (Number.isInteger(v) && v >= 1 && v <= 100) || "playtestMaxScreenshots must be an integer between 1 and 100",
  playtestMaxMinutes: (v) => (Number.isInteger(v) && v >= 1 && v <= 30) || "playtestMaxMinutes must be an integer between 1 and 30",
  playtestAllowInput: (v) => typeof v === "boolean" || "playtestAllowInput must be true or false",
};

/** Clamp playtest maxCalls/maxScreenshots/maxMinutes to valid integers verified by VALIDATORS. */
export function clampPlaytestLimits({ maxCalls, maxScreenshots, maxMinutes } = {}, fallback = DEFAULTS) {
  const clampOne = (raw, def, min, max, validate) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    const clamped = Math.max(min, Math.min(max, Math.trunc(n)));
    return validate(clamped) === true ? clamped : def;
  };
  return {
    maxCalls: clampOne(maxCalls, fallback.playtestMaxCalls ?? DEFAULTS.playtestMaxCalls, 1, 200, VALIDATORS.playtestMaxCalls),
    maxScreenshots: clampOne(maxScreenshots, fallback.playtestMaxScreenshots ?? DEFAULTS.playtestMaxScreenshots, 1, 100, VALIDATORS.playtestMaxScreenshots),
    maxMinutes: clampOne(maxMinutes, fallback.playtestMaxMinutes ?? DEFAULTS.playtestMaxMinutes, 1, 30, VALIDATORS.playtestMaxMinutes),
  };
}

/** Load raw file settings merged with defaults (no env overrides). Never throws. */
function loadStored() {
  const out = cloneDefaults();
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    if (!isObj(raw)) return out;
    for (const k of Object.keys(DEFAULTS)) {
      if (k in raw && VALIDATORS[k](raw[k]) === true) {
        out[k] = Array.isArray(raw[k]) ? [...raw[k]] : raw[k];
      }
    }
    // Before v0.10.1 "auto" was the default, so a stored "auto" may never have been a deliberate choice (and it
    // installed from an unpinned source). Read it as "notify" once and tell the user; choosing a mode clears this.
    if (raw.autoUpdate === "auto" && raw.autoUpdateMigrated !== true) {
      out.autoUpdate = "notify";
      if (!("autoUpdateNoteSeen" in raw)) out.autoUpdateNoteSeen = false;
    }
  } catch {}
  return out;
}

/** Apply environment variable overrides onto a settings object and record locked keys. */
function applyEnv(base) {
  const settings = {
    ...base,
    orchFallbackOrder: [...(base.orchFallbackOrder || DEFAULTS.orchFallbackOrder)],
    fallbackOrder: [...base.fallbackOrder],
  };
  const envLocked = {};

  const orchEnv = process.env.TOKENWISE_ORCH_FALLBACK;
  if (orchEnv === "0" || orchEnv === "1") {
    settings.orchFallback = orchEnv === "0" ? "off" : "auto";
    envLocked.orchFallback = true;
  }

  const geminiOrchEnv = process.env.TOKENWISE_ALLOW_GEMINI_ORCH;
  if (geminiOrchEnv === "0" || geminiOrchEnv === "1") {
    settings.allowGeminiOrchestrator = geminiOrchEnv === "1";
    envLocked.allowGeminiOrchestrator = true;
  }

  const freeModeEnv = process.env.TOKENWISE_FREE_MODE;
  if (freeModeEnv === "0" || freeModeEnv === "1") {
    settings.freeMode = freeModeEnv === "1";
    envLocked.freeMode = true;
  }

  const thEnv = process.env.TOKENWISE_LIMIT_THRESHOLD;
  if (thEnv !== undefined && thEnv !== "") {
    const n = Number(thEnv);
    if (Number.isFinite(n)) {
      settings.limitThreshold = n;
      envLocked.limitThreshold = true;
    }
  }

  const fbEnv = process.env.TOKENWISE_FALLBACK;
  if (fbEnv !== undefined && fbEnv.trim() !== "") {
    const list = fbEnv.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      settings.fallbackOrder = list;
      envLocked.fallbackOrder = true;
    }
  }

  const freeEnv = process.env.TOKENWISE_ALLOW_FREE;
  if (freeEnv !== undefined && freeEnv !== "") {
    settings.allowFree = freeEnv === "1";
    envLocked.allowFree = true;
  }

  const notifyEnv = process.env.TOKENWISE_NOTIFY;
  if (notifyEnv === "0" || notifyEnv === "1") {
    settings.notifications = notifyEnv === "1";
    envLocked.notifications = true;
  }

  return { settings, envLocked };
}

/** Effective settings (defaults + file + env overrides). Never throws. */
export function loadSettings() {
  return applyEnv(loadStored()).settings;
}

/** Full payload for GET/POST /api/settings. */
export function settingsInfo() {
  const { settings, envLocked } = applyEnv(loadStored());
  return { settings, defaults: cloneDefaults(), envLocked };
}

/** Validate a partial or full settings patch, persist to disk, and return effective settings. */
export function saveSettings(patch = {}) {
  if (!isObj(patch)) throw new Error("settings must be an object");
  for (const k of Object.keys(patch)) {
    if (!Object.hasOwn(DEFAULTS, k)) throw new Error(`unknown setting '${k}'`);
    const ok = VALIDATORS[k](patch[k]);
    if (ok !== true) throw new Error(ok);
  }
  const cur = loadStored();
  for (const k of Object.keys(patch)) {
    cur[k] = Array.isArray(patch[k]) ? [...patch[k]] : patch[k];
  }
  if ("autoUpdate" in patch) { cur.autoUpdateMigrated = true; if (!("autoUpdateNoteSeen" in patch)) cur.autoUpdateNoteSeen = true; }
  const effLimit = applyEnv(cur).settings.limitThreshold;
  if ("pacingThreshold" in patch && cur.pacingThreshold >= effLimit) {
    throw new Error(`pacingThreshold must be below limitThreshold (${effLimit})`);
  }
  if ("limitThreshold" in patch && !("pacingThreshold" in patch) && cur.pacingThreshold >= effLimit && effLimit > 50) {
    cur.pacingThreshold = Math.max(50, Math.min(89, effLimit - 1));
  }
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  return loadSettings();
}
