// Local usage & 429 cooldown counters for Gemini / Antigravity (agy has no quota API).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCooldown } from "./cooldowns.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 48 * 60 * 60 * 1000;

const usageFile = () => path.join(os.homedir(), ".tokenwise-studio", "gemini-usage.json");
const num = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0);

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
    return Array.isArray(raw?.events) ? raw.events : [];
  } catch {
    return [];
  }
}

function writeStore(events) {
  try {
    const file = usageFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ events }, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

/** Record one finished or rate-limited Gemini/Antigravity worker run. */
export function recordGeminiRun({ tokens = null, model = null, via = null, rateLimited = false, now = Date.now() } = {}) {
  const t = tokens && typeof tokens === "object"
    ? { input: num(tokens.input), cached: num(tokens.cached), output: num(tokens.output) }
    : { input: 0, cached: 0, output: 0 };
  const total = typeof tokens === "number" ? num(tokens) : t.input + t.output;
  const cutoff = now - RETENTION_MS;
  const events = readStore().filter((e) => e && Number(e.t) >= cutoff);
  events.push({
    t: now,
    tokens: total,
    input: t.input,
    cached: t.cached,
    output: t.output,
    model: model ? String(model) : null,
    via: via ? String(via) : null,
    rateLimited: !!rateLimited,
  });
  writeStore(events);
  return events[events.length - 1];
}

/** Aggregate rolling 5-hour and 24-hour job/token counters plus 429 cooldown state. */
export function geminiUsage(now = Date.now()) {
  const events = readStore();
  const fiveHourCut = now - FIVE_HOURS_MS;
  const dayCut = now - DAY_MS;
  const fiveHour = { jobs: 0, tokens: 0 };
  const day = { jobs: 0, tokens: 0 };
  let cooldowns5h = 0;
  let cooldowns24h = 0;
  let lastAt = 0;

  for (const e of events) {
    const ts = Number(e?.t);
    if (!Number.isFinite(ts) || ts > now + 60_000) continue;
    if (ts >= dayCut) {
      day.jobs++;
      day.tokens += num(e.tokens);
      if (e.rateLimited) cooldowns24h++;
      if (ts > lastAt) lastAt = ts;
    }
    if (ts >= fiveHourCut) {
      fiveHour.jobs++;
      fiveHour.tokens += num(e.tokens);
      if (e.rateLimited) cooldowns5h++;
    }
  }

  const cd = getCooldown("gemini", now);
  return {
    fiveHour,
    day,
    cooldowns5h,
    cooldowns24h,
    cooldown: cd ? { until: cd.until, reason: cd.reason, source: cd.source } : null,
    lastAt: lastAt || null,
    approximate: true,
  };
}
