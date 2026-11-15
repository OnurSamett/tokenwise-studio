// Roblox Studio Output parser and Rojo project path resolver.
// Dependency-free, offline-only: parses Studio error lines + Stack Begin/End traces,
// ignores warnings/prints/non-Output text, deduplicates repeats, and resolves instance
// paths against default.project.json or *.project.json at the repo root.
import fs from "node:fs";
import path from "node:path";

export const MAX_LOG_BYTES = 20 * 1024;

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const TIMESTAMP_PREFIX_RE = /^(?:\[\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?\]|\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?)\s+/;
const STUDIO_ORIGIN_SUFFIX_RE = /\s{2,}-\s+(?:Server|Client|Studio|Edit)(?:\s+-\s+.+)?$|\s+-\s+(?:Server|Client|Studio|Edit)(?:\s+-\s+[^\s:][^:]*:\d+)?$/;
const ERROR_PREFIX_RE = /^(?:\[Error\]|Error:)\s+/;

const STACK_BEGIN_RE = /^Stack Begin$/i;
const STACK_END_RE = /^Stack End$/i;
const STACK_FRAME_RE = /^(Script|LocalScript|ModuleScript|CoreScript)\s+['"]([^'"]+)['"],?\s+Line\s+(\d+)(?:\s*-\s*(.+))?$/i;

const WARNING_LINE_RE = /^(?:Infinite yield possible on\b|DataStore request was added to queue\b|Not running script because past shutdown deadline\b|\[(?:WARN(?:ING)?|INFO|DEBUG|LOG)\]|(?:WARN(?:ING)?|INFO|DEBUG|LOG)\s*:|WARN\s+)/i;

const STRING_ERROR_RE = /^\[string\s+["']([^"']+)["']\]:(\d+):\s*(.+)$/;
const PATH_ERROR_RE = /^([^\s:][^:]*):(\d+):\s*(.+)$/;

const KNOWN_SERVICES = new Set([
  "Workspace",
  "Players",
  "Lighting",
  "MaterialService",
  "ReplicatedFirst",
  "ReplicatedStorage",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "Teams",
  "SoundService",
  "Chat",
  "TextChatService",
  "CoreGui",
  "CorePackages",
  "TestService",
]);

const EXT_BY_TYPE = {
  LocalScript: [".client.luau", ".client.lua", ".luau", ".lua", ".server.luau", ".server.lua"],
  ModuleScript: [".luau", ".lua", ".server.luau", ".server.lua", ".client.luau", ".client.lua"],
  Script: [".server.luau", ".server.lua", ".client.luau", ".client.lua", ".luau", ".lua"],
};

const INIT_BY_TYPE = {
  LocalScript: ["init.client.luau", "init.client.lua", "init.luau", "init.lua", "init.server.luau", "init.server.lua"],
  ModuleScript: ["init.luau", "init.lua", "init.server.luau", "init.server.lua", "init.client.luau", "init.client.lua"],
  Script: ["init.server.luau", "init.server.lua", "init.client.luau", "init.client.lua", "init.luau", "init.lua"],
};

/** Strip ANSI codes, control chars, normalize newlines, and cap UTF-8 byte length at MAX_LOG_BYTES. */
export function sanitizeOutputText(raw) {
  const cleaned = String(raw ?? "")
    .replace(ANSI_RE, "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_RE, "");
  const buf = Buffer.from(cleaned, "utf8");
  const originalBytes = buf.length;
  const truncated = originalBytes > MAX_LOG_BYTES;
  const text = truncated
    ? buf.subarray(0, MAX_LOG_BYTES).toString("utf8").replace(/\uFFFD+$/, "")
    : cleaned;
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    originalBytes,
    truncated,
  };
}

