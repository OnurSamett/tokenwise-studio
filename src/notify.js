// Desktop notifications: native Mac app, or a queue delivered to the browser Notification API. Never throws.
// All processes share one ledger (dedupe, batching, rate limit, levels, focus) and an in-app notification center.
import { execFile } from "./process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings, NOTIFY_LEVELS } from "./settings.js";
import { t, tp, resolveLanguage, translateReason } from "../ui/i18n.js";
import { formatHHMM } from "./cooldowns.js";
import { BUNDLE_ID, findAppBundle } from "./appbundle.js";

export { loadSettings, saveSettings };

export const LIMIT_UNKNOWN_WINDOW_MS = 5 * 60 * 60 * 1000;

const noticeLang = (opts = {}) => resolveLanguage(opts.lang ?? (opts.settings || loadSettings()).language, opts);

const trunc = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// ---- calmer notifications: one ledger shared by every studio process ----
// Every server (one UI server per project, plus the MCP servers that Claude Code, Codex, Gemini and
// orchestrator turns spawn) used to post its own alert the moment something finished, with only an
// in-memory dedupe. Now every event goes through ~/.tokenwise-studio/notify-ledger.json:
//  - an event key is accepted once across all processes;
//  - events for one project within COALESCE_MS become ONE summary notification;
//  - delivery is rate limited (token bucket: 1 per RATE_INTERVAL_MS, burst RATE_BURST);
//  - a level filter (important / all / off) and focus-aware Do Not Disturb decide what reaches the desktop;
//  - every event, delivered or not, lands in the in-app notification center (the bell list).

export const COALESCE_MS = 20_000;
export const RATE_INTERVAL_MS = 20_000;
export const RATE_BURST = 3;
export const MCP_MIN_MS = 2 * 60_000; // jobs an MCP client (Claude Code, Codex, Gemini) started: it reports them itself
export const TURN_MIN_MS = 60_000; // "important only": turns shorter than this stay in the app
export const FOCUS_STALE_MS = 3 * 60_000; // a "focused" report older than this means the window went away
export { NOTIFY_LEVELS };
const CENTER_MAX = 100, BROWSER_MAX = 40, SENT_TTL_MS = 24 * 3600 * 1000, LOCK_STALE_MS = 5000, GROUP_MAX = 50;

const seen = new Set(); // fast in-process dedupe; the ledger is the cross-process one
let loggedMissingApp = false;
let flushTimer = null, flushAt = 0;

