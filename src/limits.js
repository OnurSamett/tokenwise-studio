// Plan usage limits, read from data the CLIs already produce (no extra API calls):
// - Claude Code: `rate_limit_event` lines in stream-json output (our chat + worker logs).
// - Codex CLI:   `rate_limits` in its session rollouts under ~/.codex/sessions.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { activeCooldowns } from "./cooldowns.js";
import { geminiUsage } from "./gemini-usage.js";

const win = (pct, resetsAt) => (pct == null ? null : { pct: Math.round(pct), resetsAt: resetsAt ? resetsAt * 1000 : null });

function lastLine(files, needle) {
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const i = text.lastIndexOf(needle);
    if (i < 0) continue;
    const start = text.lastIndexOf("\n", i) + 1;
    const end = text.indexOf("\n", i);
    return { line: text.slice(start, end < 0 ? undefined : end), mtime: fs.statSync(f).mtimeMs };
  }
  return null;
}

/** Return the balanced {...} JSON object that follows `key` in `text`. */
function objectAfter(text, key) {
  const i = text.lastIndexOf(key); if (i < 0) return null;
  let depth = 0, inStr = false;
  for (let j = i + key.length; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(i + key.length, j + 1);
  }
  return null;
}

const newest = (dir, filter) => {
  try {
    return fs.readdirSync(dir).filter(filter).map((f) => path.join(dir, f))
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.f);
  } catch { return []; }
};

function claudeLimits(home) {
  const files = [...newest(path.join(home, "chats"), (f) => f.endsWith(".jsonl")), ...newest(path.join(home, "logs"), (f) => f.endsWith(".jsonl"))]
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 12).map((x) => x.f);
  const hit = lastLine(files, '\\"type\\":\\"rate_limit_event\\"');
  if (!hit) return null;
  try {
    const info = JSON.parse(JSON.parse(hit.line).line).rate_limit_info || {};
    const w = info.unifiedWindows || {};
    return {
      fiveHour: win(w.five_hour?.utilization != null ? w.five_hour.utilization * 100 : null, w.five_hour?.resetsAt),
      week: win(w.seven_day?.utilization != null ? w.seven_day.utilization * 100 : null, w.seven_day?.resetsAt),
      status: info.status, updated: hit.mtime,
    };
  } catch { return null; }
}

function codexLimits() {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  // Walk the newest year/month/day folders and collect the most recent rollout files.
  const files = [];
  for (const y of newest(root, () => true)) for (const m of newest(y, () => true)) for (const d of newest(m, () => true)) {
    files.push(...newest(d, (f) => f.endsWith(".jsonl")));
    if (files.length >= 8) break;
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const hit = lastLine(files.slice(0, 8), '"rate_limits":{');
  if (!hit) return null;
  try {
    const rl = JSON.parse(objectAfter(hit.line, '"rate_limits":') || "{}");
    return { fiveHour: win(rl.primary?.used_percent, rl.primary?.resets_at), week: win(rl.secondary?.used_percent, rl.secondary?.resets_at), updated: hit.mtime };
  } catch { return null; }
}

export function limits(home) {
  const g = geminiUsage();
  const hasGemini = g.day.jobs > 0 || g.cooldowns24h > 0 || !!g.cooldown;
  return {
    claude: claudeLimits(home),
    codex: codexLimits(),
    gemini: hasGemini ? g : null,
    cooldowns: activeCooldowns(),
  };
}