function cleanSingleLine(s) {
  return String(s ?? "")
    .replace(ANSI_RE, "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_RE, "")
    .trim();
}

function stripStudioDecoration(rawLine) {
  let line = rawLine.trim();
  if (!line) return "";
  // Collapse long whitespace runs first: the suffix regex below is quadratic on them.
  line = line.replace(/\s{3,}/g, "  ");
  line = line.replace(TIMESTAMP_PREFIX_RE, "");
  line = line.replace(STUDIO_ORIGIN_SUFFIX_RE, "");
  return line.trim();
}

function isLikelyInstancePath(rawPath) {
  if (!rawPath || rawPath.length > 300) return false;
  if (/[\/\\\[\]<>]/.test(rawPath)) return false;
  const normalized = rawPath.replace(/^game\./, "");
  const parts = normalized.split(".");
  if (parts.some((p) => !p || !p.trim())) return false;
  if (parts.length === 1) return KNOWN_SERVICES.has(parts[0]);
  return /^[A-Za-z_][\w]*$/.test(parts[0]);
}

function normalizeInstancePath(rawPath) {
  return String(rawPath || "").trim().replace(/^game\./, "");
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Locate default.project.json or the first *.project.json at repo root. Returns { file, abs, data } or null. */
export function findRojoProject(repo) {
  if (!repo) return null;
  let root;
  try {
    root = fs.realpathSync(path.resolve(repo));
  } catch {
    return null;
  }
  const candidates = [];
  const def = path.join(root, "default.project.json");
  try {
    const st = fs.lstatSync(def);
    if (st.isFile() && !st.isSymbolicLink()) candidates.push({ file: "default.project.json", abs: def });
  } catch {}
  try {
    const entries = fs.readdirSync(root)
      .filter((name) => name.endsWith(".project.json") && name !== "default.project.json")
      .sort();
    for (const name of entries) {
      const abs = path.join(root, name);
      try {
        const st = fs.lstatSync(abs);
        if (st.isFile() && !st.isSymbolicLink()) candidates.push({ file: name, abs });
      } catch {}
    }
  } catch {}

  for (const cand of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(cand.abs, "utf8"));
      if (isPlainObject(data) && isPlainObject(data.tree)) {
        return { file: cand.file, abs: cand.abs, data };
      }
    } catch {}
  }
  return null;
}

