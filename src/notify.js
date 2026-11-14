// Desktop notifications (macOS, via osascript). Fire-and-forget: never throws, never uses a shell.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const settingsFile = () => path.join(os.homedir(), ".tokenwise-studio", "settings.json");
const DEFAULTS = { notifications: true };

export function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { ...DEFAULTS, notifications: typeof s.notifications === "boolean" ? s.notifications : DEFAULTS.notifications };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(patch = {}) {
  const cur = loadSettings();
  if ("notifications" in patch) {
    if (typeof patch.notifications !== "boolean") throw new Error("notifications must be true or false");
    cur.notifications = patch.notifications;
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(cur, null, 2));
  return cur;
}

const trunc = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
/** Quote a string as an AppleScript literal (escape backslash, then double quote). */
export const asString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function buildScript({ title = "tokenwise studio", message = "", subtitle = "" }) {
  let s = `display notification ${asString(trunc(message, 180))} with title ${asString(trunc(title, 60))}`;
  if (subtitle) s += ` subtitle ${asString(trunc(subtitle, 60))}`;
  return s + ` sound name "Glass"`;
}

const seen = new Set();

/** deps (for tests): { exec, platform, settings }. Returns true when a notification was handed to osascript. */
export function notify({ title, message, subtitle, key } = {}, deps = {}) {
  try {
    if ((deps.platform || process.platform) !== "darwin") return false;
    if (process.env.TOKENWISE_NOTIFY === "0") return false;
    if (!(deps.settings || loadSettings()).notifications) return false;
    if (key) { if (seen.has(key)) return false; seen.add(key); }
    const run = deps.exec || execFile;
    run("osascript", ["-e", buildScript({ title, message, subtitle })], { timeout: 5000 }, () => {});
    return true;
  } catch { return false; }
}

// ---- display names ----
const AGENTS = { codex: "Codex", claude: "Claude", gemini: "Gemini", local: "Local", free: "Free API" };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
/** "Codex Sol", "Claude Haiku", "Free API Deepseek-v4.1-flash" from an agent id and model. */
export function agentLabel(agent, model) {
  const a = AGENTS[agent] || cap(agent || "Worker");
  // Same naming as the UI: model families ("gpt-6.1-terra" -> "Terra", "claude-haiku-5-5" -> "Haiku");
  // free models keep their own name, tidied ("nvidia:deepseek-ai/deepseek-v4.1-flash" -> "Deepseek V4.1 Flash").
  const raw = String(model || "");
  const fam = agent !== "free" && raw.match(/(luna|terra|sol|astra|haiku|sonnet|opus|flash|argon|hydrogen|pro)/i);
  const m = fam ? cap(fam[1].toLowerCase()) : agent === "local" ? raw
    : raw.split("/").pop().split(":").pop().split("-").filter(Boolean).map((w) => cap(w)).join(" ");
  return m && m !== "Auto" ? `${a} ${m}` : a;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** What to say when a direct job (no parent chat) ends; null for nothing. fileCount may be undefined. */
export function jobNotice(j, fileCount) {
  if (!j || j.parent) return null;
  const who = agentLabel(j.agent, j.model), title = j.title || "job";
  if (j.status === "failed") return { title: "Worker failed", message: `${who}: ${title}` };
  if (j.status !== "done") return null; // moved, discarded, running
  if (j.write) {
    if (!j.diffStat || j.diffStat === "(no changes)" || j.diffStat.startsWith("diff failed") || fileCount === 0) {
      return { title: "Worker finished", message: `${who}: ${title}` };
    }
    const n = typeof fileCount === "number" ? ` · ${plural(fileCount, "file")} changed` : "";
    return { title: "Ready for review", message: `${who} finished: ${title}${n}` };
  }
  return { title: "Worker finished", message: `${who}: ${title}` };
}

/** What to say when an orchestrator turn ends; null if the user stopped it. */
export function turnNotice({ turn, chatTitle, failed, stopped, readyJobs = 0 }) {
  if (stopped) return null;
  const first = String(turn?.reply || "").split("\n").map((l) => l.trim()).find(Boolean) || "Turn complete";
  const prefix = readyJobs > 0 ? `${plural(readyJobs, "job")} ready for review · ` : "";
  return { title: failed ? "Orchestrator needs you" : "Orchestrator finished", message: trunc(prefix + trunc(first, 150), 180), subtitle: chatTitle || "" };
}

export const handoffNotice = (reason) => ({ title: "Codex took over", message: `Claude ${String(reason || "is unavailable").replace(/^Claude /, "")}` });
