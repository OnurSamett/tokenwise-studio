// Resolve a tool name (git, claude, codex, npm, ...) to an absolute path by walking PATH ourselves.
// Why: Windows' CreateProcess and `which`/cross-spawn look in the current/working directory first, so a
// repository that ships git.cmd / claude.cmd / git.exe would run its own binary when the studio opens it.
// We skip relative PATH entries ("", ".", "bin"), the child's working directory, the process cwd and any
// registered project/worktree dirs, and spawn the absolute result.
import fs from "node:fs";
import path from "node:path";

const untrusted = new Set();
/** Register a project/worktree directory that must never supply executables. */
export const addUntrustedDir = (d) => { if (d) untrusted.add(String(d)); };
export const untrustedDirs = () => [...untrusted];

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isFile(fsx, p) { try { return fsx.statSync(p).isFile(); } catch { return false; } }

export function resolveTool(name, { platform = process.platform, env = process.env, cwd = process.cwd(), avoid = [], fsx = fs } = {}) {
  const win = platform === "win32";
  const P = win ? path.win32 : path.posix;
  const norm = (d) => { const n = P.resolve(d); return win ? n.toLowerCase().replace(/[\\/]+$/, "") : n.replace(/\/+$/, ""); };
  if (typeof name !== "string" || !name) return null;
  if (/[\\/]/.test(name) || (win && /^[a-z]:/i.test(name))) return P.isAbsolute(name) && isFile(fsx, name) ? name : (P.isAbsolute(name) ? name : null);

  const bad = new Set([cwd, process.cwd(), ...untrusted, ...avoid].filter(Boolean).map(norm));
  const pathVar = win ? (env.Path ?? env.PATH ?? "") : (env.PATH ?? "");
  const exts = win
    ? (env.PATHEXT || DEFAULT_PATHEXT).split(";").map((e) => e.trim()).filter(Boolean)
    : [""];
  const names = win
    ? (exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase())) ? [name] : []).concat(exts.map((e) => name + e.toLowerCase()), exts.map((e) => name + e))
    : [name];
  for (let dir of pathVar.split(win ? ";" : ":")) {
    dir = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || dir === "." || dir === "..") continue;
    if (!P.isAbsolute(dir)) continue; // relative entries resolve against the cwd: never trust them
    if (bad.has(norm(dir))) continue;
    for (const n of names) {
      const full = P.join(dir, n);
      if (!isFile(fsx, full)) continue;
      if (!win) { try { fsx.accessSync(full, fs.constants.X_OK); } catch { continue; } }
      return full;
    }
  }
  return null;
}