function safeRepoFile(realRoot, absPath) {
  const rel = path.relative(realRoot, absPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const st = fs.lstatSync(absPath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const real = fs.realpathSync(absPath);
    if (real !== path.join(realRoot, rel)) return null;
    return rel.split(path.sep).join("/");
  } catch {
    return null;
  }
}

function safeRepoDir(realRoot, absPath) {
  const rel = path.relative(realRoot, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    const st = fs.lstatSync(absPath);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const real = fs.realpathSync(absPath);
    const expected = rel ? path.join(realRoot, rel) : realRoot;
    if (real !== expected) return null;
    return real;
  } catch {
    return null;
  }
}

function resolveInFs(realRoot, fsTarget, segments, extOrder, initOrder) {
  const targetAbs = path.resolve(realRoot, fsTarget);
  const relToRoot = path.relative(realRoot, targetAbs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;

  if (segments.length === 0) {
    const asFile = safeRepoFile(realRoot, targetAbs);
    if (asFile) return asFile;
    const asDir = safeRepoDir(realRoot, targetAbs);
    if (!asDir) return null;
    for (const initName of initOrder) {
      const hit = safeRepoFile(realRoot, path.join(asDir, initName));
      if (hit) return hit;
    }
    return null;
  }

  const dir = safeRepoDir(realRoot, targetAbs);
  if (!dir) return null;

  if (segments.length === 1) {
    const name = segments[0];
    if (!name || name === "." || name === ".." || /[\/\\]/.test(name)) return null;
    for (const ext of extOrder) {
      const hit = safeRepoFile(realRoot, path.join(dir, name + ext));
      if (hit) return hit;
    }
    const subDir = safeRepoDir(realRoot, path.join(dir, name));
    if (subDir) {
      for (const initName of initOrder) {
        const hit = safeRepoFile(realRoot, path.join(subDir, initName));
        if (hit) return hit;
      }
    }
    return null;
  }

  const [head, ...tail] = segments;
  if (!head || head === "." || head === ".." || /[\/\\]/.test(head)) return null;
  const nextDir = safeRepoDir(realRoot, path.join(dir, head));
  if (!nextDir) return null;
  return resolveInFs(realRoot, nextDir, tail, extOrder, initOrder);
}

function nodePathValue(node) {
  if (!isPlainObject(node)) return null;
  if (typeof node.$path === "string" && node.$path.trim()) return node.$path.trim();
  if (isPlainObject(node.$path) && typeof node.$path.optional === "string" && node.$path.optional.trim()) {
    return node.$path.optional.trim();
  }
  return null;
}

function walkRojoTree(realRoot, node, segments, extOrder, initOrder) {
  if (!isPlainObject(node)) return null;

  if (segments.length === 0) {
    const p = nodePathValue(node);
    return p ? resolveInFs(realRoot, p, [], extOrder, initOrder) : null;
  }

  const [head, ...tail] = segments;
  if (!head.startsWith("$") && Object.hasOwn(node, head) && isPlainObject(node[head])) {
    const hit = walkRojoTree(realRoot, node[head], tail, extOrder, initOrder);
    if (hit) return hit;
  }

  const p = nodePathValue(node);
  if (p) {
    const hit = resolveInFs(realRoot, p, segments, extOrder, initOrder);
    if (hit) return hit;
  }

  return null;
}

const SCRIPT_SUFFIXES = [
  { ext: ".server.luau", scriptType: "Script" },
  { ext: ".server.lua", scriptType: "Script" },
  { ext: ".client.luau", scriptType: "LocalScript" },
  { ext: ".client.lua", scriptType: "LocalScript" },
  { ext: ".luau", scriptType: "ModuleScript" },
  { ext: ".lua", scriptType: "ModuleScript" },
];

const INIT_ORDER = [
  { file: "init.server.luau", scriptType: "Script" },
  { file: "init.server.lua", scriptType: "Script" },
  { file: "init.client.luau", scriptType: "LocalScript" },
  { file: "init.client.lua", scriptType: "LocalScript" },
  { file: "init.luau", scriptType: "ModuleScript" },
  { file: "init.lua", scriptType: "ModuleScript" },
];
const INIT_NAME_SET = new Set(INIT_ORDER.map((x) => x.file));

function parseScriptFilename(filename) {
  for (const { ext, scriptType } of SCRIPT_SUFFIXES) {
    if (filename.endsWith(ext) && filename.length > ext.length) {
      return { name: filename.slice(0, -ext.length), scriptType };
    }
  }
  return null;
}

/** Collect all script/module mappings (instancePath <-> file) and watched dirs from a Rojo project. */
export function collectRojoScripts(repo, { project } = {}) {
  const proj = project !== undefined ? project : findRojoProject(repo);
  if (!proj || !repo) return null;
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(repo));
  } catch {
    return null;
  }

  const byInstance = new Map();
  const dirs = new Set();
  const instanceFolders = new Set();

  const record = (instancePath, file, scriptType) => {
    if (!instancePath || !file) return;
    if (!byInstance.has(instancePath)) {
      byInstance.set(instancePath, { instancePath, file, scriptType });
    }
  };

  const walkDir = (absDir, segments, node) => {
    const relDir = path.relative(realRoot, absDir).split(path.sep).join("/") || ".";
    dirs.add(relDir);
    if (segments.length > 0) instanceFolders.add(segments.join("."));

    if (segments.length > 0) {
      const instPath = segments.join(".");
      for (const init of INIT_ORDER) {
        const hit = safeRepoFile(realRoot, path.join(absDir, init.file));
        if (hit) {
          record(instPath, hit, init.scriptType);
          break;
        }
      }
    }

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const d of entries) {
      if (d.name === ".git" || d.name === ".tokenwise-studio" || d.isSymbolicLink()) continue;
      if (d.isFile()) {
        if (INIT_NAME_SET.has(d.name)) continue;
        const parsed = parseScriptFilename(d.name);
        if (!parsed) continue;
        if (node && !parsed.name.startsWith("$") && Object.hasOwn(node, parsed.name) && nodePathValue(node[parsed.name])) {
          continue;
        }
        const hit = safeRepoFile(realRoot, path.join(absDir, d.name));
        if (hit) record([...segments, parsed.name].join("."), hit, parsed.scriptType);
      } else if (d.isDirectory()) {
        if (node && !d.name.startsWith("$") && Object.hasOwn(node, d.name) && isPlainObject(node[d.name])) {
          continue;
        }
        const subDir = safeRepoDir(realRoot, path.join(absDir, d.name));
        if (subDir) walkDir(subDir, [...segments, d.name], null);
      }
    }
  };

  const walkProjectNode = (node, segments, inheritedDir = null) => {
    if (!isPlainObject(node)) return;
    const p = nodePathValue(node);
    let resolvedDir = null;
    if (p) {
      const targetAbs = path.resolve(realRoot, p);
      const relToRoot = path.relative(realRoot, targetAbs);
      if (!relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) {
        const asFile = safeRepoFile(realRoot, targetAbs);
        if (asFile) {
          const parsed = parseScriptFilename(path.basename(asFile));
          if (parsed && segments.length > 0) record(segments.join("."), asFile, parsed.scriptType);
        } else {
          resolvedDir = safeRepoDir(realRoot, targetAbs);
        }
      }
    } else if (inheritedDir) {
      resolvedDir = safeRepoDir(realRoot, inheritedDir);
    }

    if (resolvedDir) {
      walkDir(resolvedDir, segments, node);
    } else if (segments.length > 0) {
      instanceFolders.add(segments.join("."));
    }

    for (const key of Object.keys(node).sort()) {
      if (key.startsWith("$") || !isPlainObject(node[key])) continue;
      const childFallbackDir = resolvedDir ? path.join(resolvedDir, key) : null;
      walkProjectNode(node[key], [...segments, key], childFallbackDir);
    }
  };

  walkProjectNode(proj.data.tree, []);

  const scripts = [...byInstance.values()].sort((a, b) => a.instancePath.localeCompare(b.instancePath));
  return {
    projectFile: proj.file,
    scripts,
    dirs: [...dirs].sort(),
    instanceFolders,
  };
}

