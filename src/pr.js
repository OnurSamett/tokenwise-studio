// Create a branch, commit staged work, push to origin, and open a GitHub PR via `gh`.
// Every subprocess runs via execFile with argument arrays (never a shell).
import { execFile } from "./process.js";
import { createSnapshot } from "./snapshots.js";
import { agentLabel } from "./notify.js";

const TR_MAP = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u" };

export function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout || "";
        err.stderr = stderr || "";
        return reject(err);
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

export function slugOfMessage(message, maxLen = 48) {
  const firstLine = String(message || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const ascii = firstLine
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (ch) => TR_MAP[ch] || ch)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "changes";
}

export function defaultBranchName(message) {
  return `tokenwise/${slugOfMessage(message)}`;
}

/** Parse a GitHub remote URL (https or ssh) without exposing credentials or local paths. */
export function parseGitHubRemote(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;
  let host = "", owner = "", repo = "";

  // git@github.com:owner/repo.git
  const scp = raw.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (scp) {
    [, host, owner, repo] = scp;
  } else {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" && u.protocol !== "http:" && u.protocol !== "ssh:") return null;
      host = u.hostname;
      const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (parts.length !== 2) return null;
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, "");
    } catch {
      return null;
    }
  }

  if (!host || !owner || !repo) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const lcHost = host.toLowerCase();
  if (lcHost !== "github.com" && !lcHost.endsWith(".ghe.com") && !lcHost.startsWith("github.")) return null;
  const proto = raw.startsWith("http://") ? "http:" : "https:";
  return { host: lcHost, owner, repo, baseUrl: `${proto}//${lcHost}/${owner}/${repo}` };
}

export function buildCompareUrl(remoteUrl, baseBranch, headBranch) {
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed || !headBranch) return null;
  const head = encodeURIComponent(headBranch);
  const spec = baseBranch ? `${encodeURIComponent(baseBranch)}...${head}` : head;
  return `${parsed.baseUrl}/compare/${spec}?expand=1`;
}

