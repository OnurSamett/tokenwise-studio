// Read-only workspace helpers for the side panel: lazy/paged file tree, confined text reader,
// safe image preview resolver, and staged/unstaged working-tree diff.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BLOCKED_DIRS, isSecret, norm } from "./freeagent.js";
import { imageType } from "./jobimages.js";

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MB cap for text reads
export const MAX_RAW_IMAGE_BYTES = 15 * 1024 * 1024;
export const DEFAULT_FILES_LIMIT = 200;
export const MAX_FILES_LIMIT = 1000;
export const HIDDEN_DIRS = new Set([".git", ".tokenwise-studio"]);

export const PREVIEW_IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "ico", "bmp", "tiff", "avif",
  "pdf", "zip", "gz", "tar", "7z", "rar", "xz", "bz2",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi",
  "exe", "dll", "so", "dylib", "o", "a", "pyc", "class", "jar", "wasm", "sqlite", "db", "bin",
]);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function hasBlockedDir(parts) {
  return parts.some((p) => BLOCKED_DIRS.has(norm(p)));
}

function isBlockedRel(rel, { file = false } = {}) {
  const parts = String(rel || "").split(/[\\/]/).filter(Boolean);
  if (hasBlockedDir(parts)) return true;
  if (file && parts.length && isSecret(parts[parts.length - 1])) return true;
  return false;
}

/** Resolve a repo-relative path safely: confined to realpath(repo), no symlinks out, blocklist enforced. */
export function resolveConfinedPath(repo, rawRel, { file = false, allowRoot = false } = {}) {
  const raw = String(rawRel ?? "");
  if (raw.includes("\0")) throw httpError(400, "invalid path");
  if (path.isAbsolute(raw) || /^[\\/]/.test(raw)) throw httpError(403, "absolute paths are not allowed");

  const rawParts = raw.split(/[\\/]/);
  if (rawParts.some((p) => p === "..")) throw httpError(403, "path outside repository");
  const parts = rawParts.filter((p) => p && p !== ".");
  if (!parts.length && !allowRoot) throw httpError(400, "missing path");

  if (hasBlockedDir(parts)) throw httpError(403, "access to this folder is not allowed");
  if (file && parts.length && isSecret(parts[parts.length - 1])) {
    throw httpError(403, "secret files are not accessible");
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(repo);
  } catch {
    throw httpError(404, "repository not found");
  }

  const relLex = parts.join(path.sep);
  const abs = parts.length ? path.resolve(realRoot, relLex) : realRoot;
  const relFromRoot = path.relative(realRoot, abs);
  if (relFromRoot === ".." || relFromRoot.startsWith(".." + path.sep) || path.isAbsolute(relFromRoot)) {
    throw httpError(403, "path outside repository");
  }

  let lstat;
  try {
    lstat = fs.lstatSync(abs);
  } catch (e) {
    if (e.code === "ENOENT") throw httpError(404, "path not found");
    throw httpError(403, `cannot access path: ${e.code || e.message}`);
  }

  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (e) {
    if (lstat.isSymbolicLink()) throw httpError(403, "symbolic link points outside repository or cannot be resolved");
    throw httpError(404, "path not found");
  }

  const inside = allowRoot
    ? real === realRoot || real.startsWith(realRoot + path.sep)
    : real.startsWith(realRoot + path.sep);
  if (!inside) throw httpError(403, "symbolic links outside the repository are not allowed");

  const realRel = path.relative(realRoot, real);
  if (realRel && isBlockedRel(realRel, { file })) {
    throw httpError(403, "access to this path is not allowed");
  }

  return {
    realRoot,
    abs,
    real,
    rel: parts.join("/"),
  };
}

function isHiddenPath(rel) {
  const parts = rel.split("/").filter(Boolean);
  return parts.some((p) => HIDDEN_DIRS.has(norm(p)));
}

function gitLsFiles(repo) {
  const out = execFileSync(
    "git",
    ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => !isHiddenPath(p));
}

function fallbackListDir(realDir, prefix) {
  const entries = [];
  for (const d of fs.readdirSync(realDir, { withFileTypes: true })) {
    if (HIDDEN_DIRS.has(norm(d.name))) continue;
    if (d.isSymbolicLink()) continue;
    const p = prefix ? `${prefix}${d.name}` : d.name;
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: p, type: "dir" });
    } else if (d.isFile()) {
      const ext = path.extname(d.name).slice(1).toLowerCase();
      entries.push({ name: d.name, path: p, type: "file", ext, image: !!PREVIEW_IMAGE_TYPES[ext] });
    }
  }
  return entries;
}

function sortTreeEntries(entries) {
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    const la = a.name.toLowerCase(), lb = b.name.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries;
}