/** Resolve a Roblox instance path against a repo's Rojo project tree. Returns repo-relative path or null. */
export function resolveRojoPath(repo, rawPath, { project, scriptType } = {}) {
  const proj = project !== undefined ? project : findRojoProject(repo);
  if (!proj || !repo) return null;
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(repo));
  } catch {
    return null;
  }

  const clean = normalizeInstancePath(rawPath);
  if (!clean) return null;
  const segments = clean.split(".").filter(Boolean);
  if (!segments.length) return null;

  const extOrder = EXT_BY_TYPE[scriptType] || EXT_BY_TYPE.Script;
  const initOrder = INIT_BY_TYPE[scriptType] || INIT_BY_TYPE.Script;

  const direct = walkRojoTree(realRoot, proj.data.tree, segments, extOrder, initOrder);
  if (direct) return direct;

  // Fallback for runtime-cloned player containers (Play Solo / live server).
  if (segments[0] === "Players" && segments.length >= 4) {
    const container = segments[2];
    const rest = segments.slice(3);
    if (container === "PlayerScripts") {
      return walkRojoTree(realRoot, proj.data.tree, ["StarterPlayer", "StarterPlayerScripts", ...rest], extOrder, initOrder);
    }
    if (container === "PlayerGui") {
      return walkRojoTree(realRoot, proj.data.tree, ["StarterGui", ...rest], extOrder, initOrder);
    }
    if (container === "Backpack") {
      return walkRojoTree(realRoot, proj.data.tree, ["StarterPack", ...rest], extOrder, initOrder);
    }
  }
  return null;
}

function formatLocation(file, rawPath, line) {
  const base = file || rawPath;
  return line ? `${base}:${line}` : base;
}

function parseErrorLine(line) {
  const stripped = line.replace(ERROR_PREFIX_RE, "");
  let m = stripped.match(STRING_ERROR_RE);
  if (m) {
    const rawPath = normalizeInstancePath(m[1]);
    const lineNum = Number(m[2]);
    const message = m[3].trim();
    if (rawPath && lineNum > 0 && message) return { rawPath, line: lineNum, message };
  }
  m = stripped.match(PATH_ERROR_RE);
  if (m) {
    const candidate = m[1].trim();
    const lineNum = Number(m[2]);
    const message = m[3].trim();
    if (lineNum > 0 && message && isLikelyInstancePath(candidate)) {
      return { rawPath: normalizeInstancePath(candidate), line: lineNum, message };
    }
  }
  return null;
}

function inferScriptType(rawPath, explicitType) {
  if (explicitType) return explicitType;
  if (/^(?:StarterPlayer\.StarterPlayerScripts|Players\.[^.]+\.PlayerScripts|StarterGui|Players\.[^.]+\.PlayerGui)\./.test(rawPath)) {
    return "LocalScript";
  }
  if (/^(?:ReplicatedStorage|ReplicatedFirst)\./.test(rawPath)) {
    return "ModuleScript";
  }
  return "Script";
}

/**
 * Parse Roblox Studio Output text into deduplicated errors with Rojo-mapped file paths.
 * Ignores warnings, info/print lines, and any non-Output text. Caps input at 20 KB.
 */
