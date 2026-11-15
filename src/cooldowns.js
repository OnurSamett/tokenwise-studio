// Provider rate-limit cooldowns persisted in ~/.tokenwise-studio/cooldowns.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COOLDOWN_DEFAULT_MS = 30 * 60 * 1000;
const MAX_RESET_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;

const cooldownFile = () => path.join(os.homedir(), ".tokenwise-studio", "cooldowns.json");

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Format an epoch timestamp as local 24-hour HH:MM. */
export function formatHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

/** Convert a wall-clock date/time in an IANA timeZone (or UTC) to epoch ms. */
function zonedTimeToMs({ year, month, day, hour, minute }, timeZone) {
  if (/^(UTC|GMT|Z)$/i.test(timeZone)) {
    return Date.UTC(year, month, day, hour, minute, 0, 0);
  }
  try {
    const guess = Date.UTC(year, month, day, hour, minute, 0, 0);
    const p = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const adjusted = guess + (guess - asUtc);
    // Second pass handles DST boundaries accurately.
    const p2 = zonedParts(adjusted, timeZone);
    const asUtc2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, 0, 0);
    return adjusted + (guess - asUtc2);
  } catch {
    return null;
  }
}

function resolveClockTime({ monthName, dayNum, hour, minute, ampm, tz, now }) {
  if (ampm) {
    const ap = ampm.toLowerCase();
    if (hour < 1 || hour > 12) return null;
    if (ap === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  if (minute < 0 || minute > 59) return null;

  const month = monthName ? MONTHS[monthName.toLowerCase()] : undefined;
  const day = dayNum !== undefined ? Number(dayNum) : undefined;
  if (monthName && month === undefined) return null;
  if (day !== undefined && (day < 1 || day > 31)) return null;

  const zone = tz ? tz.trim() : "";
  if (zone) {
    const nowParts = /^(UTC|GMT|Z)$/i.test(zone)
      ? (() => {
          const d = new Date(now);
          return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        })()
      : (() => {
          try { return zonedParts(now, zone); } catch { return null; }
        })();
    if (nowParts) {
      let y = nowParts.year;
      const m = month !== undefined ? month : nowParts.month - 1;
      const dd = day !== undefined ? day : nowParts.day;
      let ts = zonedTimeToMs({ year: y, month: m, day: dd, hour, minute }, zone);
      if (ts !== null) {
        if (month === undefined && ts <= now) {
          const next = new Date(Date.UTC(y, m, dd + 1));
          ts = zonedTimeToMs({ year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate(), hour, minute }, zone);
        } else if (month !== undefined && ts <= now - 30 * 86400_000) {
          ts = zonedTimeToMs({ year: y + 1, month: m, day: dd, hour, minute }, zone);
        }
        if (ts !== null && ts > now && ts - now <= MAX_RESET_AHEAD_MS) return ts;
      }
    }
  }

  const ref = new Date(now);
  const y = ref.getFullYear();
  const m = month !== undefined ? month : ref.getMonth();
  const dd = day !== undefined ? day : ref.getDate();
  const target = new Date(y, m, dd, hour, minute, 0, 0);
  if (month === undefined && target.getTime() <= now) {
    target.setDate(target.getDate() + 1);
  } else if (month !== undefined && target.getTime() <= now - 30 * 86400_000) {
    target.setFullYear(y + 1);
  }
  const ms = target.getTime();
  return ms > now && ms - now <= MAX_RESET_AHEAD_MS ? ms : null;
}

/**
 * Parse a reset timestamp from CLI/API rate-limit error text.
 * Supports clock times ("resets 5:20am", "resets at 17:20 (UTC)", "resets Nov 16, 5:20am"),
 * relative durations ("resets in 15m", "try again in 2h 30m", "retry after 120s"),
 * ISO timestamps after "resets", and JSON "resets_at" / "resetsAt" fields.
 * Returns epoch ms in the future, or null if none found.
 */
export function parseResetTime(text, now = Date.now()) {
  const s = String(text || "");
  if (!s) return null;
  let last = null;

  // 1. ISO 8601 timestamp following reset/retry wording
  for (const m of s.matchAll(/(?:resets?|retry(?:\s+after)?|until)\s*(?:at|:)?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/gi)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && t > now && t - now <= MAX_RESET_AHEAD_MS) last = t;
  }

  // 2. JSON fields like "resets_at": 1731648000 or "resetsAt": 1731648000000
  for (const m of s.matchAll(/\\?"resets_?[Aa]t\\?"\s*:\s*(\d{10,13})\b/g)) {
    const raw = Number(m[1]);
    const t = raw < 1e12 ? raw * 1000 : raw;
    if (Number.isFinite(t) && t > now && t - now <= MAX_RESET_AHEAD_MS) last = t;
  }

  // 3. Relative durations ("resets in 15m", "try again in 1h 30m", "retry after 120s")
  const relRe = /(?:resets?\s+in|try\s+again\s+in|retry(?:\s+after|\s+in)?\s*:?)\s*(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/gi;
  for (const m of s.matchAll(relRe)) {
    if (!m[1] && !m[2] && !m[3] && !m[4]) continue;
    const ms =
      (Number(m[1] || 0) * 86400 +
        Number(m[2] || 0) * 3600 +
        Number(m[3] || 0) * 60 +
        Number(m[4] || 0)) * 1000;
    if (ms > 0 && ms <= MAX_RESET_AHEAD_MS) last = now + ms;
  }

  // 4. Clock times ("resets 5:20am", "resets at 5:20 pm (UTC)", "resets Nov 16, 5:20am", "resets 17:20")
  const clockRe = /\bresets?\s+(?:at\s+)?(?:([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z0-9_/+:-]+)\))?/gi;
  for (const m of s.matchAll(clockRe)) {
    if (m[4] === undefined && !m[5]) continue; // skip bare integers like "resets in 5m"
    const t = resolveClockTime({
      monthName: m[1],
      dayNum: m[2],
      hour: Number(m[3]),
      minute: m[4] !== undefined ? Number(m[4]) : 0,
      ampm: m[5],
      tz: m[6],
      now,
    });
    if (t !== null) last = t;
  }

  return last;
}

/** Pick the most relevant future resetsAt from a limits(home) reading for `agent`. */
export function limitResetTime(agent, limitsData, now = Date.now()) {
  const plan = limitsData?.[agent];
  if (!plan) return null;
  const fh = plan.fiveHour;
  const wk = plan.week;
  const fhLive = fh && typeof fh.resetsAt === "number" && fh.resetsAt > now ? fh : null;
  const wkLive = wk && typeof wk.resetsAt === "number" && wk.resetsAt > now ? wk : null;
  if (wkLive && (wkLive.pct >= 95 || (wkLive.pct >= 90 && (!fhLive || fhLive.pct < 90)))) return wkLive.resetsAt;
  if (fhLive && (fhLive.pct >= 80 || !wkLive || wkLive.pct < 90)) return fhLive.resetsAt;
  if (fhLive) return fhLive.resetsAt;
  if (wkLive) return wkLive.resetsAt;
  return null;
}

/** Determine cooldown end timestamp + source ("error" | "limits" | "default"). */
export function resolveCooldownUntil(agent, { text = "", limitsData = null, now = Date.now() } = {}) {
  const fromText = parseResetTime(text, now);
  if (fromText) return { until: fromText, source: "error" };
  const fromLimits = limitResetTime(agent, limitsData, now);
  if (fromLimits) return { until: fromLimits, source: "limits" };
  return { until: now + COOLDOWN_DEFAULT_MS, source: "default" };
}

function readMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(cooldownFile(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeMap(map) {
  try {
    const file = cooldownFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

/** Record a cooldown for `agent` in ~/.tokenwise-studio/cooldowns.json. */
export function recordCooldown(agent, { text = "", limitsData = null, reason = "hit a rate limit", now = Date.now(), until = null } = {}) {
  if (!agent) return null;
  const map = readMap();
  for (const [k, v] of Object.entries(map)) {
    if (!v || !(Number(v.until) > now)) delete map[k];
  }
  const resolved = typeof until === "number" && until > now
    ? { until, source: "explicit" }
    : resolveCooldownUntil(agent, { text, limitsData, now });
  const prev = map[agent];
  // Do not shorten a known reset-time cooldown with a generic 30m default.
  const finalUntil = prev && Number(prev.until) > now && resolved.source === "default"
    ? Math.max(Number(prev.until), resolved.until)
    : resolved.until;
  const finalSource = prev && Number(prev.until) > now && resolved.source === "default" && Number(prev.until) > resolved.until
    ? prev.source
    : resolved.source;
  const entry = {
    until: finalUntil,
    recordedAt: now,
    reason: String(reason || "hit a rate limit").slice(0, 120),
    source: finalSource,
  };
  map[agent] = entry;
  writeMap(map);
  return entry;
}

/** Clear an active cooldown for `agent` (e.g. after a successful run). */
export function clearCooldown(agent) {
  if (!agent) return;
  const map = readMap();
  if (!(agent in map)) return;
  delete map[agent];
  writeMap(map);
}

/** Active cooldown entry for `agent`, or null if none / expired. */
export function getCooldown(agent, now = Date.now()) {
  if (!agent) return null;
  const e = readMap()[agent];
  if (!e || !(Number(e.until) > now)) return null;
  return { until: Number(e.until), recordedAt: Number(e.recordedAt) || null, reason: e.reason || "hit a rate limit", source: e.source || "default" };
}

/** True when `agent` currently has an unexpired cooldown. */
export function inCooldown(agent, now = Date.now()) {
  return !!getCooldown(agent, now);
}

/** All unexpired cooldown entries keyed by agent. */
export function activeCooldowns(now = Date.now()) {
  const map = readMap();
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && Number(v.until) > now) {
      out[k] = { until: Number(v.until), recordedAt: Number(v.recordedAt) || null, reason: v.reason || "hit a rate limit", source: v.source || "default" };
    }
  }
  return out;
}
