// @mentions: route one message's work to a named worker (agent or model).
// Shared between ui/index.html (the @ menu and chips) and the server (validation and the orchestrator guide).
// Only names in MENTIONS are accepted. astra is deliberately absent: the guide says never to use it unasked.

export const MENTIONS = Object.freeze([
  { name: "codex", agent: "codex", model: null, label: "Codex" },
  { name: "claude", agent: "claude", model: null, label: "Claude" },
  { name: "gemini", agent: "gemini", model: null, label: "Gemini" },
  { name: "free", agent: "free", model: null, label: "Free API" },
  { name: "local", agent: "local", model: null, label: "Local (Ollama)" },
  { name: "sol", agent: "codex", model: "sol", label: "Codex Sol" },
  { name: "terra", agent: "codex", model: "terra", label: "Codex Terra" },
  { name: "luna", agent: "codex", model: "luna", label: "Codex Luna" },
  { name: "opus", agent: "claude", model: "opus", label: "Claude Opus" },
  { name: "sonnet", agent: "claude", model: "sonnet", label: "Claude Sonnet" },
  { name: "haiku", agent: "claude", model: "haiku", label: "Claude Haiku" },
  { name: "hydrogen", agent: "gemini", model: "hydrogen", label: "Gemini Hydrogen" },
  { name: "argon", agent: "gemini", model: "argon", label: "Gemini Argon" },
]);

export const MAX_MENTIONS = 4;
const BY_NAME = new Map(MENTIONS.map((m) => [m.name, m]));
export const mentionInfo = (name) => BY_NAME.get(String(name || "").toLowerCase().replace(/^@/, "")) || null;

/** Find @name tokens in text. A token must start the text or follow whitespace/punctuation (so emails and @scope/pkg are not mentions). */
export function parseMentions(text) {
  const names = [], unknown = [];
  const re = /(^|[^\w@./-])@([a-z][a-z0-9-]{0,30})(?![\w@/-])/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const n = m[2].toLowerCase();
    const list = BY_NAME.has(n) ? names : unknown;
    if (!list.includes(n)) list.push(n);
  }
  return { names, unknown };
}

/** Validate the `mentions` field of a chat request. Returns canonical names (no @), de-duplicated. Throws on anything unknown. */
export function normalizeMentions(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("mentions must be a list");
  const out = [];
  for (const raw of input) {
    if (typeof raw !== "string") throw new Error("mentions must be strings");
    const n = raw.trim().toLowerCase().replace(/^@/, "");
    if (!BY_NAME.has(n)) throw new Error(`unknown mention @${n.slice(0, 30)}`);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > MAX_MENTIONS) throw new Error(`at most ${MAX_MENTIONS} mentions per message`);
  return out;
}

/** The orchestrator guide paragraph for this message's mentions, or "" when there are none. */
export function mentionGuide(names) {
  const list = (names || []).map(mentionInfo).filter(Boolean);
  if (!list.length) return "";
  const who = list.map((m) => m.label).join(" and ");
  const how = list.map((m) => (m.model
    ? `${m.label}: delegate with agent="${m.agent}", model="${m.model}"`
    : m.agent === "free" ? `${m.label}: delegate with agent="free", model="auto"`
    : `${m.label}: delegate with agent="${m.agent}" and choose a fitting model yourself`)).join("; ");
  return `The user asked to use ${who} for this message. Send this message's work to that worker instead of your usual pick (${how}). The team settings still apply to everything the mention does not cover. If that worker is unavailable or out of quota, say so briefly and use the next best one.`;
}
