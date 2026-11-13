// Google Antigravity CLI ("agy"): the way to run Gemini with a personal Google account now that
// Gemini CLI's Google sign-in no longer works for individuals. Ships inside Gemini.app on macOS.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const CANDIDATES = [
  process.env.TOKENWISE_AGY,
  "/Applications/Gemini.app/Contents/Helpers/agy",
  "/Applications/Antigravity.app/Contents/Helpers/agy",
].filter(Boolean);

let agyPath;
export function findAgy() {
  if (agyPath !== undefined) return agyPath;
  agyPath = CANDIDATES.find((p) => fs.existsSync(p)) || null;
  if (!agyPath) {
    const r = spawnSync("sh", ["-c", "command -v agy"], { encoding: "utf8", timeout: 3000 });
    agyPath = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }
  return agyPath;
}

let models = null, modelsAt = 0;
/** Model ids available to the signed-in account, or null when agy is missing / not signed in. */
export function agyModels() {
  const agy = findAgy(); if (!agy) return null;
  if (models && Date.now() - modelsAt < 5 * 60000) return models;
  try {
    const out = execFileSync(agy, ["models"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    models = out.split("\n").map((l) => l.split("\t")[0].trim()).filter((id) => /^[\w.-]+$/.test(id) && id.includes("-"));
    modelsAt = Date.now();
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