/** Lazy-loaded, paged immediate directory listing respecting .gitignore and hiding .git/.tokenwise-studio. */
export function listRepoFiles(repo, { dir = "", offset = 0, limit = DEFAULT_FILES_LIMIT } = {}) {
  const resolved = resolveConfinedPath(repo, dir, { file: false, allowRoot: true });
  if (!fs.statSync(resolved.real).isDirectory()) throw httpError(400, "not a directory");

  const prefix = resolved.rel ? `${resolved.rel}/` : "";
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const lim = Math.min(MAX_FILES_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_FILES_LIMIT)));

  let entries;
  let isGit = true;
  try {
    const files = gitLsFiles(resolved.realRoot);
    const seenDirs = new Set();
    const seenFiles = new Set();
    entries = [];
    for (const f of files) {
      if (prefix && !f.startsWith(prefix)) continue;
      const rest = prefix ? f.slice(prefix.length) : f;
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const name = rest.slice(0, slash);
        if (!name || seenDirs.has(name)) continue;
        seenDirs.add(name);
        entries.push({ name, path: prefix + name, type: "dir" });
      } else {
        if (seenFiles.has(rest)) continue;
        seenFiles.add(rest);
        const ext = path.extname(rest).slice(1).toLowerCase();
        entries.push({ name: rest, path: prefix + rest, type: "file", ext, image: !!PREVIEW_IMAGE_TYPES[ext] });
      }
    }
  } catch {
    isGit = false;
    entries = fallbackListDir(resolved.real, prefix);
  }

  sortTreeEntries(entries);
  const total = entries.length;
  const page = entries.slice(off, off + lim);
  const nextCursor = off + page.length < total ? off + page.length : null;
  return {
    dir: resolved.rel,
    isGit,
    entries: page,
    total,
    offset: off,
    limit: lim,
    hasMore: nextCursor !== null,
    nextCursor,
  };
}

function trimIncompleteUtf8(buf) {
  let end = buf.length;
  let cont = 0;
  while (end > 0 && cont < 3 && (buf[end - 1] & 0xc0) === 0x80) {
    end--;
    cont++;
  }
  if (end === 0) return buf;
  const b = buf[end - 1];
  if (b < 0x80) return buf;
  const expected = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  const have = buf.length - (end - 1);
  return have < expected ? buf.subarray(0, end - 1) : buf;
}

/** Read a text file from the repo with 1 MB hard cap, binary rejection, and path/secret policy. */
export function readRepoTextFile(repo, relPath, { maxBytes } = {}) {
  const resolved = resolveConfinedPath(repo, relPath, { file: true, allowRoot: false });
  const st = fs.statSync(resolved.real);
  if (!st.isFile()) throw httpError(400, "not a regular file");

  const ext = path.extname(resolved.real).slice(1).toLowerCase();
  if (BINARY_EXT.has(ext)) throw httpError(415, "binary file (text only)");

  const requested = Number(maxBytes);
  const cap = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_FILE_BYTES)
    : MAX_FILE_BYTES;

  const toRead = Math.min(st.size, cap);
  const fd = fs.openSync(resolved.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let buf;
  try {
    buf = Buffer.alloc(toRead);
    let pos = 0;
    while (pos < toRead) {
      const n = fs.readSync(fd, buf, pos, toRead - pos, pos);
      if (n <= 0) break;
      pos += n;
    }
    if (pos < buf.length) buf = buf.subarray(0, pos);
  } finally {
    fs.closeSync(fd);
  }

  if (buf.includes(0)) throw httpError(415, "binary file (text only)");

  const truncated = st.size > cap;
  const cleanBuf = truncated ? trimIncompleteUtf8(buf) : buf;
  const content = cleanBuf.toString("utf8");
  return {
    path: resolved.rel,
    content,
    size: st.size,
    bytesRead: cleanBuf.length,
    cap,
    truncated,
    lines: content.length ? content.split("\n").length : 0,
    ext,
  };
}

/** Resolve an image file inside the repo for the Preview tab (confined, no symlinks out, blocklist enforced). */
export function resolveRepoImage(repo, relPath) {
  const resolved = resolveConfinedPath(repo, relPath, { file: true, allowRoot: false });
  const ext = path.extname(resolved.real).slice(1).toLowerCase();
  const type = PREVIEW_IMAGE_TYPES[ext];
  if (!type) throw httpError(415, "not a supported image file");
  const st = fs.statSync(resolved.real);
  if (!st.isFile()) throw httpError(400, "not a regular file");
  if (st.size > MAX_RAW_IMAGE_BYTES) throw httpError(413, "image is larger than 15 MB");
  return { abs: resolved.real, rel: resolved.rel, type, size: st.size };
}

/** Split unified git diff text into per-file records (shared by job diffs and worktree diff). */
export function splitDiff(raw) {
  if (!raw) return [];
  return raw.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git")).map((patch) => {
    const m = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const add = (patch.match(/^\+(?!\+\+)/gm) || []).length;
    const del = (patch.match(/^-(?!--)/gm) || []).length;
    const p = m ? m[2] : "?";
    // Binary files: keep the header only; the base85 body is useless in a review and can be huge.
    if (/^GIT binary patch$|^Binary files /m.test(patch)) {
      const head = patch.split("\n").filter((l) => /^(diff --git|new file mode|deleted file mode|similarity|rename )/.test(l)).join("\n");
      return { path: p, add: 0, del: 0, binary: true, image: !!imageType(p), deleted: /^deleted file mode/m.test(patch), patch: head + "\n" };
    }
    return { path: p, add, del, patch };
  });
}

/** Return staged + unstaged diff of the main working tree (git diff / git diff --cached). */
export function worktreeDiff(repo) {
  let isGit = false;
  try {
    const check = execFileSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    isGit = check === "true";
  } catch {
    isGit = false;
  }
  if (!isGit) return { isGit: false, staged: [], unstaged: [] };

  const runDiff = (...args) => {
    try {
      return execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return "";
    }
  };

  const keep = (f) => !isHiddenPath(f.path) && !isBlockedRel(f.path, { file: true });
  const staged = splitDiff(runDiff("diff", "--cached", "--no-renames", "--no-ext-diff"))
    .filter(keep)
    .map((f) => ({ ...f, staged: true }));
  const unstaged = splitDiff(runDiff("diff", "--no-renames", "--no-ext-diff"))
    .filter(keep)
    .map((f) => ({ ...f, staged: false }));

  return { isGit: true, staged, unstaged };
}
