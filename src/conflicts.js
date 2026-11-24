// Conflict detection and resolution helpers for write jobs before Apply (merge).
// Uses git plumbing against a temporary GIT_INDEX_FILE so checks never modify
// the user's working tree, real index, branch, or HEAD.
import { execFileSync, addUntrustedDir } from "./process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DETAIL_CHARS = 500;
const MAX_HUNKS_CHARS = 12000;

const git = (cwd, args, opts = {}) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });

function unquoteGitPath(raw) {
  if (!raw || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(1, -1);
  }
}

/** Split a unified git diff into a map of repo-relative file path -> { patch, isNew, isBinary }. */
export function extractFilePatches(rawDiff) {
  const map = new Map();
  if (!rawDiff) return map;
  const parts = rawDiff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git"));
  for (const patch of parts) {
    let filePath = null;
    const plusMatch = patch.match(/^\+\+\+ b\/(.+)$/m);
    const minusMatch = patch.match(/^--- a\/(.+)$/m);
    if (plusMatch) {
      filePath = unquoteGitPath(plusMatch[1].trim());
    } else if (/^\+\+\+ \/dev\/null$/m.test(patch) && minusMatch) {
      filePath = unquoteGitPath(minusMatch[1].trim());
    } else {
      const header = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      if (header) filePath = unquoteGitPath(header[2].trim());
    }
    if (!filePath) continue;
    const isNew = /^new file mode /m.test(patch);
    const isBinary = /^GIT binary patch$|^Binary files /m.test(patch);
    map.set(filePath, { patch, isNew, isBinary });
  }
  return map;
}

function classifyApplyError(errText) {
  const s = String(errText || "");
  if (/with conflicts/i.test(s) || /^U\s+/m.test(s)) return "conflict";
  if (/already exists in (?:index|working directory)/i.test(s)) return "exists";
  if (/does not exist in index/i.test(s)) return "missing";
  if (/binary/i.test(s)) return "binary";
  return "apply_failed";
}

function trimDetail(err) {
  const msg = String(err?.stderr || err?.message || err || "").trim();
  return msg.length > MAX_DETAIL_CHARS ? msg.slice(0, MAX_DETAIL_CHARS - 1) + "…" : msg;
}

function existsOnDisk(repo, rel) {
  try {
    fs.lstatSync(path.join(repo, rel));
    return true;
  } catch {
    return false;
  }
}

function unmergedInIndex(repo, env) {
  try {
    const out = git(repo, ["ls-files", "-u", "-z"], { env });
    const set = new Set();
    for (const rec of out.split("\0").filter(Boolean)) {
      const tab = rec.indexOf("\t");
      if (tab >= 0) set.add(rec.slice(tab + 1));
    }
    return set;
  } catch {
    return new Set();
  }
}

