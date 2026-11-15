// Desktop notifications: native Mac app, or a queue delivered to the browser Notification API. Never throws.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings } from "./settings.js";
import { t, tp, resolveLanguage, translateReason } from "../ui/i18n.js";
import { formatHHMM } from "./cooldowns.js";
import { BUNDLE_ID, findAppBundle } from "./appbundle.js";

export { loadSettings, saveSettings };

export const LIMIT_UNKNOWN_WINDOW_MS = 5 * 60 * 60 * 1000;

const noticeLang = (opts = {}) => resolveLanguage(opts.lang ?? (opts.settings || loadSettings()).language, opts);

const trunc = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

const seen = new Set();
let loggedMissingApp = false;
const browserNotices = [];
let noticeId = 0;
export const pendingBrowserNotices = (repo) => browserNotices.filter(n => !n.repo || n.repo === repo);

export function resetNotifyState() {
  seen.clear();
  browserNotices.length = 0;
  loggedMissingApp = false;
}

/** Path of our own notifier app executable when it is installed (executable + our bundle id), else null. */
export function nativeNotifier(deps = {}) {
  try {
    if (deps.binary) {
      const fsys = deps.fs || fs;
      const xOk = fsys.constants?.X_OK ?? fs.constants.X_OK;
      fsys.accessSync(deps.binary, xOk);
      const plist = path.join(path.dirname(deps.binary), "..", "Info.plist");
      const text = deps.plist !== undefined ? deps.plist : fsys.readFileSync(plist, "utf8");
      return text.includes(`<string>${BUNDLE_ID}</string>`) ? deps.binary : null;
    }
    return findAppBundle(deps)?.binaryPath || null;
  } catch { return null; }
}

/** deps (for tests): { exec, execFileSync, fs, home, native, platform, settings, log }. Returns true when handed to the native app or queued for the browser. */
export function notify({ title, message, subtitle, key, repo } = {}, deps = {}) {
  try {
    if (process.env.TOKENWISE_NOTIFY === "0") return false;
    if (!(deps.settings || loadSettings()).notifications) return false;
    if ((deps.platform || process.platform) !== "darwin") {
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      browserNotices.push({ id: ++noticeId, title: trunc(title || "tokenwise studio", 60), message: trunc(message, 180), subtitle: trunc(subtitle, 60), repo, at: Date.now() });
      if (browserNotices.length > 40) browserNotices.shift();
      return true;
    }
    const bin = deps.native !== undefined
      ? deps.native
      : nativeNotifier({ ...deps, exec: deps.execFileSync });
    if (!bin) {
      if (!loggedMissingApp) {
        loggedMissingApp = true;
        (deps.log || console.warn)("tokenwise studio: native app not found; skipping desktop notifications");
      }
      return false;
    }
    if (key) { if (seen.has(key)) return false; seen.add(key); }
    const run = deps.exec || execFile;
    const args = ["--notify", "--title", trunc(title || "tokenwise studio", 60), "--message", trunc(message, 180)];
    if (subtitle) args.push("--subtitle", trunc(subtitle, 60));
    if (repo) args.push("--repo", String(repo));
    run(bin, args, { timeout: 10000 }, () => {});
    return true;
  } catch { return false; }
}

// ---- per-window limit notification deduplication ----

export const notifiedFile = (home = os.homedir()) => path.join(home, ".tokenwise-studio", "notified.json");