export function resetNotifyState() {
  seen.clear();
  loggedMissingApp = false;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null; flushAt = 0;
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

const nowOf = (deps = {}) => (typeof deps.now === "function" ? deps.now() : (deps.now ?? Date.now()));
const homeOf = (deps = {}) => (typeof deps.home === "function" ? deps.home() : (deps.home || os.homedir()));

export const ledgerFile = (home = os.homedir()) => path.join(home, ".tokenwise-studio", "notify-ledger.json");

const emptyLedger = () => ({ v: 1, seq: 0, sent: {}, pending: {}, rate: { tokens: RATE_BURST, at: 0 }, focus: {}, center: [], browser: [] });

function readLedger(file, fsys = fs) {
  try {
    const raw = JSON.parse(fsys.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const L = { ...emptyLedger(), ...raw };
      for (const k of ["sent", "pending", "focus"]) if (!L[k] || typeof L[k] !== "object" || Array.isArray(L[k])) L[k] = {};
      for (const k of ["center", "browser"]) if (!Array.isArray(L[k])) L[k] = [];
      if (!L.rate || typeof L.rate !== "object") L.rate = { tokens: RATE_BURST, at: 0 };
      return L;
    }
  } catch {}
  return emptyLedger();
}

/** Read-only snapshot of the ledger (no lock). */
export const loadLedger = (deps = {}) => readLedger(ledgerFile(homeOf(deps)), deps.fs || fs);

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

/** Run fn(ledger) under a cross-process lock (an atomic mkdir), then write the ledger back atomically (tmp + rename). */
export function withLedger(fn, deps = {}) {
  const fsys = deps.fs || fs;
  const file = ledgerFile(homeOf(deps));
  const lock = `${file}.lock`;
  try { fsys.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  let locked = false;
  for (let i = 0; i < 200 && !locked; i++) {
    try { fsys.mkdirSync(lock); locked = true; } catch (e) {
      if (e?.code !== "EEXIST") break;
      try { if (Date.now() - fsys.statSync(lock).mtimeMs > LOCK_STALE_MS) { fsys.rmdirSync(lock); continue; } } catch {}
      sleepSync(5);
    }
  }
  try {
    const L = readLedger(file, fsys);
    const out = fn(L);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fsys.writeFileSync(tmp, JSON.stringify(L));
    fsys.renameSync(tmp, file);
    return out;
  } finally {
    if (locked) { try { fsys.rmdirSync(lock); } catch {} }
  }
}

function prune(L, now) {
  for (const [k, at] of Object.entries(L.sent)) if (!(now - at < SENT_TTL_MS)) delete L.sent[k];
  if (L.center.length > CENTER_MAX) L.center.length = CENTER_MAX;
  if (L.browser.length > BROWSER_MAX) L.browser.splice(0, L.browser.length - BROWSER_MAX);
}

/** Effective level: "off" when notifications are turned off (setting or TOKENWISE_NOTIFY=0). */
export function notifyLevel(settings = {}) {
  if (process.env.TOKENWISE_NOTIFY === "0" || settings.notifications === false) return "off";
  return NOTIFY_LEVELS.includes(settings.notifyLevel) ? settings.notifyLevel : "important";
}

/** Whether an event passes the "Important only" level. Events without a kind (older callers) count as important. */
export function isImportant(ev = {}) {
  switch (ev.kind) {
    case "review": case "jobFailed": case "turnFailed": case "limit": return true;
    case "turn": return ev.readyJobs > 0 || !(Number(ev.durationMs) < TURN_MIN_MS);
    case "jobDone": case "pr": return false;
    default: return true;
  }
}

/** "focused" | "away" | "unknown" for a project's window, from what its UI last reported. */
export function focusState(L, repo, now = Date.now()) {
  const f = repo ? L?.focus?.[repo] : null;
  if (!f || typeof f !== "object") return "unknown";
  if (!f.focused) return "away";
  return now - Number(f.at || 0) > FOCUS_STALE_MS ? "away" : "focused";
}

/** Why an event should stay out of the desktop (before focus), or "" to queue it. */
export function suppressReason(ev = {}, settings = {}) {
  if (ev.origin === "orchestrator") return "orchestrator"; // the turn's own summary covers it
  if (ev.origin === "mcp" && !(Number(ev.durationMs) > MCP_MIN_MS)) return "mcp"; // the MCP client shows it already
  const level = notifyLevel(settings);
  if (level === "off") return "off";
  if (level === "important" && !isImportant(ev)) return "level";
  return "";
}

/** The UI of a project reports whether its window is visible and focused (POST /api/focus). */
export function reportFocus(repo, focused, deps = {}) {
  if (!repo) return false;
  try {
    const now = nowOf(deps);
    withLedger((L) => { L.focus[repo] = { focused: !!focused, at: now }; }, deps);
    return true;
  } catch { return false; }
}

/** The in-app notification center for a project (newest first) plus its unread count. */
export function noticeCenter(repo, deps = {}) {
  try {
    const items = loadLedger(deps).center.filter((n) => !repo || !n.repo || n.repo === repo).slice(0, deps.limit || 50)
      .map(({ key, ...n }) => n);
    return { items, unread: items.filter((n) => !n.read).length };
  } catch { return { items: [], unread: 0 }; }
}

export function markNoticesRead(repo, deps = {}) {
  try {
    withLedger((L) => { for (const n of L.center) if (!repo || !n.repo || n.repo === repo) n.read = true; }, deps);
    return true;
  } catch { return false; }
}

/** Summaries delivered to the browser on non-Mac platforms (shared by every process through the ledger). */
export const pendingBrowserNotices = (repo, deps = {}) => {
  try { return loadLedger(deps).browser.filter((n) => !repo || !n.repo || n.repo === repo); } catch { return []; }
};

const BATCH_KEYS = { review: "notify.batchReview", jobDone: "notify.batchDone", jobFailed: "notify.batchFailed", turn: "notify.batchTurns" };

/** One notification for a group of events of one project. */
export function summarizeGroup(group, opts = {}) {
  const evs = group?.events || [];
  const project = group?.repo ? path.basename(group.repo) : "tokenwise studio";
  if (evs.length === 1) {
    const e = evs[0];
    return { title: e.title, message: e.message, subtitle: e.subtitle || (group.repo ? project : "") };
  }
  const l = noticeLang(opts);
  const n = evs.length, kinds = new Set(evs.map((e) => e.kind));
  const failed = evs.filter((e) => e.kind === "jobFailed" || e.kind === "turnFailed").length;
  const only = kinds.size === 1 ? [...kinds][0] : null;
  const title = only && BATCH_KEYS[only] ? tp(BATCH_KEYS[only], n, { project }, l) : tp("notify.batchUpdates", n, { project }, l);
  const prefix = failed && only !== "jobFailed" ? tp("notify.batchFailedPrefix", failed, {}, l) : "";
  const message = trunc(prefix + evs.map((e) => e.message || e.title).filter(Boolean).join(" · "), 180);
  return { title: trunc(title, 60), message, subtitle: "" };
}

function scheduleFlush(ms, deps = {}) {
  if (deps.schedule === false) return;
  const at = Date.now() + Math.max(0, ms);
  if (flushTimer && flushAt <= at) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushAt = at;
  flushTimer = setTimeout(() => { flushTimer = null; flushAt = 0; flushNotifications(deps); }, Math.max(0, ms) + 50);
  flushTimer.unref?.();
}

function deliver(n, deps = {}) {
  const bin = deps.native !== undefined ? deps.native : nativeNotifier({ ...deps, exec: deps.execFileSync });
  if (!bin) return false;
  const run = deps.exec || execFile;
  const args = ["--notify", "--title", trunc(n.title || "tokenwise studio", 60), "--message", trunc(n.message, 180)];
  if (n.subtitle) args.push("--subtitle", trunc(n.subtitle, 60));
  if (n.repo) args.push("--repo", String(n.repo));
  run(bin, args, { timeout: 10000 }, () => {});
  return true;
}

/**
 * Queue a notification event. ev: { title, message, subtitle, key, repo, chat, kind, durationMs, readyJobs, origin }.
 * kind: review | jobDone | jobFailed | turn | turnFailed | limit | pr; origin: app (default) | mcp | orchestrator.
 * deps (tests): { settings, platform, native, exec, execFileSync, fs, home, now, log, schedule }.
 * Returns true when the event was queued for the desktop (delivered after the coalescing window), false otherwise.
 * Never throws.
 */
export function notify(ev = {}, deps = {}) {
  try {
    const { key } = ev;
    // Routine model handoffs already appear in the chat.
    if (typeof key === "string" && key.startsWith("handoff:")) return false;
    if (key && seen.has(key)) return false;
    const settings = deps.settings || loadSettings();
    const now = nowOf(deps);
    let reason = suppressReason(ev, settings);
    if (reason === "orchestrator") return false;
    if (!reason && (deps.platform || process.platform) === "darwin") {
      const bin = deps.native !== undefined ? deps.native : nativeNotifier({ ...deps, exec: deps.execFileSync });
      if (!bin) {
        if (!loggedMissingApp) {
          loggedMissingApp = true;
          (deps.log || console.warn)("tokenwise studio: native app not found; skipping desktop notifications");
        }
        reason = "noapp";
      }
    }
    const entry = {
      kind: ev.kind || "other", title: trunc(ev.title || "tokenwise studio", 60), message: trunc(ev.message, 180),
      subtitle: trunc(ev.subtitle, 60), repo: ev.repo ? String(ev.repo) : "", chat: ev.chat ? String(ev.chat) : "",
    };
    const queued = withLedger((L) => {
      prune(L, now);
      if (key && L.sent[key]) return null;
      if (key) L.sent[key] = now;
      if (!reason && settings.notifyFocusDnd !== false) {
        const st = focusState(L, entry.repo, now);
        // Unknown focus: an in-app event happened while a studio window may be open, so stay quiet.
        if (st === "focused" || (st === "unknown" && ev.origin !== "mcp")) reason = "focused";
      }
      const id = ++L.seq;
      L.center.unshift({ id, at: now, ...entry, key: key || "", status: reason || "pending", read: false });
      if (reason) return false;
      const g = entry.repo || "global";
      const grp = L.pending[g] ||= { repo: entry.repo, dueAt: now + COALESCE_MS, events: [] };
      if (grp.events.length < GROUP_MAX) grp.events.push({ id, kind: entry.kind, title: entry.title, message: entry.message, subtitle: entry.subtitle });
      return true;
    }, deps);
    if (key) seen.add(key);
    if (queued) scheduleFlush(COALESCE_MS, deps);
    return queued === true;
  } catch { return false; }
}

/** Deliver every due group (one summary each) within the rate limit. Any process may flush; each group is sent once. */
export function flushNotifications(deps = {}) {
  try {
    const now = nowOf(deps);
    const settings = deps.settings || loadSettings();
    const mac = (deps.platform || process.platform) === "darwin";
    const out = [];
    let next = null;
    const later = (t) => { next = next === null ? t : Math.min(next, t); };
    withLedger((L) => {
      const r = L.rate;
      r.tokens = Math.min(RATE_BURST, (Number.isFinite(r.tokens) ? r.tokens : RATE_BURST) + Math.max(0, now - (Number(r.at) || 0)) / RATE_INTERVAL_MS);
      r.at = now;
      const mark = (grp, status) => { const ids = new Set(grp.events.map((e) => e.id)); for (const n of L.center) if (ids.has(n.id)) n.status = status; };
      for (const [g, grp] of Object.entries(L.pending).sort((a, b) => a[1].dueAt - b[1].dueAt)) {
        if (!grp || !Array.isArray(grp.events) || !grp.events.length) { delete L.pending[g]; continue; }
        if (grp.dueAt > now) { later(grp.dueAt); continue; }
        // The user turned notifications off, or came back to this project's window meanwhile.
        if (notifyLevel(settings) === "off") { mark(grp, "off"); delete L.pending[g]; continue; }
        if (settings.notifyFocusDnd !== false && focusState(L, grp.repo, now) === "focused") { mark(grp, "focused"); delete L.pending[g]; continue; }
        if (r.tokens < 1) { later(now + Math.ceil((1 - r.tokens) * RATE_INTERVAL_MS)); continue; } // keeps collecting
        r.tokens -= 1;
        const n = { ...summarizeGroup(grp, { settings }), repo: grp.repo, count: grp.events.length };
        mark(grp, "sent");
        delete L.pending[g];
        if (!mac) L.browser.push({ id: ++L.seq, ...n, at: now });
        out.push(n);
      }
      prune(L, now);
    }, deps);
    if (mac) for (const n of out) deliver(n, deps);
    if (next !== null) scheduleFlush(next - now, deps);
    return out;
  } catch { return []; }
}

/** Long-running servers flush groups left behind by processes that exited before their timer fired. */
export function startNotifyPump(deps = {}, everyMs = 10_000) {
  const timer = setInterval(() => {
    try { if (Object.keys(loadLedger(deps).pending).length) flushNotifications(deps); } catch {}
  }, everyMs);
  timer.unref?.();
  return timer;
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
  if (j.status === "failed") return { kind: "jobFailed", title: t("notify.workerFailed", {}, lang), message: `${who}: ${title}` };
  if (j.status !== "done") return null; // moved, discarded, running
  if (j.write) {
    if (!j.diffStat || j.diffStat === "(no changes)" || j.diffStat.startsWith("diff failed") || fileCount === 0) {
      return { kind: "jobDone", title: t("notify.workerFinished", {}, lang), message: `${who}: ${title}` };
    }
    const files = typeof fileCount === "number" ? ` · ${tp("notify.filesChanged", fileCount, {}, lang)}` : "";
    return { kind: "review", title: t("notify.readyForReview", {}, lang), message: t("notify.workerFinishedMsg", { who, title, files }, lang) };
  }
  return { kind: "jobDone", title: t("notify.workerFinished", {}, lang), message: `${who}: ${title}` };
}

/** What to say when an orchestrator turn ends; null if the user stopped it. */
export function turnNotice({ turn, chatTitle, failed, stopped, readyJobs = 0, lang, settings } = {}, opts = {}) {
  if (stopped) return null;
  const l = noticeLang({ lang: lang ?? opts.lang, settings: settings ?? opts.settings, env: opts.env, intlLocale: opts.intlLocale });
  const first = String(turn?.reply || "").split("\n").map((line) => line.trim()).find(Boolean) || t("notify.turnComplete", {}, l);
  const prefix = readyJobs > 0 ? tp("notify.jobsReady", readyJobs, {}, l) : "";
  return { kind: failed ? "turnFailed" : "turn", readyJobs, title: t(failed ? "notify.orchNeedsYou" : "notify.orchFinished", {}, l), message: trunc(prefix + trunc(first, 150), 180), subtitle: chatTitle || "" };
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
  const sent = notify({ ...n, subtitle, repo, kind: "limit", key: `limit:${provider}:${now}` }, deps);
  // Once per provider per window, even when the alert stayed in the app (focus, level): it is in the bell list.
  recordLimitNotified(provider, { resetsAt, now, home, fs: fsys });
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
