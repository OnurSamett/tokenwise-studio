// Team settings: per project, either "auto" (the orchestrator picks workers by its guide) or
// "manual" (the user picks agent/model/effort per role). Stored in <repo>/.tokenwise-studio/team.json.
import fs from "node:fs";
import path from "node:path";
import { doctor, workerReady } from "./doctor.js";
import { agyModels } from "./antigravity.js";
import { freeProviders } from "./freechat.js";
import { CATALOG, describe } from "./models.js";
import { loadSettings } from "./settings.js";
import { claudePacing, getCooldown } from "./fallback.js";

export const ROLES = ["code", "quick", "review", "research", "images"];
export const JOB_ROLES = [...ROLES, "playtest"];
const LABELS = {
  code: "Writes code",
  quick: "Quick & mechanical work",
  review: "Reviews and second opinions",
  research: "Web research",
  images: "Images",
};
const WORK = {
  code: "Writing code",
  quick: "Quick & mechanical work",
  review: "Reviews and second opinions",
  research: "Web research",
  images: "Images",
};

export const PRESETS = {
  quality: {
    code: { agent: "codex", model: "sol", effort: "high" },
    quick: { agent: "gemini", model: "hydrogen", effort: "medium" },
    review: { agent: "claude", model: "opus", effort: "high" },
    research: { agent: "claude", model: "sonnet", effort: "high" },
    images: { agent: "codex" },
  },
  balanced: {
    code: { agent: "codex", model: "sol", effort: "medium" },
    quick: { agent: "free", model: "auto", effort: "medium" },
    review: { agent: "claude", model: "sonnet", effort: "medium" },
    research: { agent: "gemini", model: "hydrogen", effort: "medium" },
    images: { agent: "codex" },
  },
  cheap: {
    code: { agent: "free", model: "auto", effort: "medium" },
    quick: { agent: "free", model: "auto", effort: "low" },
    review: { agent: "gemini", model: "hydrogen", effort: "low" },
    research: { agent: "gemini", model: "hydrogen", effort: "low" },
    images: { agent: "codex" },
  },
  // Free hosted models only; research has no free option, so it keeps the cheapest Gemini.
  free: {
    code: { agent: "free", model: "auto", effort: "medium" },
    quick: { agent: "free", model: "auto", effort: "low" },
    review: { agent: "free", model: "auto", effort: "medium" },
    research: { agent: "gemini", model: "hydrogen", effort: "low" },
    images: { agent: "codex" },
  },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
export const DEFAULT_TEAM = { mode: "auto", preset: null, roles: clone(PRESETS.balanced), allow: { free: true, astra: false } };

const AGENTS = ["codex", "claude", "gemini", "cursor", "free"];
const EFFORTS = ["low", "medium", "high", "xhigh"];
const MODEL = /^[\w.\/:-]{1,120}$/;
const FREE_MODEL = /^(nvidia|openrouter|groq|mistral|custom):[\w.\/:-]{1,120}$/;
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** Validate strictly; unknown keys are dropped. Missing roles/fields fall back to the defaults. */
function normalize(input) {
  if (!isObj(input)) throw new Error("team settings must be an object");
  const mode = input.mode ?? DEFAULT_TEAM.mode;
  if (!["auto", "manual"].includes(mode)) throw new Error("mode must be 'auto' or 'manual'");
  const preset = input.preset ?? null;
  if (preset !== null && !Object.hasOwn(PRESETS, preset)) throw new Error(`preset must be null or one of ${Object.keys(PRESETS).join(", ")}`);
  const allowIn = input.allow ?? {};
  if (!isObj(allowIn)) throw new Error("allow must be an object");
  const allow = { ...DEFAULT_TEAM.allow };
  for (const k of ["free", "astra"]) {
    if (allowIn[k] === undefined) continue;
    if (typeof allowIn[k] !== "boolean") throw new Error(`allow.${k} must be true or false`);
    allow[k] = allowIn[k];
  }
  const rolesIn = input.roles ?? {};
  if (!isObj(rolesIn)) throw new Error("roles must be an object");
  for (const k of Object.keys(rolesIn)) if (!ROLES.includes(k)) throw new Error(`unknown role '${k}' (roles: ${ROLES.join(", ")})`);
  const roles = {};
  for (const r of ROLES) {
    const src = rolesIn[r];
    if (src === undefined) { roles[r] = clone(DEFAULT_TEAM.roles[r]); continue; }
    if (!isObj(src)) throw new Error(`role '${r}' must be an object`);
    const allowed = r === "images" ? ["codex"] : AGENTS;
    if (!allowed.includes(src.agent)) throw new Error(`role '${r}': agent must be one of ${allowed.join(", ")}`);
    const out = { agent: src.agent };
    if (src.model !== undefined) {
      if (typeof src.model !== "string" || !MODEL.test(src.model)) throw new Error(`role '${r}': invalid model`);
      if (src.agent === "free" && src.model !== "auto" && !FREE_MODEL.test(src.model)) throw new Error(`role '${r}': free model must be 'auto' or provider:model (nvidia|openrouter|groq|mistral|custom)`);
      if (/astra/i.test(src.model) && !allow.astra) throw new Error(`role '${r}': astra models need allow.astra`);
      out.model = src.model;
    }
    if (src.effort !== undefined) {
      if (!EFFORTS.includes(src.effort)) throw new Error(`role '${r}': effort must be one of ${EFFORTS.join(", ")}`);
      out.effort = src.effort;
    } else if (r !== "images") out.effort = "medium";
    roles[r] = out;
  }
  return { mode, preset, roles, allow };
}

/** Validate a per-message role override ({ code: {agent, model, effort}, ... }): only the roles given, same rules as saved teams. */
export function normalizeTeamOverride(input, { allowAstra = false } = {}) {
  if (input === undefined || input === null) return null;
  if (!isObj(input)) throw new Error("team override must be an object");
  const keys = Object.keys(input);
  if (!keys.length) return null;
  const checked = normalize({ mode: "manual", roles: input, allow: { astra: allowAstra } });
  return Object.fromEntries(keys.map((k) => [k, checked.roles[k]]));
}

/** Guide text for a per-message override. */
export function overrideGuide(roles, { allowFree = true } = {}) {
  if (!roles) return "";
  const lines = [];
  for (const r of ROLES) {
    const w = roles[r];
    if (!w) continue;
    if (w.agent === "free" && !allowFree) continue;
    if (r === "images") { lines.push(`- ${WORK[r]}: ${w.agent}`); continue; }
    const who = w.model ? (w.model === "auto" ? `${w.agent} (auto model)` : `${w.agent} ${w.model}`) : w.agent;
    lines.push(`- ${WORK[r]}: ${who}${w.effort ? ` (${w.effort} effort)` : ""}`);
  }
  if (!lines.length) return "";
  return "For this message only the user chose these workers (they replace the team settings for these roles):\n" + lines.join("\n");
}

const teamFile = (home) => path.join(home, "team.json");

/** Never throws: a missing or invalid file gives the defaults. */
export function loadTeam(home) {
  try { return normalize(JSON.parse(fs.readFileSync(teamFile(home), "utf8"))); } catch { return clone(DEFAULT_TEAM); }
}

export function saveTeam(home, input) {
  const team = normalize(input);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(teamFile(home), JSON.stringify(team, null, 2));
  return team;
}

export function geminiFamilies() {
  try {
    const fams = new Set();
    for (const id of agyModels() || []) {
      const m = id.match(/^gemini-[\d.]+-([a-z]+)/i);
      if (m) fams.add(m[1].toLowerCase());
    }
    if (fams.size) return [...fams];
  } catch {}
  return ["hydrogen", "argon"];
}

/** What the UI can offer. Never throws. */
export function teamOptions(freeModels = [], { home = null, orchestratorAgent = "claude", doctorData = null, skipModelProbe = false } = {}) {
  let d = {};
  try { d = doctorData || doctor() || {}; } catch {}
  const ready = (a) => workerReady(d[a]);
  let providers = [];
  try { providers = freeProviders().map((p) => p.name); } catch {}
  const fam = (agent) => Object.fromEntries(CATALOG.filter((c) => c.agent === agent).map((c) => [c.family, c.label]));
  const freeIds = (freeModels || []).map((m) => m.id);
  const settings = loadSettings();
  let pacing = null;
  try { pacing = home ? claudePacing(home, { settings, orchestratorAgent }) : null; } catch {}
  const freeAllowed = (settings.allowFree || settings.freeMode) && (!home || settings.freeMode || loadTeam(home).allow.free !== false);
  const prefer = pacing?.active ? ["codex", "gemini", ...(freeAllowed ? ["free"] : [])] : null;
  const cdOf = (a) => {
    const cd = getCooldown(a);
    return cd ? { until: cd.until, reason: cd.reason } : null;
  };
  return {
    agents: {
      codex: { ready: ready("codex") && !settings.freeMode, cooldown: cdOf("codex"), models: ["luna", "terra", "sol", "astra"], labels: fam("codex"), unsupportedRoles: [] },
      claude: { ready: ready("claude") && !settings.freeMode, cooldown: cdOf("claude"), pacing: !!pacing?.active, models: ["haiku", "sonnet", "opus"], labels: fam("claude"), unsupportedRoles: [] },
      gemini: { ready: ready("gemini") && !settings.freeMode, cooldown: cdOf("gemini"), models: skipModelProbe ? ["hydrogen", "argon"] : geminiFamilies(), labels: fam("gemini"), unsupportedRoles: [] },
      cursor: { ready: ready("cursor") && !settings.freeMode, cooldown: cdOf("cursor"), models: ["auto"], labels: {}, unsupportedRoles: ["research"] },
      free: { ready: providers.length > 0, cooldown: cdOf("free"), models: ["auto", ...freeIds], labels: Object.fromEntries(freeIds.map((id) => [id, describe("free", id)?.label || id.slice(id.indexOf(":") + 1)])), providers, optIn: Boolean(settings.allowFree || settings.freeMode), unsupportedRoles: ["research"] },
    },
    roles: ROLES.map((id) => ({
      id,
      label: LABELS[id],
      ...(id === "research" ? { unsupportedAgents: ["free", "cursor"] } : id === "images" ? { supportedAgents: ["codex"] } : {}),
    })),
    presets: Object.keys(PRESETS),
    pacing: pacing?.active ? { ...pacing, prefer } : { active: false },
    freeMode: Boolean(settings.freeMode),
  };
}

/** Text block appended to the orchestrator's system prompt. Empty in auto mode unless pacing is active. */
export function teamGuide(team, { pacing = null, allowFree = loadSettings().allowFree, freeMode = loadSettings().freeMode } = {}) {
  if (freeMode) {
    return [
      "Free mode is ON (no plan usage): all worker roles are forced to free or local models.",
      "- Writing code: free (auto model) or local",
      "- Quick & mechanical work: free (auto model) or local",
      "- Reviews and second opinions: free (auto model) or local",
      "Never delegate to codex, claude, gemini, or cursor while Free mode is on (delegations to paid plans are refused).",
    ].join("\n");
  }
  const freeAllowed = allowFree && team?.allow?.free !== false;
  const preferList = freeAllowed ? "codex, gemini or free" : "codex or gemini";
  const paceLine = pacing?.active
    ? `Quota pacing is active (Claude ${pacing.window} usage at ${pacing.pct}%): save Claude for planning and steer worker jobs away from claude (prefer ${preferList}).`
    : "";
  if (!team || team.mode !== "manual") return paceLine;
  const lines = [];
  for (const r of ROLES) {
    const w = team.roles?.[r];
    if (!w) continue;
    if (w.model && /astra/i.test(w.model) && !team.allow?.astra) continue;
    if (w.agent === "free" && team.allow?.free === false) continue;
    const bits = [];
    if (r === "images") { lines.push(`- ${WORK[r]}: ${w.agent}`); continue; }
    if (r === "research" && (w.agent === "free" || w.agent === "local")) {
      lines.push(`- ${WORK[r]}: ${w.agent} (does not support live web search; use claude, gemini or codex if live web info is needed)`);
      continue;
    }
    if (w.model) bits.push(w.model === "auto" ? `${w.agent} (auto model)` : `${w.agent} ${w.model}`); else bits.push(w.agent);
    lines.push(`- ${WORK[r]}: ${bits[0]}${w.effort ? ` (${w.effort} effort)` : ""}`);
  }
  let g = "The user chose the team for this project. Use exactly these workers unless a plan is out of quota:\n" + lines.join("\n") +
    "\nDo not pick other agents/models on your own.";
  if (team.allow?.free === false) g += "\nNever use the 'free' agent.";
  if (paceLine) g += `\n${paceLine}`;
  return g;
}