function readNotified(file, fsys = fs) {
  try {
    const raw = JSON.parse(fsys.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeNotified(file, map, fsys = fs) {
  try {
    fsys.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof fsys.renameSync === "function") {
      const tmp = `${file}.${process.pid}.tmp`;
      fsys.writeFileSync(tmp, JSON.stringify(map, null, 2));
      fsys.renameSync(tmp, file);
    } else {
      fsys.writeFileSync(file, JSON.stringify(map, null, 2));
    }
  } catch {}
}

/** True if no limit notice was sent yet for this provider, or the recorded limit window has reset. */
export function shouldNotifyLimit(provider, { now = Date.now(), home = os.homedir(), fs: fsys = fs } = {}) {
  if (!provider) return false;
  const entry = readNotified(notifiedFile(home), fsys)[`limit:${provider}`];
  if (!entry) return true;
  if (typeof entry === "number") return now >= entry;
  if (typeof entry === "object") {
    if (typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt)) return now >= entry.resetsAt;
    if (typeof entry.at === "number" && Number.isFinite(entry.at)) return now - entry.at >= LIMIT_UNKNOWN_WINDOW_MS;
  }
  return true;
}

/** Record that a limit notification was sent for `provider` in ~/.tokenwise-studio/notified.json. */
export function recordLimitNotified(provider, { resetsAt = null, now = Date.now(), home = os.homedir(), fs: fsys = fs } = {}) {
  if (!provider) return;
  const file = notifiedFile(home);
  const map = readNotified(file, fsys);
  map[`limit:${provider}`] = typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > now
    ? { resetsAt, at: now }
    : { at: now };
  writeNotified(file, map, fsys);
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

/** What to say when a direct job (no parent chat) ends; null for nothing. fileCount may be undefined. */
export function jobNotice(j, fileCount, opts = {}) {
  if (!j || j.parent) return null;
  const lang = noticeLang(opts);
  const who = agentLabel(j.agent, j.model), title = j.title || t("notify.jobFallback", {}, lang);
  if (j.status === "failed") return { title: t("notify.workerFailed", {}, lang), message: `${who}: ${title}` };
  if (j.status !== "done") return null; // moved, discarded, running
  if (j.write) {
    if (!j.diffStat || j.diffStat === "(no changes)" || j.diffStat.startsWith("diff failed") || fileCount === 0) {
      return { title: t("notify.workerFinished", {}, lang), message: `${who}: ${title}` };
    }
    const files = typeof fileCount === "number" ? ` · ${tp("notify.filesChanged", fileCount, {}, lang)}` : "";
    return { title: t("notify.readyForReview", {}, lang), message: t("notify.workerFinishedMsg", { who, title, files }, lang) };
  }
  return { title: t("notify.workerFinished", {}, lang), message: `${who}: ${title}` };
}

/** What to say when an orchestrator turn ends; null if the user stopped it. */
export function turnNotice({ turn, chatTitle, failed, stopped, readyJobs = 0, lang, settings } = {}, opts = {}) {
  if (stopped) return null;
  const l = noticeLang({ lang: lang ?? opts.lang, settings: settings ?? opts.settings, env: opts.env, intlLocale: opts.intlLocale });
  const first = String(turn?.reply || "").split("\n").map((line) => line.trim()).find(Boolean) || t("notify.turnComplete", {}, l);
  const prefix = readyJobs > 0 ? tp("notify.jobsReady", readyJobs, {}, l) : "";
  return { title: t(failed ? "notify.orchNeedsYou" : "notify.orchFinished", {}, l), message: trunc(prefix + trunc(first, 150), 180), subtitle: chatTitle || "" };
}

export const handoffNotice = (reason, opts = {}) => {
  const l = noticeLang(opts);
  const toLabel = opts.toAgent && AGENTS[opts.toAgent] ? AGENTS[opts.toAgent] : "Codex";
  const fromLabel = opts.fromAgent && AGENTS[opts.fromAgent] ? AGENTS[opts.fromAgent] : "Claude";
  const clean = translateReason(reason || t("reason.unavailable", {}, l), l).replace(/^(?:Claude|Codex|Gemini|Free API|Local)\s+/i, "");
  if (toLabel === "Codex" && fromLabel === "Claude") {
    return { title: t("notify.codexTookOver", {}, l), message: t("notify.claudeReason", { reason: clean }, l) };
  }
  return {
    title: t("notify.agentTookOver", { to: toLabel }, l),
    message: t("notify.agentReason", { from: fromLabel, reason: clean }, l),
  };
};

/** Limit handoff notice with optional reset time ("Claude hit its limit · Codex is orchestrating until HH:MM"). */
export function limitHandoffNotice({ provider = "claude", toAgent = "codex", resetsAt = null, lang, settings } = {}, opts = {}) {
  const l = noticeLang({ lang: lang ?? opts.lang, settings: settings ?? opts.settings, env: opts.env, intlLocale: opts.intlLocale });
  const now = opts.now ?? Date.now();
  const hasReset = typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > now;
  const fromLabel = AGENTS[provider] || cap(provider || "Claude");
  const toLabel = AGENTS[toAgent] || cap(toAgent || "Codex");
  if (provider === "claude" && (!toAgent || toAgent === "codex")) {
    const message = hasReset
      ? t("notify.claudeLimitUntil", { time: formatHHMM(resetsAt) }, l)
      : t("notify.claudeLimit", {}, l);
    return { title: t("notify.codexTookOver", {}, l), message };
  }
  const message = hasReset
    ? t("notify.agentLimitUntil", { from: fromLabel, to: toLabel, time: formatHHMM(resetsAt) }, l)
    : t("notify.agentLimit", { from: fromLabel, to: toLabel }, l);
  return { title: t("notify.agentTookOver", { to: toLabel }, l), message };
}

/** Notify once per provider limit window (persisted in ~/.tokenwise-studio/notified.json). */
export function notifyLimitHandoff({ provider = "claude", toAgent = "codex", resetsAt = null, subtitle = "", repo = "", lang, settings } = {}, deps = {}) {
  const now = typeof deps.now === "function" ? deps.now() : (deps.now ?? Date.now());
  const home = typeof deps.home === "function" ? deps.home() : (deps.home || os.homedir());
  const fsys = deps.fs || fs;
  if (!shouldNotifyLimit(provider, { now, home, fs: fsys })) return false;
  const n = limitHandoffNotice({ provider, toAgent, resetsAt, lang, settings }, { ...deps, now });
  const sent = notify({ ...n, subtitle, repo }, deps);
  if (sent) recordLimitNotified(provider, { resetsAt, now, home, fs: fsys });
  return sent;
}

export function prNotice({ branch, prUrl, compareUrl, lang, settings } = {}, opts = {}) {
  const l = noticeLang({ lang: lang ?? opts.lang, settings: settings ?? opts.settings, env: opts.env, intlLocale: opts.intlLocale });
  if (prUrl) {
    return { title: t("notify.prOpened", {}, l), message: t("notify.prOpenedMsg", { branch, url: prUrl }, l) };
  }
  return {
    title: t("notify.prPushed", {}, l),
    message: compareUrl
      ? t("notify.prOpenedMsg", { branch, url: compareUrl }, l)
      : t("notify.prPushedMsg", { branch }, l),
  };
}
