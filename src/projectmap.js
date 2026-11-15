// Rojo-aware project map for Roblox projects:
// Maps instance paths <-> repo-relative script files using src/studiolog.js, extracts
// lightweight Luau summaries without models (return keys, exported functions, remotes,
// require() edges), caches in .tokenwise-studio/projectmap.json, and slices/caps at 40 KB.
import { execFileSync } from "./process.js";
import fs from "node:fs";
import path from "node:path";
import { collectRojoScripts, findRojoProject } from "./studiolog.js";

export const MAX_MAP_BYTES = 40 * 1024;
export const MAX_WORKER_SLICE_BYTES = 12 * 1024;
export const PROJECT_MAP_FILE = "projectmap.json";

const MAX_ITEMS_PER_FIELD = 40;
const CACHE_VERSION = 1;

function gitState(repo) {
  try {
    const out = execFileSync("git", ["-C", repo, "rev-parse", "HEAD", "HEAD^{tree}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().split(/\r?\n/);
    if (out.length >= 2 && out[0] && out[1]) {
      return { gitHead: out[0].trim(), gitTree: out[1].trim() };
    }
  } catch {}
  return { gitHead: null, gitTree: null };
}

function statFile(absPath) {
  try {
    const st = fs.lstatSync(absPath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function statDir(absPath) {
  try {
    const st = fs.lstatSync(absPath);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    return { mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Strip Luau line (-- ...) and block (--[[ ... ]], --[=[ ... ]=]) comments while preserving strings and newlines. */
export function stripLuauComments(src) {
  const s = String(src || "");
  let out = "";
  let i = 0;
  const n = s.length;

  const matchLongBracket = (idx) => {
    if (s[idx] !== "[") return -1;
    let j = idx + 1;
    while (j < n && s[j] === "=") j++;
    return s[j] === "[" ? j - idx - 1 : -1;
  };

  const scanLongBracketEnd = (startAfterOpen, eqCount) => {
    const close = "]" + "=".repeat(eqCount) + "]";
    const hit = s.indexOf(close, startAfterOpen);
    return hit >= 0 ? hit + close.length : n;
  };

  while (i < n) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < n) {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === q) { j++; break; }
        if (s[j] === "\n") { j++; break; }
        j++;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }

    if (ch === "[") {
      const eq = matchLongBracket(i);
      if (eq >= 0) {
        const end = scanLongBracketEnd(i + eq + 2, eq);
        out += s.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "-" && s[i + 1] === "-") {
      const eq = matchLongBracket(i + 2);
      if (eq >= 0) {
        const end = scanLongBracketEnd(i + 2 + eq + 2, eq);
        out += s.slice(i, end).replace(/[^\n]/g, " ");
        i = end;
        continue;
      }
      const nl = s.indexOf("\n", i + 2);
      i = nl >= 0 ? nl : n;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function pushUnique(arr, val, cap = MAX_ITEMS_PER_FIELD) {
  if (!val || arr.length >= cap || arr.includes(val)) return;
  arr.push(val);
}

/** Find matching closing brace '}' for the '{' at openIdx. Returns index of '}' or -1. */
function findMatchingBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < n && src[i] !== ch && src[i] !== "\n") {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Extract top-level keys (and inline function exports) from a `{ ... }` table literal body. */
function parseTableBody(body, returnKeys, exports) {
  let brace = 0, paren = 0, bracket = 0;
  let i = 0;
  const n = body.length;

  const skipString = (q) => {
    i++;
    while (i < n && body[i] !== q && body[i] !== "\n") {
      if (body[i] === "\\") i += 2;
      else i++;
    }
    i++;
  };

  const atTop = () => brace === 0 && paren === 0 && bracket === 0;
  let expectingKey = true;

  while (i < n) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      skipString(ch);
      continue;
    }
    if (ch === "{") { brace++; expectingKey = false; i++; continue; }
    if (ch === "}") { if (brace > 0) brace--; i++; continue; }
    if (ch === "(") { paren++; expectingKey = false; i++; continue; }
    if (ch === ")") { if (paren > 0) paren--; i++; continue; }
    if (ch === "[" && atTop() && expectingKey) {
      const m = body.slice(i).match(/^\[\s*["']([^"']+)["']\s*\]\s*=(?!=)\s*(function\b)?/);
      if (m) {
        pushUnique(returnKeys, m[1]);
        if (m[2]) pushUnique(exports, m[1]);
        expectingKey = false;
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") { bracket++; i++; continue; }
    if (ch === "]") { if (bracket > 0) bracket--; i++; continue; }

    if (atTop() && (ch === "," || ch === ";")) {
      expectingKey = true;
      i++;
      continue;
    }

    if (atTop() && expectingKey && /[A-Za-z_]/.test(ch)) {
      const m = body.slice(i).match(/^([A-Za-z_]\w*)\s*=(?!=)\s*(function\b)?/);
      if (m) {
        pushUnique(returnKeys, m[1]);
        if (m[2]) pushUnique(exports, m[1]);
        expectingKey = false;
        i += m[0].length;
        continue;
      }
      const id = body.slice(i).match(/^[A-Za-z_]\w*/);
      if (id) {
        expectingKey = false;
        i += id[0].length;
        continue;
      }
    }

    if (atTop() && !/\s/.test(ch)) expectingKey = false;
    i++;
  }
}

function extractReturnAndExports(clean) {
  const returnKeys = [];
  const exports = [];

  // 1. Look for `return <Ident>` at the end / top-level of the module.
  const retIdentMatches = [...clean.matchAll(/(?:^|\n)[ \t]*return[ \t]+([A-Za-z_]\w*)[ \t]*(?:;|\n|$)/g)];
  const retVar = retIdentMatches.length ? retIdentMatches[retIdentMatches.length - 1][1] : null;

  if (retVar) {
    const escaped = retVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tblInitRe = new RegExp(`(?:^|\\n)[ \\t]*(?:local[ \\t]+)?${escaped}[ \\t]*=[ \\t]*\\{`, "g");
    for (const m of clean.matchAll(tblInitRe)) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = findMatchingBrace(clean, openIdx);
      if (closeIdx > openIdx) {
        parseTableBody(clean.slice(openIdx + 1, closeIdx), returnKeys, exports);
      }
    }

    const fnDefRe = new RegExp(`(?:^|\\n)[ \\t]*function[ \\t]+${escaped}([.:])([A-Za-z_]\\w*)\\s*\\(`, "g");
    for (const m of clean.matchAll(fnDefRe)) {
      pushUnique(returnKeys, m[2]);
      pushUnique(exports, m[2]);
    }

    const assignRe = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\.([A-Za-z_]\\w*)\\s*=(?!=)\\s*(function\\b)?`, "g");
    for (const m of clean.matchAll(assignRe)) {
      pushUnique(returnKeys, m[1]);
      if (m[2]) pushUnique(exports, m[1]);
    }

    const bracketAssignRe = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\[\\s*["']([^"']+)["']\\s*\\]\\s*=(?!=)\\s*(function\\b)?`, "g");
    for (const m of clean.matchAll(bracketAssignRe)) {
      pushUnique(returnKeys, m[1]);
      if (m[2]) pushUnique(exports, m[1]);
    }
  } else {
    // 2. Check inline `return { ... }` at top level.
    const inlineRetRe = /(?:^|\n)[ \t]*return[ \t]*\{/g;
    const inlineMatches = [...clean.matchAll(inlineRetRe)];
    if (inlineMatches.length) {
      const last = inlineMatches[inlineMatches.length - 1];
      const openIdx = last.index + last[0].length - 1;
      const closeIdx = findMatchingBrace(clean, openIdx);
      if (closeIdx > openIdx) {
        parseTableBody(clean.slice(openIdx + 1, closeIdx), returnKeys, exports);
      }
    }
  }

  // Non-local top-level `function Foo(...)` exports (when not inside retVar methods already added).
  for (const m of clean.matchAll(/(?:^|\n)function[ \t]+([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)?)\s*\(/g)) {
    const full = m[1];
    if (retVar && (full.startsWith(retVar + ".") || full.startsWith(retVar + ":"))) continue;
    pushUnique(exports, full);
  }

  return { returnKeys, exports };
}

function buildLocalAliases(clean, selfSegments) {
  const aliases = new Map();

  const resolveExpr = (raw) => {
    let expr = String(raw || "").trim();
    if (!expr) return null;
    expr = expr.replace(/\bgame\s*:\s*GetService\s*\(\s*["']([A-Za-z_]\w*)["']\s*\)/g, "$1");
    expr = expr.replace(/\bgame\s*\.\s*([A-Za-z_]\w*)/g, "$1");
    expr = expr.replace(/\s*:\s*(?:WaitForChild|FindFirstChild)\s*\(\s*["']([^"']+)["'](?:\s*,[^)]*)?\s*\)/g, ".$1");
    expr = expr.replace(/\[\s*["']([^"']+)["']\s*\]/g, ".$1");
    expr = expr.replace(/\s*\.\s*/g, ".");
    if (!/^[A-Za-z_][\w.]*$/.test(expr)) return null;

    const parts = expr.split(".");
    let base = [];
    let rest = parts;
    if (parts[0] === "script") {
      base = [...selfSegments];
      rest = parts.slice(1);
    } else if (aliases.has(parts[0])) {
      base = [...aliases.get(parts[0])];
      rest = parts.slice(1);
    }

    const stack = [...base];
    for (const seg of rest) {
      if (seg === "Parent") {
        if (!stack.length) return null;
        stack.pop();
      } else {
        stack.push(seg);
      }
    }
    return stack.length ? stack : null;
  };

  for (const m of clean.matchAll(/(?:^|\n)[ \t]*local[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*([^\n;]+)/g)) {
    const varName = m[1];
    const rhs = m[2].trim();
    if (/^(?:require|Instance\.new|\{|function\b)/.test(rhs)) continue;
    const segs = resolveExpr(rhs);
    if (segs) aliases.set(varName, segs);
  }

  return { aliases, resolveExpr };
}

function extractRequireTargets(clean, { resolveExpr, instanceToFile }) {
  const requires = [];
  const seen = new Set();

  // Match `require(...)` with balanced single-line or simple nested parens (e.g. WaitForChild("X")).
  const re = /\brequire\s*\(/g;
  for (const m of clean.matchAll(re)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < clean.length && depth > 0) {
      const ch = clean[i];
      if (ch === '"' || ch === "'") {
        i++;
        while (i < clean.length && clean[i] !== ch && clean[i] !== "\n") {
          if (clean[i] === "\\") i += 2;
          else i++;
        }
        i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    if (depth !== 0) continue;
    const inner = clean.slice(m.index + m[0].length, i - 1).trim();
    if (!inner) continue;

    const segs = resolveExpr(inner);
    const instPath = segs ? segs.join(".") : null;
    const file = instPath && instanceToFile ? (instanceToFile.get(instPath) || null) : null;
    const key = file || instPath || inner;
    if (seen.has(key)) continue;
    seen.add(key);
    requires.push({
      ...(instPath ? { instancePath: instPath } : { raw: inner.slice(0, 120) }),
      ...(file ? { file } : {}),
    });
    if (requires.length >= MAX_ITEMS_PER_FIELD) break;
  }

  return requires;
}

function extractRemotes(clean, { aliases, instanceToFile, instanceFolders }) {
  const remotes = [];
  const seen = new Set();

  const addRemote = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    remotes.push(name);
  };

  // 1. Instance.new("RemoteEvent"|"RemoteFunction") with .Name = "..."
  const createdVars = [];
  for (const m of clean.matchAll(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=\s*Instance\.new\(\s*["'](RemoteEvent|RemoteFunction)["']/g)) {
    createdVars.push(m[1]);
  }
  for (const varName of createdVars) {
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameRe = new RegExp(`\\b${escaped}\\.Name\\s*=\\s*["']([^"']+)["']`, "g");
    for (const nm of clean.matchAll(nameRe)) addRemote(nm[1]);
  }
  for (const m of clean.matchAll(/Instance\.new\(\s*["'](?:RemoteEvent|RemoteFunction)["'][^)]*\)\.Name\s*=\s*["']([^"']+)["']/g)) {
    addRemote(m[1]);
  }

  // 2. ReplicatedStorage:WaitForChild("X") (including game:GetService("ReplicatedStorage"), chained WaitForChild, or RS aliases),
  //    skipping calls inside `require(...)` and known Rojo script/folder instances.
  const rsAliasNames = [];
  for (const [k, segs] of aliases.entries()) {
    if (segs[0] === "ReplicatedStorage") rsAliasNames.push(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  const rsRootPattern = [
    `game\\s*:\\s*GetService\\s*\\(\\s*["']ReplicatedStorage["']\\s*\\)`,
    `(?:game\\s*\\.)?ReplicatedStorage`,
    ...rsAliasNames.map((a) => `\\b${a}\\b`),
  ].join("|");
  const wfcRe = new RegExp(
    `(?:${rsRootPattern})(?:\\s*\\.\\s*[A-Za-z_]\\w*|\\s*:\\s*(?:WaitForChild|FindFirstChild)\\s*\\(\\s*["'][^"']+["'](?:\\s*,\\s*[^)]*)?\\s*\\))*\\s*:\\s*WaitForChild\\s*\\(\\s*["']([^"']+)["']`,
    "g",
  );

  for (const m of clean.matchAll(wfcRe)) {
    const before = clean.slice(Math.max(0, m.index - 40), m.index);
    if (/\brequire\s*\([^)]*$/.test(before)) continue;
    const remoteName = m[1];
    // Skip if this looks like a known Rojo folder or script under ReplicatedStorage.
    const guessPath = `ReplicatedStorage.${remoteName}`;
    if (instanceToFile?.has(guessPath) || instanceFolders?.has(guessPath)) continue;
    addRemote(remoteName);
    if (remotes.length >= MAX_ITEMS_PER_FIELD) break;
  }

  return remotes;
}

/** Extract lightweight Luau summaries without models: returnKeys, exports, remotes, requires. */
export function extractLuauSummary(source, { instancePath = "", instanceToFile = null, instanceFolders = null } = {}) {
  const clean = stripLuauComments(source);
  const selfSegments = instancePath ? instancePath.split(".").filter(Boolean) : [];
  const { returnKeys, exports } = extractReturnAndExports(clean);
  const { aliases, resolveExpr } = buildLocalAliases(clean, selfSegments);
  const requires = extractRequireTargets(clean, { resolveExpr, instanceToFile });
  const remotes = extractRemotes(clean, { aliases, instanceToFile, instanceFolders });
  return { returnKeys, exports, remotes, requires };
}

function buildProjectMapFresh(repo) {
  const collected = collectRojoScripts(repo);
  if (!collected) return null;

  const { gitHead, gitTree } = gitState(repo);
  const instanceToFile = new Map(collected.scripts.map((s) => [s.instancePath, s.file]));
  const watchedFiles = [];
  const pfStat = statFile(path.join(repo, collected.projectFile));
  if (pfStat) watchedFiles.push({ path: collected.projectFile, ...pfStat });

  const watchedDirs = [];
  for (const d of collected.dirs) {
    const st = statDir(d === "." ? repo : path.join(repo, d));
    if (st) watchedDirs.push({ path: d, ...st });
  }

  const allRemotes = new Set();
  const entries = [];

  for (const s of collected.scripts) {
    const abs = path.join(repo, s.file);
    const st = statFile(abs);
    if (st) watchedFiles.push({ path: s.file, ...st });
    let src = "";
    try {
      src = fs.readFileSync(abs, "utf8");
    } catch {}
    const summary = extractLuauSummary(src, {
      instancePath: s.instancePath,
      instanceToFile,
      instanceFolders: collected.instanceFolders,
    });
    for (const r of summary.remotes) allRemotes.add(r);
    entries.push({
      instancePath: s.instancePath,
      file: s.file,
      scriptType: s.scriptType,
      returnKeys: summary.returnKeys,
      exports: summary.exports,
      remotes: summary.remotes,
      requires: summary.requires,
    });
  }

  const remotes = [...allRemotes].sort();
  const map = {
    projectFile: collected.projectFile,
    gitTree,
    scriptCount: entries.length,
    remoteCount: remotes.length,
    remotes,
    entries,
  };

  const cachePayload = {
    version: CACHE_VERSION,
    projectFile: collected.projectFile,
    gitHead,
    gitTree,
    builtAt: new Date().toISOString(),
    watched: {
      files: watchedFiles,
      dirs: watchedDirs,
    },
    map,
  };

  return { map, cachePayload };
}

function isCacheValid(repo, cached) {
  if (!cached || cached.version !== CACHE_VERSION || !cached.map || !cached.watched) return false;
  const proj = findRojoProject(repo);
  if (!proj || proj.file !== cached.projectFile) return false;

  const { gitHead, gitTree } = gitState(repo);
  if (cached.gitHead !== gitHead || cached.gitTree !== gitTree) return false;

  for (const f of cached.watched.files || []) {
    const st = statFile(path.join(repo, f.path));
    if (!st || st.mtimeMs !== f.mtimeMs || st.size !== f.size) return false;
  }
  for (const d of cached.watched.dirs || []) {
    const st = statDir(d.path === "." ? repo : path.join(repo, d.path));
    if (!st || st.mtimeMs !== d.mtimeMs) return false;
  }
  return true;
}

/**
 * Load (or build and cache in .tokenwise-studio/projectmap.json) the Rojo project map.
 * Returns null if the repo has no default.project.json or *.project.json.
 */
export function getProjectMap(repo, { forceRebuild = false } = {}) {
  if (!repo) return null;
  const absRepo = path.resolve(repo);
  const cachePath = path.join(absRepo, ".tokenwise-studio", PROJECT_MAP_FILE);

  if (!forceRebuild && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (isCacheValid(absRepo, cached)) {
        return cached.map;
      }
    } catch {}
  }

  const built = buildProjectMapFresh(absRepo);
  if (!built) return null;

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(built.cachePayload, null, 2));
  } catch {}
  return built.map;
}

/** Lightweight counts for the orchestrator guide, or null when no Rojo project exists. */
export function getProjectMapSummary(repo) {
  const map = getProjectMap(repo);
  if (!map) return null;
  return {
    projectFile: map.projectFile,
    scriptCount: map.scriptCount,
    remoteCount: map.remoteCount,
    gitTree: map.gitTree,
  };
}

function compactEntry(e, level = 0) {
  if (level >= 2) {
    return {
      instancePath: e.instancePath,
      file: e.file,
      scriptType: e.scriptType,
    };
  }
  const out = {
    instancePath: e.instancePath,
    file: e.file,
    scriptType: e.scriptType,
  };
  const limit = level === 1 ? 5 : MAX_ITEMS_PER_FIELD;
  if (e.returnKeys?.length) out.returnKeys = e.returnKeys.slice(0, limit);
  if (e.exports?.length) out.exports = e.exports.slice(0, limit);
  if (e.remotes?.length) out.remotes = e.remotes.slice(0, limit);
  if (e.requires?.length) {
    out.requires = level === 1
      ? e.requires.slice(0, limit).map((r) => r.file || r.instancePath || r.raw)
      : e.requires.slice(0, limit);
  }
  return out;
}

/** Serialize a project_map response while strictly capping UTF-8 byte length at <= maxBytes (40 KB). */
export function serializeCappedMap(payload, maxBytes = MAX_MAP_BYTES) {
  let text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const entries = payload.entries || [];
  for (const level of [0, 1, 2]) {
    const compacted = { ...payload, entries: entries.map((e) => compactEntry(e, level)) };
    text = JSON.stringify(compacted);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  }

  // Binary search maximum number of minimal entries that fit within maxBytes.
  const baseRemotes = payload.remotes || [];
  let lo = 0, hi = entries.length, bestText = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = {
      ...payload,
      truncated: true,
      omitted: entries.length - mid,
      remotes: baseRemotes.slice(0, 100),
      entries: entries.slice(0, mid).map((e) => compactEntry(e, 2)),
    };
    const candText = JSON.stringify(candidate);
    if (Buffer.byteLength(candText, "utf8") <= maxBytes) {
      bestText = candText;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestText) return bestText;

  return JSON.stringify({
    available: true,
    projectFile: payload.projectFile,
    scriptCount: payload.scriptCount,
    remoteCount: payload.remoteCount,
    truncated: true,
    omitted: entries.length,
    entries: [],
  }).slice(0, maxBytes);
}

/** Query the project map with optional path prefix and/or name filters, capped at 40 KB. */
export function queryProjectMap(repo, { prefix, name } = {}) {
  const map = getProjectMap(repo);
  if (!map) {
    const data = {
      available: false,
      reason: "No Rojo project file (default.project.json or *.project.json) found in this repo.",
    };
    return { data, text: JSON.stringify(data, null, 2) };
  }

  const rawPrefix = typeof prefix === "string" ? prefix.trim().replace(/^\.\//, "").replace(/^game\./, "") : "";
  const normPrefixLower = rawPrefix.toLowerCase();
  const rawName = typeof name === "string" ? name.trim().toLowerCase() : "";

  const entries = map.entries.filter((e) => {
    if (normPrefixLower) {
      const fileLower = e.file.toLowerCase();
      const instLower = e.instancePath.toLowerCase();
      if (!fileLower.startsWith(normPrefixLower) && !instLower.startsWith(normPrefixLower)) {
        return false;
      }
    }
    if (rawName) {
      const hay = [
        e.file,
        e.instancePath,
        ...(e.returnKeys || []),
        ...(e.exports || []),
        ...(e.remotes || []),
        ...(e.requires || []).map((r) => `${r.file || ""} ${r.instancePath || ""} ${r.raw || ""}`),
      ].join("\0").toLowerCase();
      if (!hay.includes(rawName)) return false;
    }
    return true;
  });

  const remotes = rawName
    ? (map.remotes || []).filter((r) => r.toLowerCase().includes(rawName))
    : rawPrefix
      ? [...new Set(entries.flatMap((e) => e.remotes || []))].sort()
      : (map.remotes || []);

  const payload = {
    available: true,
    projectFile: map.projectFile,
    gitTree: map.gitTree,
    scriptCount: map.scriptCount,
    remoteCount: map.remoteCount,
    matchedCount: entries.length,
    remotes,
    entries: entries.map((e) => compactEntry(e, 0)),
  };

  return { data: payload, text: serializeCappedMap(payload, MAX_MAP_BYTES) };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(haystackLower, needleLower) {
  if (!needleLower) return false;
  const re = new RegExp(`(?:^|[^A-Za-z0-9_./\\\\-])${escapeRegExp(needleLower)}(?:$|[^A-Za-z0-9_./\\\\-])`);
  return re.test(haystackLower);
}

/** Find map entries whose file path, instance path, directory prefix, or non-init basename appears in `task`. */
export function matchMapEntriesForTask(map, task) {
  if (!map?.entries?.length || !task) return [];
  const taskLower = String(task).replace(/\\/g, "/").toLowerCase();
  const matched = [];

  // Extract explicit path-like tokens (e.g. `src/server/Main`, `ServerScriptService.Main`) for prefix matching.
  const tokens = new Set();
  for (const m of taskLower.matchAll(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/g)) {
    tokens.add(m[0].replace(/^\.\//, "").replace(/\/+$/, ""));
  }
  for (const m of taskLower.matchAll(/[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+/g)) {
    tokens.add(m[0].replace(/^game\./, ""));
  }

  for (const entry of map.entries) {
    const fileLower = entry.file.toLowerCase();
    const instLower = entry.instancePath.toLowerCase();
    const base = path.posix.basename(fileLower);
    const isInit = base.startsWith("init.");

    let hit = false;
    if (taskLower.includes(fileLower) || taskLower.includes(instLower)) {
      hit = true;
    } else if (!isInit && containsToken(taskLower, base)) {
      hit = true;
    } else {
      for (const tok of tokens) {
        if (fileLower === tok || fileLower.startsWith(tok + "/") || instLower === tok || instLower.startsWith(tok + ".")) {
          hit = true;
          break;
        }
      }
    }
    if (hit) matched.push(entry);
  }
  return matched;
}

/** Repo-relative file paths from the Rojo map mentioned in `task` (used for fix-round file matching too). */
export function extractMentionedProjectFiles(repo, task) {
  const map = getProjectMap(repo);
  if (!map) return [];
  return matchMapEntriesForTask(map, task).map((e) => e.file);
}

/** Format a compact worker-prompt slice for entries matching the task's mentioned paths (<= MAX_WORKER_SLICE_BYTES). */
export function selectProjectMapSlice(map, task, { maxBytes = MAX_WORKER_SLICE_BYTES } = {}) {
  const entries = matchMapEntriesForTask(map, task);
  if (!entries.length) return "";

  const header = `Project map slice (${map.projectFile}, matching files):\n`;
  const lines = [];
  let bytes = Buffer.byteLength(header, "utf8");

  for (const e of entries) {
    const parts = [`- ${e.file} <-> ${e.instancePath} [${e.scriptType}]`];
    if (e.exports?.length) parts.push(`exports: ${e.exports.slice(0, 12).join(", ")}`);
    const extraKeys = (e.returnKeys || []).filter((k) => !(e.exports || []).includes(k));
    if (extraKeys.length) parts.push(`keys: ${extraKeys.slice(0, 12).join(", ")}`);
    if (e.remotes?.length) parts.push(`remotes: ${e.remotes.slice(0, 12).join(", ")}`);
    if (e.requires?.length) {
      parts.push(`requires: ${e.requires.slice(0, 12).map((r) => r.file || r.instancePath || r.raw).join(", ")}`);
    }
    const line = parts.join(" | ");
    const lineBytes = Buffer.byteLength(line + "\n", "utf8");
    if (bytes + lineBytes > maxBytes) {
      if (lines.length === 0) {
        const avail = Math.max(0, maxBytes - bytes - 4);
        lines.push(Buffer.from(line, "utf8").subarray(0, avail).toString("utf8").replace(/\uFFFD+$/, "") + "…");
      }
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }

  return header + lines.join("\n");
}

/** Append the matching Rojo project map slice to a worker's task prompt when applicable. */
export function withProjectMapSlice(task, repo) {
  const map = getProjectMap(repo);
  if (!map) return task;
  const slice = selectProjectMapSlice(map, task);
  if (!slice) return task;
  return `${task}\n\n${slice}`;
}
