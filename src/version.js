// Version info and update checks. Dependency-free.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PKG_NAME = "tokenwise-studio";
// Updates come ONLY from validated GitHub release tags. The npm registry name "tokenwise-studio" is not ours:
// never query it and never install from it.
export const REPO = `OnurSamett/${PKG_NAME}`;
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
export const TAG_RE = /^v\d+\.\d+\.\d+$/;
export const SUMS_ASSET = "SHA256SUMS.txt";
const TTL = 24 * 3600 * 1000;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

export const currentVersion = (root = ROOT) => readJson(path.join(root, "package.json"))?.version || "0.0.0";

// "dev" = a git checkout. npm records nothing reliable in a global install's package.json, so look at the
// hidden lockfile (node_modules/.package-lock.json) and legacy _resolved/_from fields. With no evidence at
// all, assume "github" (the way it was first distributed); updating that way is harmless.
export function installSource(root = ROOT) {
  if (fs.existsSync(path.join(root, ".bundled"))) return fs.readFileSync(path.join(root, ".bundled"), "utf8").trim() === "windows" ? "windows" : "dmg";
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

// npm arguments that install a release: always the GitHub repository pinned to its verified commit SHA.
export function installArgs(tag, commit) {
  if (typeof tag !== "string" || !TAG_RE.test(tag) || typeof commit !== "string" || !HEX40.test(commit)) throw new Error("refusing to install: not a validated release tag and commit");
  return ["install", "-g", "--ignore-scripts", `github:${REPO}#${commit.toLowerCase()}`];
}

export const cacheFile = () => path.join(os.homedir(), ".tokenwise-studio", "update.json");

const HEX40 = /^[0-9a-f]{40}$/i;

async function getJson(fetchFn, url, timeoutMs) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/vnd.github+json", "user-agent": "tokenwise-studio-update-check" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/**
 * Latest GitHub release, verified: a published (non-draft, non-prerelease) release whose tag is exactly vX.Y.Z,
 * that ships SHA256SUMS.txt, whose tag commit matches (or is contained in) the release target, and whose
 * package.json at that tag carries the same version. Throws on any mismatch. `fetchFn` is injectable for tests.
 * Returns { version, tag, commit, source: "github" }.
 */
export async function verifyLatestRelease(fetchFn = fetch, { timeoutMs = 4000 } = {}) {
  const rel = await getJson(fetchFn, `${API}/releases/latest`, timeoutMs);
  const tag = rel?.tag_name;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) throw new Error("release tag is not vX.Y.Z");
  if (rel.draft || rel.prerelease) throw new Error("release is a draft or prerelease");
  if (!Array.isArray(rel.assets) || !rel.assets.some((a) => a?.name === SUMS_ASSET)) throw new Error(`release has no ${SUMS_ASSET}`);
  const version = tag.slice(1);
  const ref = await getJson(fetchFn, `${API}/git/ref/tags/${tag}`, timeoutMs);
  let obj = ref?.object;
  if (obj?.type === "tag") obj = (await getJson(fetchFn, `${API}/git/tags/${obj.sha}`, timeoutMs))?.object;
  const commit = obj?.type === "commit" && HEX40.test(obj.sha || "") ? obj.sha.toLowerCase() : null;
  if (!commit) throw new Error("tag does not point at a commit");
  const target = rel.target_commitish;
  if (typeof target === "string" && HEX40.test(target)) {
    if (target.toLowerCase() !== commit) throw new Error("tag commit differs from the release target");
  } else if (typeof target === "string" && /^[\w./-]{1,100}$/.test(target)) {
    const cmp = await getJson(fetchFn, `${API}/compare/${commit}...${encodeURIComponent(target)}`, timeoutMs);
    if (cmp?.status !== "identical" && cmp?.status !== "ahead") throw new Error("tag commit is not part of the release target");
  } else throw new Error("release has no usable target");
  const pj = await (async () => {
    const r = await fetchFn(`${RAW}/${commit}/package.json`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  })();
  if (pj?.version !== version) throw new Error("package.json version does not match the tag");
  return { version, tag, commit, source: "github" };
}

// Cached read only: { version, tag, commit, source } or null. Never touches the network.
export function cachedLatest({ maxAge = TTL } = {}) {
  const c = readJson(cacheFile());
  if (c && c.source === "github" && typeof c.tag === "string" && TAG_RE.test(c.tag) && c.version === c.tag.slice(1) && typeof c.commit === "string" && HEX40.test(c.commit) && Date.now() - (c.checkedAt || 0) < maxAge) {
    return { version: c.version, tag: c.tag, commit: c.commit.toLowerCase(), source: "github" };
  }
  return null;
}

// { version, tag, commit, source: "github" } or null. { force } skips the 24h cache.
export async function latestVersion({ force = false, fetchFn } = {}) {
  if (!force) { const c = cachedLatest(); if (c) return c; }
  try {
    const r = await verifyLatestRelease(fetchFn);
    try {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      // Keep other keys in this file (auto-update state lives here too).
      const old = readJson(cacheFile()) || {};
      fs.writeFileSync(cacheFile(), JSON.stringify({ ...old, version: r.version, tag: r.tag, commit: r.commit, source: "github", checkedAt: Date.now() }, null, 2));
    } catch {}
    return { version: r.version, tag: r.tag, commit: r.commit, source: "github" };
  } catch { return null; }
}
