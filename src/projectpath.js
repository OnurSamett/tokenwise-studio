import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SYSTEM_DIRS = new Set(["/", "/Library", "/System", "/usr", "/bin", "/sbin", "/etc", "/var", "/private", "/Applications", "/Volumes"]);

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export function tempRoots() {
  return [...new Set(["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", os.tmpdir(), real(os.tmpdir())])];
}

/** Why a folder cannot be a project, or null when it can: a writable directory that is not a temp or system folder. */
export function projectProblem(p, { allowTemp = false } = {}) {
  if (!p || typeof p !== "string") return "no project folder given";
  const abs = path.resolve(p);
  let st;
  try { st = fs.statSync(abs); } catch { return `the folder does not exist: ${abs}`; }
  if (!st.isDirectory()) return `not a folder: ${abs}`;
  const r = real(abs);
  if (SYSTEM_DIRS.has(abs) || SYSTEM_DIRS.has(r) || abs.startsWith("/Library/") || abs.startsWith("/System/")) return `this is a system folder, not a project: ${abs}`;
  if (!allowTemp && tempRoots().some((t) => within(abs, t) || within(r, t))) return `temporary folders are not used as projects: ${abs}`;
  try { fs.accessSync(abs, fs.constants.W_OK); } catch { return `tokenwise studio cannot write to this folder: ${abs}`; }
  return null;
}

/** Guard for tests: refuse to touch the real home state dir while node --test runs. */
export function assertNotRealHomeInTests() {
  if (!process.env.NODE_TEST_CONTEXT && !process.env.TOKENWISE_TEST) return;
  let realHome = null;
  try { realHome = os.userInfo().homedir; } catch {}
  if (realHome && path.resolve(os.homedir()) === path.resolve(realHome) && !process.env.TOKENWISE_TEST_ALLOW_REAL_HOME) {
    throw new Error("refusing to use the real home (~/.tokenwise-studio) in tests: run `npm test` (it isolates HOME) or set HOME to a temp dir");
  }
}
