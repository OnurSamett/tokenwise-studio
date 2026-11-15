// Locate the native macOS tokenwise studio.app bundle by bundle identifier,
// independent of where the user moved it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BUNDLE_ID = "com.nolienlabs.tokenwise-studio";
export const APP_NAME = "tokenwise studio.app";
export const EXE = "tokenwise-studio";
export const MDFIND_QUERY = `kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`;

const MDFIND_MISS_TTL_MS = 60_000;
const mdfindCache = new Map();

export const defaultAppPath = (home = os.homedir()) => path.join(home, "Applications", APP_NAME);
export const appJsonPath = (home = os.homedir()) => path.join(home, ".tokenwise-studio", "app.json");

/** Clear the cached mdfind lookup result (used by tests). */
export function clearAppCache() {
  mdfindCache.clear();
}

/** Verify a bundle's Info.plist matches our bundle id and (optionally) its binary is executable. */
export function verifyAppBundle(bundlePath, { fs: fsys = fs, requireExecutable = true } = {}) {
  if (!bundlePath || typeof bundlePath !== "string") return null;
  try {
    const plist = fsys.readFileSync(path.join(bundlePath, "Contents", "Info.plist"), "utf8");
    if (!plist.includes(`<string>${BUNDLE_ID}</string>`)) return null;
    const binaryPath = path.join(bundlePath, "Contents", "MacOS", EXE);
    if (requireExecutable) {
      const xOk = fsys.constants?.X_OK ?? fs.constants.X_OK;
      fsys.accessSync(binaryPath, xOk);
    }
    return { appPath: bundlePath, binaryPath };
  } catch {
    return null;
  }
}

function queryMdfind(runExec) {
  try {
    const out = runExec("mdfind", [MDFIND_QUERY], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(out || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.includes("/.Trash/"));
  } catch {
    return [];
  }
}

function mdfindLookup({ exec: runExec, home, fs: fsys, requireExecutable, now, cache }) {
  if (cache) {
    const entry = mdfindCache.get(home);
    if (entry && entry.fs === fsys && entry.exec === runExec && entry.requireExecutable === requireExecutable) {
      if (entry.path) {
        const verified = verifyAppBundle(entry.path, { fs: fsys, requireExecutable });
        if (verified) return { ...verified, source: "mdfind" };
      } else if (now() - entry.ts < MDFIND_MISS_TTL_MS) {
        return null;
      }
    }
  }
  const candidates = queryMdfind(runExec);
  let found = null;
  for (const candidate of candidates) {
    const verified = verifyAppBundle(candidate, { fs: fsys, requireExecutable });
    if (verified) {
      found = verified;
      break;
    }
  }
  if (cache) {
    mdfindCache.set(home, { path: found ? found.appPath : null, ts: now(), fs: fsys, exec: runExec, requireExecutable });
  }
  return found ? { ...found, source: "mdfind" } : null;
}

/**
 * Locate tokenwise studio.app anywhere on macOS:
 *  (a) ~/.tokenwise-studio/app.json (written by the Swift app on launch)
 *  (b) mdfind by CFBundleIdentifier (execFileSync arg array, cached)
 *  (c) ~/Applications/tokenwise studio.app
 */
export function findAppBundle(deps = {}) {
  if (deps.platform && deps.platform !== "darwin") return null;
  const home = typeof deps.home === "function" ? deps.home() : (deps.home || os.homedir());
  const fsys = deps.fs || fs;
  const requireExecutable = deps.requireExecutable !== false;
  const runExec = deps.exec || deps.execFileSync || execFileSync;
  const now = deps.now || (() => Date.now());
  const cache = deps.cache !== false;

  // (a) app.json written at launch by TokenwiseStudio.swift
  try {
    const raw = JSON.parse(fsys.readFileSync(appJsonPath(home), "utf8"));
    const recorded = raw && (raw.bundlePath || raw.path);
    const verified = verifyAppBundle(recorded, { fs: fsys, requireExecutable });
    if (verified) return { ...verified, source: "app.json" };
  } catch {}

  // (b) Spotlight mdfind (cached)
  const viaMdfind = mdfindLookup({ exec: runExec, home, fs: fsys, requireExecutable, now, cache });
  if (viaMdfind) return viaMdfind;

  // (c) Fallback to ~/Applications/tokenwise studio.app
  const def = verifyAppBundle(defaultAppPath(home), { fs: fsys, requireExecutable });
  if (def) return { ...def, source: "applications" };

  return null;
}

/** Find all unique owned tokenwise studio.app bundles (moved or default), for uninstall. */
export function findOwnedAppBundles(deps = {}) {
  const home = typeof deps.home === "function" ? deps.home() : (deps.home || os.homedir());
  const fsys = deps.fs || fs;
  const runExec = deps.exec || deps.execFileSync || execFileSync;
  const candidates = [];

  try {
    const raw = JSON.parse(fsys.readFileSync(appJsonPath(home), "utf8"));
    if (raw && (raw.bundlePath || raw.path)) candidates.push(raw.bundlePath || raw.path);
  } catch {}
  candidates.push(...queryMdfind(runExec));
  candidates.push(defaultAppPath(home));

  const seen = new Set();
  const owned = [];
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const verified = verifyAppBundle(p, { fs: fsys, requireExecutable: false });
    if (verified) owned.push(verified.appPath);
  }
  return owned;
}
