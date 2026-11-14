// Git pre-apply snapshots and selective undo for applied worker changes.
// Captures BOTH index and working tree (including untracked files) via git plumbing
// without modifying the user's current branch, index, or working tree.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SNAPSHOT_PREFIX = "refs/tokenwise/pre-apply/";
export const MAX_SNAPSHOTS = 30;

const gitEnv = (extra = {}) => ({
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "tokenwise",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "tokenwise@local",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "tokenwise",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "tokenwise@local",
  ...extra,
});

const git = (cwd, args, opts = {}) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });

const gitBuf = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function safeRepoPath(repo, rel) {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) throw new Error(`invalid path: ${rel}`);
  const norm = rel.replace(/\\/g, "/");
  if (norm === ".git" || norm.startsWith(".git/") || norm.split("/").includes("..")) {
    throw new Error(`unsafe repo path: ${rel}`);
  }
  const abs = path.resolve(repo, rel);
  const root = path.resolve(repo);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes repo: ${rel}`);
  }
  return abs;
}

function lsTreeEntry(repo, treeish, rel) {
  let out = "";
  try {
    out = git(repo, ["ls-tree", "-z", treeish, "--", rel]);
  } catch {
    return null;
  }
  for (const rec of out.split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const file = rec.slice(tab + 1);
    if (file !== rel) continue;
    const [mode, type, sha] = rec.slice(0, tab).split(" ");
    if (type === "blob") return { mode, sha };
  }
  return null;
}

function indexEntry(repo, rel) {
  let out = "";
  try {
    out = git(repo, ["ls-files", "-s", "-z", "--", rel]);
  } catch {
    return null;
  }
  const recs = out.split("\0").filter(Boolean);
  if (!recs.length) return null;
  if (recs.length > 1) return "unmerged";
  const tab = recs[0].indexOf("\t");
  if (tab < 0 || recs[0].slice(tab + 1) !== rel) return null;
  const [mode, sha, stage] = recs[0].slice(0, tab).split(" ");
  if (stage !== "0") return "unmerged";
  return { mode, sha };
}

function worktreeEntry(repo, rel) {
  const abs = safeRepoPath(repo, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
  if (st.isSymbolicLink()) return { type: "symlink", sha: sha256(fs.readlinkSync(abs)) };
  if (st.isFile()) {
    return {
      type: "file",
      mode: st.mode & 0o111 ? "100755" : "100644",
      sha: sha256(fs.readFileSync(abs)),
    };
  }
  if (st.isDirectory()) return { type: "dir" };
  return null;
}

/** Capture HEAD, index, and working-tree state for each repo-relative path. */
export function captureFileStates(repo, files = []) {
  let hasHead = false;
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    hasHead = true;
  } catch {}
  const states = {};
  for (const rel of files) {
    states[rel] = {
      head: hasHead ? lsTreeEntry(repo, "HEAD", rel) : null,
      index: indexEntry(repo, rel),
      worktree: worktreeEntry(repo, rel),
    };
  }
  return states;
}

/** Keep at most `max` refs under refs/tokenwise/pre-apply/, deleting the oldest first. */
export function pruneSnapshots(repo, max = MAX_SNAPSHOTS) {
  const prefix = SNAPSHOT_PREFIX.slice(0, -1);
  let refs = [];
  try {
    refs = git(repo, ["for-each-ref", "--format=%(refname)", prefix])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
  if (refs.length <= max) return [];
  const pruned = refs.slice(0, refs.length - max);
  for (const r of pruned) {
    try { git(repo, ["update-ref", "-d", r]); } catch {}
  }
  return pruned;
}

/**
 * Record a pre-apply git snapshot under refs/tokenwise/pre-apply/<timestamp>-<jobId>.
 * Captures BOTH the current index (parent 2, or parent 1 on unborn HEAD) and working tree
 * (the snapshot commit tree itself), including untracked files. Does not alter HEAD,
 * the user's branch, the index, or the working tree.
 */
export function createSnapshot(repo, jobId = "manual", hintFiles = []) {
  git(repo, ["rev-parse", "--is-inside-work-tree"]);
  let headSha = null;
  try { headSha = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim() || null; } catch {}

  const indexTree = git(repo, ["write-tree"]).trim();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-snap-"));
  const tmpIndex = path.join(tmpDir, "index");
  const idxEnv = gitEnv({ GIT_INDEX_FILE: tmpIndex });
  let worktreeTree;
  try {
    git(repo, ["read-tree", indexTree], { env: idxEnv });
    git(repo, ["add", "-A", "--", "."], { env: idxEnv });
    for (const rel of hintFiles || []) {
      try {
        const norm = String(rel || "").replace(/\\/g, "/");
        if (!norm || norm.startsWith(".tokenwise-studio/")) continue;
        const abs = safeRepoPath(repo, norm);
        const st = fs.lstatSync(abs);
        if (!st.isDirectory()) git(repo, ["add", "-f", "--", norm], { env: idxEnv });
      } catch {}
    }
    worktreeTree = git(repo, ["write-tree"], { env: idxEnv }).trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const env = gitEnv();
  const iArgs = ["commit-tree", indexTree, ...(headSha ? ["-p", headSha] : []), "-m", `tokenwise pre-apply index (${jobId})`];
  const indexCommit = git(repo, iArgs, { env }).trim();
  const wArgs = ["commit-tree", worktreeTree, ...(headSha ? ["-p", headSha] : []), "-p", indexCommit, "-m", `tokenwise pre-apply snapshot (${jobId})`];
  const worktreeCommit = git(repo, wArgs, { env }).trim();

  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const safeId = String(jobId || "manual").replace(/[^a-zA-Z0-9._-]/g, "_") || "manual";
  let ref = `${SNAPSHOT_PREFIX}${ts}-${safeId}`;
  let seq = 1;
  while (true) {
    try {
      git(repo, ["rev-parse", "--verify", "--quiet", ref]);
      seq += 1;
      ref = `${SNAPSHOT_PREFIX}${ts}-${safeId}-${seq}`;
    } catch {
      break;
    }
  }
  git(repo, ["update-ref", ref, worktreeCommit]);
  pruneSnapshots(repo, MAX_SNAPSHOTS);
  return { ref, commit: worktreeCommit, indexCommit };
}

function removeEmptyParents(repo, absFile) {
  const root = path.resolve(repo);
  let dir = path.dirname(absFile);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}

/**
 * Restore the exact files touched by an applied job back to its pre-apply snapshot
 * (both index and working tree). Refuses with a clear error listing changed files
 * if any of those files changed since the apply.
 */
export function restoreSnapshot(repo, job) {
  if (job.status !== "merged") throw new Error(`job is ${job.status}; only applied jobs can be undone`);
  const ref = job.applySnapshot;
  if (!ref) throw new Error("no pre-apply snapshot recorded for this job");

  let worktreeCommit;
  try {
    worktreeCommit = git(repo, ["rev-parse", "--verify", "--quiet", ref]).trim();
  } catch {
    throw new Error("pre-apply snapshot no longer exists");
  }
  if (!worktreeCommit) throw new Error("pre-apply snapshot no longer exists");

  const parents = git(repo, ["rev-list", "--no-walk", "--parents", worktreeCommit]).trim().split(/\s+/).slice(1);
  if (!parents.length) throw new Error("pre-apply snapshot is missing index state");
  const indexCommit = parents[parents.length - 1];

  const touched = Array.isArray(job.applied) ? job.applied : [];
  if (job.applyPost && touched.length) {
    const current = captureFileStates(repo, touched);
    const modified = touched.filter((p) => JSON.stringify(current[p]) !== JSON.stringify(job.applyPost[p]));
    if (modified.length) {
      throw new Error(`cannot undo apply: ${modified.length === 1 ? "file changed" : "files changed"} since apply: ${modified.join(", ")}`);
    }
  }

  for (const rel of touched) {
    const abs = safeRepoPath(repo, rel);
    const wt = lsTreeEntry(repo, worktreeCommit, rel);
    if (wt) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try { if (fs.lstatSync(abs).isSymbolicLink()) fs.unlinkSync(abs); } catch {}
      if (wt.mode === "120000") {
        const target = gitBuf(repo, ["cat-file", "blob", wt.sha]).toString("utf8");
        try { fs.unlinkSync(abs); } catch {}
        fs.symlinkSync(target, abs);
      } else {
        const buf = gitBuf(repo, ["cat-file", "blob", wt.sha]);
        fs.writeFileSync(abs, buf);
        fs.chmodSync(abs, wt.mode === "100755" ? 0o755 : 0o644);
      }
    } else {
      fs.rmSync(abs, { force: true });
      removeEmptyParents(repo, abs);
    }

    const idx = lsTreeEntry(repo, indexCommit, rel);
    if (idx) {
      git(repo, ["update-index", "--add", "--cacheinfo", `${idx.mode},${idx.sha},${rel}`]);
    } else {
      git(repo, ["update-index", "--force-remove", "--", rel]);
    }
  }

  if (touched.length) {
    try { git(repo, ["update-index", "--refresh", "-q", "--", ...touched]); } catch {}
  }
  return { ref, restored: touched };
}