export function sanitizeHttpUrl(raw) {
  const match = String(raw || "").match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return null;
  try {
    const u = new URL(match[0]);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function selectAppliedJobs(jobsList, stagedFiles = [], jobIds = null) {
  const list = Array.isArray(jobsList) ? jobsList : [];
  const merged = list.filter((j) => j && j.status === "merged" && !j.committedAt);
  if (Array.isArray(jobIds) && jobIds.length) {
    const wanted = new Set(jobIds);
    return merged.filter((j) => wanted.has(j.id));
  }
  if (Array.isArray(stagedFiles) && stagedFiles.length) {
    const stagedSet = new Set(stagedFiles);
    return merged.filter((j) => {
      const touched = Array.isArray(j.applied) && j.applied.length ? j.applied : (j.files || []);
      return touched.some((f) => stagedSet.has(f));
    });
  }
  return merged;
}

/** Short safe attribution string, e.g. "Changes by: Codex Sol (2 jobs), Claude Haiku (1 job)". */
export function formatChangesBy(jobsList) {
  const counts = new Map();
  for (const j of jobsList || []) {
    if (!j || !j.agent) continue;
    const label = agentLabel(j.agent, j.model);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  if (!counts.size) return "";
  const parts = [];
  for (const [label, n] of counts) {
    parts.push(`${label} (${n} ${n === 1 ? "job" : "jobs"})`);
  }
  return `Changes by: ${parts.join(", ")}`;
}

/** Build PR title and body strictly from commit message + job attribution (never paths, secrets, or chat content). */
export function buildPrPayload({ message, jobs = [] }) {
  const lines = String(message || "").trim().split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  const title = firstIdx >= 0 ? lines[firstIdx].trim() : "";
  const msgBody = firstIdx >= 0 ? lines.slice(firstIdx + 1).join("\n").trim() : "";
  const changesBy = formatChangesBy(jobs);
  const body = [msgBody, changesBy].filter(Boolean).join("\n\n") || title;
  return { title, body, changesBy };
}

export async function checkGhStatus(repo, exec = defaultExec) {
  try {
    await exec("gh", ["auth", "status"], { cwd: repo, timeout: 8000 });
    return { installed: true, authenticated: true };
  } catch (e) {
    if (e?.code === "ENOENT") return { installed: false, authenticated: false };
    return { installed: true, authenticated: false };
  }
}

async function gitOut(repo, args, exec, opts = {}) {
  const res = await exec("git", ["-C", repo, ...args], { cwd: repo, timeout: 10_000, ...opts });
  return String(res?.stdout || "");
}

export async function prPreconditions(repo, { exec = defaultExec } = {}) {
  let isGit = false;
  try {
    const out = await gitOut(repo, ["rev-parse", "--is-inside-work-tree"], exec);
    isGit = out.trim() === "true";
  } catch {
    isGit = false;
  }

  let stagedFiles = [];
  let currentBranch = null;
  let detached = false;
  let hasHead = false;
  let hasOrigin = false;
  let originUrl = null;

  if (isGit) {
    try {
      stagedFiles = (await gitOut(repo, ["diff", "--cached", "--name-only"], exec))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {}

    try {
      await gitOut(repo, ["rev-parse", "--verify", "-q", "HEAD"], exec);
      hasHead = true;
    } catch {
      hasHead = false;
    }

    try {
      const b = (await gitOut(repo, ["symbolic-ref", "--short", "-q", "HEAD"], exec)).trim();
      if (b) currentBranch = b;
    } catch {
      if (hasHead) detached = true;
    }

    try {
      const u = (await gitOut(repo, ["remote", "get-url", "origin"], exec)).trim();
      if (u) { hasOrigin = true; originUrl = u; }
    } catch {}
  }

  const gh = await checkGhStatus(repo, exec);
  const ghParsed = originUrl ? parseGitHubRemote(originUrl) : null;
  const ghReady = gh.installed && gh.authenticated;
  const canPush = isGit && stagedFiles.length > 0 && !detached && hasHead && hasOrigin;

  return {
    isGit,
    stagedFiles,
    hasStaged: stagedFiles.length > 0,
    currentBranch,
    detached,
    hasHead,
    hasOrigin,
    originHost: ghParsed?.host || null,
    isGitHubOrigin: !!ghParsed,
    ghInstalled: gh.installed,
    ghAuthenticated: gh.authenticated,
    ghReady,
    canPush,
    canOpenPr: canPush && ghReady,
  };
}

export async function commitAndOpenPr({
  repo,
  message,
  branch,
  returnToOriginal = false,
  jobs = null,
  jobIds = null,
  exec = defaultExec,
} = {}) {
  const msg = String(message || "").trim();
  if (!msg) throw new Error("commit message is empty");

  const pre = await prPreconditions(repo, { exec });
  if (!pre.isGit) throw new Error("not a git repository");
  if (!pre.hasStaged) throw new Error("nothing is staged");
  if (pre.detached || !pre.currentBranch) throw new Error("cannot create a PR branch from detached HEAD");
  if (!pre.hasHead) throw new Error("repository has no commits yet");
  if (!pre.hasOrigin) throw new Error("git remote 'origin' does not exist");

  const originalBranch = pre.currentBranch;
  const branchName = String(branch || "").trim() || defaultBranchName(msg);
  if (branchName.startsWith("-")) throw new Error("invalid branch name");
  try {
    await exec("git", ["check-ref-format", "--branch", branchName], { cwd: repo, timeout: 5000 });
  } catch {
    throw new Error(`invalid branch name: ${branchName}`);
  }
  if (branchName === originalBranch) throw new Error("new branch must differ from current branch");

  let exists = false;
  try {
    await gitOut(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], exec);
    exists = true;
  } catch {}
  if (exists) throw new Error(`branch already exists: ${branchName}`);

  const jobsList = jobs ? (typeof jobs.list === "function" ? jobs.list() : jobs) : [];
  const appliedJobs = selectAppliedJobs(jobsList, pre.stagedFiles, jobIds);

  createSnapshot(repo, "commit", pre.stagedFiles);

  await gitOut(repo, ["checkout", "-b", branchName], exec);
  try {
    await gitOut(repo, ["commit", "-m", msg], exec);
  } catch (e) {
    try { await gitOut(repo, ["checkout", originalBranch], exec); } catch {}
    try { await gitOut(repo, ["branch", "-D", branchName], exec); } catch {}
    throw e;
  }

  const sha = (await gitOut(repo, ["rev-parse", "--short", "HEAD"], exec)).trim();

  if (jobs && typeof jobs.save === "function") {
    const now = new Date().toISOString();
    for (const j of appliedJobs) {
      try { jobs.save({ ...j, committedAt: now }); } catch {}
    }
  }

  try {
    await gitOut(repo, ["push", "-u", "origin", branchName], exec, { timeout: 60_000 });
  } catch (e) {
    if (returnToOriginal) {
      try { await gitOut(repo, ["checkout", originalBranch], exec); } catch {}
    }
    const err = new Error(`git push failed: ${e?.stderr?.trim() || e?.message || e}`);
    err.details = {
      committed: true,
      pushed: false,
      branch: branchName,
      sha,
      currentBranch: returnToOriginal ? originalBranch : branchName,
    };
    throw err;
  }

  const originUrl = (await gitOut(repo, ["remote", "get-url", "origin"], exec)).trim();
  const compareUrl = buildCompareUrl(originUrl, originalBranch, branchName);
  const { title, body, changesBy } = buildPrPayload({ message: msg, jobs: appliedJobs });

  let prUrl = null;
  let prError = null;
  if (pre.ghReady) {
    try {
      const ghRes = await exec(
        "gh",
        ["pr", "create", "--head", branchName, "--title", title, "--body", body],
        { cwd: repo, timeout: 60_000 },
      );
      prUrl = sanitizeHttpUrl(`${ghRes?.stdout || ""}\n${ghRes?.stderr || ""}`);
      if (!prUrl) prError = "gh pr create did not return a pull request URL";
    } catch (e) {
      prError = e?.stderr?.trim() || e?.message || String(e);
    }
  }

  if (returnToOriginal) {
    await gitOut(repo, ["checkout", originalBranch], exec);
  }
  const currentBranch = returnToOriginal ? originalBranch : branchName;

  if (prError) {
    const err = new Error(`gh pr create failed: ${prError}`);
    err.details = {
      committed: true,
      pushed: true,
      branch: branchName,
      sha,
      originalBranch,
      currentBranch,
      returned: Boolean(returnToOriginal),
      compareUrl,
    };
    throw err;
  }

  return {
    ok: true,
    mode: "pr",
    sha,
    files: pre.stagedFiles.length,
    branch: branchName,
    originalBranch,
    currentBranch,
    returned: Boolean(returnToOriginal),
    pushed: true,
    ghAvailable: pre.ghReady,
    prUrl,
    compareUrl,
    changesBy,
  };
}