function checkApplyCleanly(repo, diffPath, files, patchMap) {
  const results = new Map();
  for (const f of files) results.set(f, { appliesCleanly: true, reason: null, detail: null });

  if (!files.length || !fs.existsSync(diffPath) || fs.statSync(diffPath).size === 0) {
    return results;
  }

  // Detect unstaged working-tree edits/deletions for touched files (`git apply --3way` implies `--index`).
  const unstagedSet = new Set();
  try {
    const df = git(repo, ["diff-files", "-z", "--name-only", "--", ...files]);
    for (const f of df.split("\0").filter(Boolean)) unstagedSet.add(f);
  } catch {}

  // Detect untracked files on disk that would collide with new files created by the patch.
  const newFiles = files.filter((f) => patchMap.get(f)?.isNew);
  const untrackedCollisions = new Set();
  if (newFiles.length) {
    const trackedSet = new Set();
    try {
      const ls = git(repo, ["ls-files", "-z", "--", ...newFiles]);
      for (const f of ls.split("\0").filter(Boolean)) trackedSet.add(f);
    } catch {}
    for (const f of newFiles) {
      if (!trackedSet.has(f) && existsOnDisk(repo, f)) untrackedCollisions.add(f);
    }
  }

  let indexTree;
  try {
    indexTree = git(repo, ["write-tree"]).trim();
  } catch (e) {
    const unmerged = unmergedInIndex(repo);
    const detail = trimDetail(e) || "index has unresolved conflicts";
    for (const f of files) {
      if (unmerged.size === 0 || unmerged.has(f)) {
        results.set(f, { appliesCleanly: false, reason: "conflict", detail });
      }
    }
    return results;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-chk-"));
  const tmpIdx = path.join(tmpDir, "index");
  const idxEnv = { ...process.env, GIT_INDEX_FILE: tmpIdx };

  try {
    // Fast path: when no working-tree divergence or untracked collisions exist, try the whole selection at once.
    if (unstagedSet.size === 0 && untrackedCollisions.size === 0) {
      git(repo, ["read-tree", indexTree], { env: idxEnv });
      const includeArgs = files.flatMap((f) => ["--include", f]);
      try {
        git(repo, ["apply", "--cached", "--3way", "--whitespace=nowarn", ...includeArgs, diffPath], { env: idxEnv });
        if (unmergedInIndex(repo, idxEnv).size === 0) return results;
      } catch {
        // Fall through to per-file check to classify each file accurately.
      }
    }

    for (const f of files) {
      if (unstagedSet.has(f)) {
        results.set(f, {
          appliesCleanly: false,
          reason: "unstaged",
          detail: `${f}: working tree has unstaged changes that do not match the index`,
        });
        continue;
      }
      if (untrackedCollisions.has(f)) {
        results.set(f, {
          appliesCleanly: false,
          reason: "exists",
          detail: `${f}: already exists in working directory`,
        });
        continue;
      }
      git(repo, ["read-tree", indexTree], { env: idxEnv });
      try {
        git(repo, ["apply", "--cached", "--3way", "--whitespace=nowarn", "--include", f, diffPath], { env: idxEnv });
        if (unmergedInIndex(repo, idxEnv).has(f)) {
          results.set(f, {
            appliesCleanly: false,
            reason: "conflict",
            detail: `Applied patch to '${f}' with conflicts.`,
          });
        }
      } catch (e) {
        const detail = trimDetail(e);
        results.set(f, {
          appliesCleanly: false,
          reason: classifyApplyError(detail),
          detail,
        });
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return results;
}

/**
 * Inspect conflicts for a write job before Apply:
 * (a) files also touched by other finished-but-unapplied write jobs,
 * (b) whether each file's diff still applies cleanly to the current working tree and index.
 */
export function checkJobConflicts(jobs, jobOrId, { files } = {}) {
  const j = typeof jobOrId === "string" ? jobs.get(jobOrId) : jobOrId;
  const targetFiles = Array.isArray(files) && files.length ? files : (j.files || []);
  const empty = { ok: true, clean: true, overlaps: [], applyConflicts: [], files: {} };
  if (!j || !j.write || j.status !== "done" || !targetFiles.length || !jobs.isGit()) {
    return empty;
  }

  const others = jobs.list().filter(
    (o) => o.id !== j.id && o.write && o.status === "done" && Array.isArray(o.files) && o.files.length > 0
      && !(j.shootout && o.shootout === j.shootout)
  );

  const diffPath = jobs.file(j.id, "diff");
  const rawDiff = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, "utf8") : "";
  const patchMap = extractFilePatches(rawDiff);
  const applyStatus = checkApplyCleanly(jobs.repo, diffPath, targetFiles, patchMap);

  const overlaps = [];
  const applyConflicts = [];
  const fileMap = {};

  for (const f of targetFiles) {
    const alsoChangedBy = [];
    for (const o of others) {
      if ((o.files || []).includes(f)) {
        alsoChangedBy.push({ id: o.id, agent: o.agent, model: o.model, title: o.title });
      }
    }
    if (alsoChangedBy.length) overlaps.push({ file: f, jobs: alsoChangedBy });

    const ap = applyStatus.get(f) || { appliesCleanly: true, reason: null, detail: null };
    if (!ap.appliesCleanly) {
      applyConflicts.push({ file: f, reason: ap.reason, detail: ap.detail });
    }

    fileMap[f] = {
      status: !ap.appliesCleanly ? "conflict" : alsoChangedBy.length ? "overlap" : "ok",
      appliesCleanly: ap.appliesCleanly,
      reason: ap.reason,
      detail: ap.detail,
      alsoChangedBy,
    };
  }

  return {
    ok: overlaps.length === 0 && applyConflicts.length === 0,
    clean: applyConflicts.length === 0,
    overlaps,
    applyConflicts,
    files: fileMap,
  };
}

function extractConflictHunksFromText(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const start = Math.max(0, i - 3);
      let end = i + 1;
      while (end < lines.length && !lines[end].startsWith(">>>>>>>")) end++;
      end = Math.min(lines.length, end + 4);
      blocks.push(lines.slice(start, end).join("\n"));
      i = end;
    } else {
      i++;
    }
  }
  return blocks.join("\n...\n");
}

function formatPatchHunks(patchEntry) {
  if (!patchEntry) return "";
  if (patchEntry.isBinary) return "(binary file diff)";
  const lines = patchEntry.patch.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("@@"));
  return idx >= 0 ? lines.slice(idx).join("\n").trim() : patchEntry.patch.trim();
}

