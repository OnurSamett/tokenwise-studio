// Version info and update checks. Dependency-free.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PKG_NAME = "tokenwise-studio";
const NPM_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const GITHUB_URL = `https://raw.githubusercontent.com/OnurSamett/${PKG_NAME}/main/package.json`;
const TTL = 24 * 3600 * 1000;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

export const currentVersion = (root = ROOT) => readJson(path.join(root, "package.json"))?.version || "0.0.0";

// "dev" = a git checkout. npm records nothing reliable in a global install's package.json, so look at the
// hidden lockfile (node_modules/.package-lock.json) and legacy _resolved/_from fields. With no evidence at
// all, assume "github" (the way it was first distributed); updating that way is harmless.
export function installSource(root = ROOT) {
  if (fs.existsSync(path.join(root, ".git"))) return "dev";
  const pkg = readJson(path.join(root, "package.json")) || {};
  const refs = [pkg._resolved, pkg._from];
  const lock = readJson(path.join(path.dirname(root), ".package-lock.json"));
  const entry = lock?.packages?.[`node_modules/${PKG_NAME}`];
  if (entry) refs.push(entry.resolved);
  const text = refs.filter(Boolean).join(" ");
  if (/github|git\+|git:\/\//i.test(text)) return "github";
  if (/registry\.|\.tgz/i.test(text) || entry?.integrity) return "npm";
  return "github";
}

const parse = (v) => String(v || "").split("-")[0].split("+")[0].split(".").map((n) => parseInt(n, 10) || 0);
// -1 | 0 | 1; numeric x.y.z, prerelease ignored.
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

const cacheFile = () => path.join(os.homedir(), ".tokenwise-studio", "update.json");

async function fetchVersion(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  const v = (await r.json())?.version;
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+/.test(v)) throw new Error("bad version");
  return v;
}

// Cached read only: { version, source } or null. Never touches the network.
export function cachedLatest({ maxAge = TTL } = {}) {
  const c = readJson(cacheFile());
  if (c && typeof c.version === "string" && Date.now() - (c.checkedAt || 0) < maxAge) return { version: c.version, source: c.source };
  return null;
}

// { version, source: "npm" | "github" } or null. { force } skips the 24h cache.
export async function latestVersion({ force = false } = {}) {
  if (!force) { const c = cachedLatest(); if (c) return c; }
  for (const [source, url] of [["npm", NPM_URL], ["github", GITHUB_URL]]) {
    try {
      const version = await fetchVersion(url);
      try {
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        fs.writeFileSync(cacheFile(), JSON.stringify({ version, source, checkedAt: Date.now() }));
      } catch {}
      return { version, source };
    } catch {}
  }
  return null;
}