export function parseStudioErrors(rawText, { repo } = {}) {
  const { text, bytes, originalBytes, truncated } = sanitizeOutputText(rawText);
  const project = repo ? findRojoProject(repo) : null;

  const rawErrors = [];
  let ignoredWarnings = 0;
  let currentError = null;
  let inStack = false;
  let ignoringWarningStack = false;

  for (const rawLine of text.split("\n")) {
    const line = stripStudioDecoration(rawLine);
    if (!line) {
      if (!inStack) {
        currentError = null;
        ignoringWarningStack = false;
      }
      continue;
    }

    if (STACK_BEGIN_RE.test(line)) {
      inStack = true;
      continue;
    }

    if (STACK_END_RE.test(line)) {
      inStack = false;
      ignoringWarningStack = false;
      currentError = null;
      continue;
    }

    if (WARNING_LINE_RE.test(line)) {
      ignoredWarnings += 1;
      currentError = null;
      inStack = false;
      ignoringWarningStack = true;
      continue;
    }

    const frameMatch = line.match(STACK_FRAME_RE);
    if (frameMatch) {
      if (ignoringWarningStack) continue;
      const scriptType = frameMatch[1];
      const rawPath = normalizeInstancePath(frameMatch[2]);
      const lineNum = Number(frameMatch[3]);
      const rawFunc = frameMatch[4] ? frameMatch[4].trim() : "";
      const func = rawFunc ? rawFunc.replace(/^function\s+/i, "").trim() || null : null;
      const file = resolveRojoPath(repo, rawPath, { project, scriptType });
      const frame = {
        rawPath,
        file,
        line: lineNum > 0 ? lineNum : null,
        location: formatLocation(file, rawPath, lineNum > 0 ? lineNum : null),
        resolved: !!file,
        func,
        scriptType,
      };
      if (!currentError) {
        currentError = {
          rawPath,
          file,
          line: frame.line,
          location: frame.location,
          resolved: !!file,
          message: func ? `Script error in ${func}` : "Script error",
          stack: [],
        };
        rawErrors.push(currentError);
      }
      currentError.stack.push(frame);
      continue;
    }

    const err = parseErrorLine(line);
    if (err) {
      ignoringWarningStack = false;
      inStack = false;
      const scriptType = inferScriptType(err.rawPath, null);
      const file = resolveRojoPath(repo, err.rawPath, { project, scriptType });
      currentError = {
        rawPath: err.rawPath,
        file,
        line: err.line,
        location: formatLocation(file, err.rawPath, err.line),
        resolved: !!file,
        message: err.message,
        stack: [],
      };
      rawErrors.push(currentError);
      continue;
    }

    if (!inStack) {
      currentError = null;
      ignoringWarningStack = false;
    }
  }

  // Deduplicate by resolved/raw location + message while preserving order.
  const deduped = [];
  const byKey = new Map();
  for (const item of rawErrors) {
    const key = `${item.location}\0${item.message}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.stack.length === 0 && item.stack.length > 0) {
        existing.stack = item.stack;
      }
    } else {
      const entry = {
        id: `err-${deduped.length}`,
        ...item,
        count: 1,
      };
      byKey.set(key, entry);
      deduped.push(entry);
    }
  }

  return {
    projectFile: project ? project.file : null,
    errors: deduped,
    truncated,
    bytes,
    originalBytes,
    ignoredWarnings,
    totalMatches: rawErrors.length,
  };
}

/**
 * Format selected parsed errors into a clean orchestrator prompt asking it to delegate fixes.
 * Sanitizes all fields and enforces the 20 KB cap.
 */
export function formatStudioPrompt(selectedErrors) {
  if (!Array.isArray(selectedErrors) || selectedErrors.length === 0) {
    throw new Error("select at least one error");
  }

  const lines = [
    "Fix these Roblox Studio Output errors. Inspect the referenced files and delegate fixes to the appropriate workers:",
    "",
  ];

  selectedErrors.forEach((err, idx) => {
    const file = cleanSingleLine(err?.file || "");
    const rawPath = cleanSingleLine(err?.rawPath || "");
    const lineNum = Number.isInteger(err?.line) && err.line > 0 ? err.line : null;
    const loc = cleanSingleLine(err?.location || "") || formatLocation(file || null, rawPath || "unknown", lineNum);
    const msg = cleanSingleLine(err?.message || "Script error");
    const count = Number.isInteger(err?.count) && err.count > 1 ? ` (${err.count}x)` : "";

    lines.push(`${idx + 1}. ${loc}${count}`);
    lines.push(`Error: ${msg}`);

    const stack = Array.isArray(err?.stack) ? err.stack : [];
    if (stack.length > 0) {
      lines.push("Stack:");
      for (const f of stack) {
        const sf = cleanSingleLine(f?.file || "");
        const sr = cleanSingleLine(f?.rawPath || "");
        const sl = Number.isInteger(f?.line) && f.line > 0 ? f.line : null;
        const sloc = cleanSingleLine(f?.location || "") || formatLocation(sf || null, sr || "unknown", sl);
        const sfunc = cleanSingleLine(f?.func || "");
        lines.push(`  - ${sloc}${sfunc ? ` (${sfunc})` : ""}`);
      }
    }
    lines.push("");
  });

  const joined = lines.join("\n").trim();
  const buf = Buffer.from(joined, "utf8");
  if (buf.length <= MAX_LOG_BYTES) return joined;
  return buf.subarray(0, MAX_LOG_BYTES).toString("utf8").replace(/\uFFFD+$/, "").trimEnd();
}