function parseFailedFilesFromError(errText, knownFiles) {
  const found = new Set();
  const text = String(errText || "");
  for (const m of text.matchAll(/Applied patch to '([^']+)' with conflicts/g)) found.add(m[1]);
  for (const m of text.matchAll(/^U\s+(.+)$/gm)) found.add(m[1].trim());
  for (const m of text.matchAll(/^(?:error|patch failed):\s*([^:\n]+):/gm)) {
    const p = m[1].trim();
    if (knownFiles.includes(p)) found.add(p);
  }
  return [...found];
}

/**
 * Re-run a job's diff with `git apply --3way` into a fresh worktree from current HEAD.
 * If it succeeds, swaps the job to the new worktree/branch and refreshes its diff.
 * If it fails, cleans up the temporary worktree and returns the conflicting files and failed hunks.
 */
export function rebaseJob(jobs, id, { artifacts = [], onImages } = {}) {
  const j = jobs.get(id);
  if (!j.write) throw new Error("read-only job: nothing to rebase");
  if (j.status !== "done") throw new Error(`job is ${j.status}; only finished jobs can be rebased`);
  if (!jobs.isGit()) throw new Error("rebase needs the project to be a git repository");

  const diffPath = jobs.file(id, "diff");
  const rawDiff = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, "utf8") : "";
  if (!rawDiff.trim()) {
    return { ok: true, rebased: false, job: j, conflicts: checkJobConflicts(jobs, j) };
  }

  const suffix = `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const newCwd = path.join(jobs.home, "worktrees", `${id}-${suffix}`);
  addUntrustedDir(newCwd);
  const newBranch = `tokenwise/${id}-${suffix}`;
  git(jobs.repo, ["worktree", "add", "-q", "-b", newBranch, newCwd, "HEAD"]);

  try {
    git(newCwd, ["apply", "--3way", "--whitespace=nowarn", diffPath]);
  } catch (e) {
    const errText = String(e?.stderr || e?.message || "");
    const unmerged = unmergedInIndex(newCwd);
    const parsed = parseFailedFilesFromError(errText, j.files || []);
    const conflictCheck = checkJobConflicts(jobs, j);
    const fallbackFiles = conflictCheck.applyConflicts.map((c) => c.file);
    const conflictingFiles = [...new Set([...unmerged, ...parsed])];
    if (!conflictingFiles.length) {
      conflictingFiles.push(...(fallbackFiles.length ? fallbackFiles : (j.files || [])));
    }

    const patchMap = extractFilePatches(rawDiff);
    const failedHunks = conflictingFiles.map((file) => {
      let conflictMarkers = "";
      try {
        const abs = path.join(newCwd, file);
        if (fs.existsSync(abs) && !patchMap.get(file)?.isBinary) {
          conflictMarkers = extractConflictHunksFromText(fs.readFileSync(abs, "utf8"));
        }
      } catch {}
      return {
        file,
        hunks: formatPatchHunks(patchMap.get(file)),
        ...(conflictMarkers ? { conflictMarkers } : {}),
      };
    });

    try { git(jobs.repo, ["worktree", "remove", "--force", newCwd]); } catch {}
    try { git(jobs.repo, ["branch", "-D", newBranch]); } catch {}

    return {
      ok: false,
      rebased: false,
      job: j,
      conflictingFiles,
      failedHunks,
      error: trimDetail(errText),
      conflicts: conflictCheck,
    };
  }

  // Rebase succeeded in newCwd: re-stage, refresh diff/files, and swap worktree/branch.
  try {
    git(newCwd, ["add", "-A", "--", ".", ...artifacts.map((x) => `:(exclude,glob)${x}`)]);
    j.diffStat = git(newCwd, ["diff", "--cached", "--stat", "HEAD"]).trim() || "(no changes)";
    j.files = git(newCwd, ["diff", "--cached", "--no-renames", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    fs.writeFileSync(diffPath, git(newCwd, ["diff", "--cached", "--no-renames", "--binary", "HEAD"]));
  } catch (e) {
    j.diffStat = "diff failed: " + e.message;
  }

  const oldCwd = j.cwd;
  const oldBranch = j.branch;
  j.cwd = newCwd;
  j.branch = newBranch;
  if (typeof onImages === "function") {
    try { j.images = onImages(j); } catch {}
  }
  const saved = jobs.save(j);

  // The old worktree/branch come from the job file: only remove them if Studio created them for this job.
  if (oldCwd && oldCwd !== newCwd) jobs.removeWorktree(j.id, oldCwd, oldBranch, { force: true });

  return {
    ok: true,
    rebased: true,
    job: saved,
    conflicts: checkJobConflicts(jobs, saved),
  };
}

/**
 * Start a follow-up write job for the same agent with the conflicting files
 * and failed hunks in its task so the worker can resolve them on current HEAD.
 */
export function resolveJobConflicts(jobs, id, { conflictingFiles, failedHunks } = {}) {
  const j = jobs.get(id);
  if (!j.write) throw new Error("read-only job: nothing to resolve");
  if (j.status !== "done") throw new Error(`job is ${j.status}; only finished jobs can be resolved`);

  const diffPath = jobs.file(id, "diff");
  const rawDiff = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, "utf8") : "";
  const patchMap = extractFilePatches(rawDiff);

  let files = Array.isArray(conflictingFiles) && conflictingFiles.length ? conflictingFiles : null;
  if (!files) {
    const c = checkJobConflicts(jobs, j);
    files = c.applyConflicts.map((x) => x.file);
    if (!files.length) files = j.files || [];
  }

  let hunksList = Array.isArray(failedHunks) && failedHunks.length ? failedHunks : null;
  if (!hunksList) {
    hunksList = files.map((file) => ({
      file,
      hunks: formatPatchHunks(patchMap.get(file)),
    }));
  }

  let hunkText = hunksList
    .map((item) => {
      const parts = [`### ${item.file}`];
      if (item.hunks) parts.push("Original diff hunks:\n```diff\n" + item.hunks + "\n```");
      if (item.conflictMarkers) parts.push("Conflict markers:\n```\n" + item.conflictMarkers + "\n```");
      return parts.join("\n");
    })
    .join("\n\n");

  if (hunkText.length > MAX_HUNKS_CHARS) {
    hunkText = hunkText.slice(0, MAX_HUNKS_CHARS) + "\n\n...(truncated)";
  }

  const task = [
    "Resolve merge/apply conflicts for a previous worker job on the current HEAD.",
    "",
    "Original task:",
    j.task,
    "",
    "Conflicting files:",
    files.map((f) => `- ${f}`).join("\n"),
    "",
    "Failed hunks to re-apply cleanly to the current files in this worktree:",
    hunkText || "(no hunks available)",
  ].join("\n");

  const uploadImages = (j.images || [])
    .map((x) => (typeof x === "string" ? x : x?.path))
    .filter((p) => typeof p === "string" && p.startsWith(".tokenwise-studio/uploads/"));

  return jobs.start({
    agent: j.agent,
    model: j.model,
    effort: j.effort,
    write: true,
    role: j.role || null,
    parent: j.parent || null,
    title: `Resolve: ${j.title}`.slice(0, 80),
    task,
    images: uploadImages,
    noFallback: true,
    skipFixDetect: true,
  });
}
