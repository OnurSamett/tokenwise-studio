// Model shootout: send the same write task to 2-3 workers in parallel worktrees,
// compare results side by side, pick one to apply (with Undo Apply), and discard the rest.
import fs from "node:fs";
import path from "node:path";
import { resolve } from "./workers.js";
import { loadTeam } from "./team.js";
import { loadSettings } from "./settings.js";
import { validateImages } from "./uploads.js";
import { splitDiff } from "./workspace.js";
import { usageOf } from "./usage.js";
import { testCommandFor } from "./testrun.js";

export const SHOOTOUT_TTL_MS = 24 * 60 * 60 * 1000; // 24h auto-discard for unchosen worktrees
export const MIN_SHOOTOUT_WORKERS = 2;
export const MAX_SHOOTOUT_WORKERS = 3;

const SAFE_ID = /^so-[\w-]+$/;
const assertSafeId = (id) => {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error(`invalid shootout id '${id}'`);
};

export const shootoutsDir = (home) => path.join(home, "shootouts");
export const shootoutFile = (home, id) => {
  assertSafeId(id);
  return path.join(shootoutsDir(home), `${id}.json`);
};

export function loadShootout(home, id) {
  try {
    return JSON.parse(fs.readFileSync(shootoutFile(home, id), "utf8"));
  } catch {
    return null;
  }
}

export function saveShootout(home, data) {
  assertSafeId(data?.id);
  fs.mkdirSync(shootoutsDir(home), { recursive: true });
  const f = shootoutFile(home, data.id);
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
  return data;
}

// ---- Per-turn MCP shootout gate ----
export const shootoutGateFile = (home, chatId) => path.join(home, "chats", `${chatId}.shootout`);

export function readShootoutGate(home, chatId) {
  if (!home || !chatId) return null;
  try {
    return JSON.parse(fs.readFileSync(shootoutGateFile(home, chatId), "utf8"));
  } catch {
    return null;
  }
}

export function writeShootoutGate(home, chatId, state) {
  if (!home || !chatId) return null;
  const f = shootoutGateFile(home, chatId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const payload = {
    turn: state?.turn ?? 0,
    started: state?.started || new Date().toISOString(),
    allowed: !!state?.allowed,
    groups: state?.groups && typeof state.groups === "object" ? state.groups : {},
  };
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, f);
  return payload;
}

export function clearShootoutGate(home, chatId, turn = null) {
  if (!home || !chatId) return;
  const cur = readShootoutGate(home, chatId);
  if (!cur) return;
  if (turn !== null && cur.turn !== turn) return;
  writeShootoutGate(home, chatId, { ...cur, allowed: false });
}

function newShootoutId(now = Date.now()) {
  const ts = new Date(now).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `so-${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Validate and resolve a canonical shootout id for an MCP delegate(..., shootout) call.
 * Only succeeds when the UI explicitly enabled shootout for the current chat turn.
 */
export function resolveTurnShootoutId(home, chatId, key, { title = "", task = "" } = {}) {
  if (!chatId) {
    throw new Error("shootout is only allowed when the user asked for it in the current chat message");
  }
  const gate = readShootoutGate(home, chatId);
  if (!gate || gate.allowed !== true) {
    throw new Error("shootout is only allowed when the user asked for it in this message");
  }
  const normKey = key === true ? "default" : String(key || "").trim();
  if (!normKey || normKey.length > 80) {
    throw new Error("shootout parameter must be true or a short group name (1-80 chars)");
  }
  const groups = { ...(gate.groups || {}) };
  let id = groups[normKey];
  if (!id || !SAFE_ID.test(id)) {
    id = newShootoutId();
    groups[normKey] = id;
    writeShootoutGate(home, chatId, { ...gate, groups });
  }
  if (!loadShootout(home, id)) {
    const now = Date.now();
    saveShootout(home, {
      id,
      title: title || String(task || "").slice(0, 80) || "Model shootout",
      task: String(task || ""),
      parent: chatId,
      created: new Date(now).toISOString(),
      expiresAt: new Date(now + SHOOTOUT_TTL_MS).toISOString(),
      pickedJobId: null,
      pickedAt: null,
      discardedAt: null,
      expiredAt: null,
      jobIds: [],
    });
  }
  return id;
}

/** Ensure a job started with `shootout` is recorded in its shootout metadata. */
export function registerShootoutJob(home, shootoutId, job) {
  if (!shootoutId) return null;
  assertSafeId(shootoutId);
  const existing = loadShootout(home, shootoutId);
  const created = existing?.created || job.created || new Date().toISOString();
  const createdMs = Date.parse(created) || Date.now();
  const jobIds = [...new Set([...(existing?.jobIds || []), job.id])];
  return saveShootout(home, {
    id: shootoutId,
    title: existing?.title || job.title || String(job.task || "").slice(0, 80) || "Model shootout",
    task: existing?.task || String(job.task || ""),
    parent: existing?.parent !== undefined ? existing.parent : (job.parent ?? null),
    created,
    expiresAt: existing?.expiresAt || new Date(createdMs + SHOOTOUT_TTL_MS).toISOString(),
    pickedJobId: existing?.pickedJobId || null,
    pickedAt: existing?.pickedAt || null,
    discardedAt: existing?.discardedAt || null,
    expiredAt: existing?.expiredAt || null,
    jobIds,
  });
}

/** Validate workers and start 2-3 parallel write jobs grouped as one shootout. */
export function startShootout(jobs, { task, workers, title = "", images = [], parent = null, timeoutMin = 20, skipFixDetect = true } = {}) {
  if (!jobs.isGit()) throw new Error("shootout mode needs the project to be a git repository");
  if (loadSettings().permissionMode === "plan-only") {
    throw new Error("write jobs are disabled in plan-only mode");
  }
  const cleanTask = String(task || "").trim();
  if (!cleanTask) throw new Error("task must not be empty");
  if (!Array.isArray(workers) || workers.length < MIN_SHOOTOUT_WORKERS || workers.length > MAX_SHOOTOUT_WORKERS) {
    throw new Error(`choose ${MIN_SHOOTOUT_WORKERS} to ${MAX_SHOOTOUT_WORKERS} workers for a model shootout`);
  }

  validateImages(jobs.repo, images);
  const team = loadTeam(jobs.home);
  const specs = workers.map((w) => {
    if (!w || typeof w !== "object") throw new Error("each worker must be an object");
    if (w.agent === "free" && team.allow.free === false) {
      throw new Error("free workers are disabled in the team settings");
    }
    return {
      agent: w.agent,
      model: w.model || undefined,
      effort: w.effort || undefined,
      spec: resolve({
        agent: w.agent,
        model: w.model || undefined,
        effort: w.effort || undefined,
        allowAstra: team.allow.astra === true,
      }),
    };
  });

  const now = Date.now();
  const id = newShootoutId(now);
  const cleanTitle = String(title || "").trim() || cleanTask.slice(0, 80);
  const meta = saveShootout(jobs.home, {
    id,
    title: cleanTitle,
    task: cleanTask,
    parent: parent ?? null,
    created: new Date(now).toISOString(),
    expiresAt: new Date(now + SHOOTOUT_TTL_MS).toISOString(),
    pickedJobId: null,
    pickedAt: null,
    discardedAt: null,
    expiredAt: null,
    jobIds: [],
  });

  const started = [];
  try {
    for (const w of specs) {
      const j = jobs.start({
        agent: w.agent,
        model: w.model,
        effort: w.effort,
        task: cleanTask,
        write: true,
        title: cleanTitle,
        images,
        parent: parent ?? null,
        timeoutMin,
        noFallback: true,
        skipFixDetect,
        shootout: id,
      });
      started.push(j);
    }
  } catch (err) {
    for (const j of started) {
      try { jobs.discard(j.id); } catch {}
    }
    try { fs.rmSync(shootoutFile(jobs.home, id), { force: true }); } catch {}
    throw err;
  }

  const saved = saveShootout(jobs.home, { ...meta, jobIds: started.map((j) => j.id) });
  return { shootout: saved, jobs: started };
}

function readAllShootoutFiles(home) {
  const dir = shootoutsDir(home);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^so-[\w-]+\.json$/.test(f)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {}
  }
  return out;
}

function groupShootoutRecords(jobs) {
  const allJobs = jobs.list();
  const byId = new Map();

  for (const meta of readAllShootoutFiles(jobs.home)) {
    if (!meta?.id || !SAFE_ID.test(meta.id)) continue;
    byId.set(meta.id, { meta, jobs: [] });
  }
  for (const j of allJobs) {
    if (!j.shootout) continue;
    let entry = byId.get(j.shootout);
    if (!entry) {
      const created = j.created || new Date().toISOString();
      const createdMs = Date.parse(created) || Date.now();
      entry = {
        meta: {
          id: j.shootout,
          title: j.title || String(j.task || "").slice(0, 80) || "Model shootout",
          task: String(j.task || ""),
          parent: j.parent ?? null,
          created,
          expiresAt: new Date(createdMs + SHOOTOUT_TTL_MS).toISOString(),
          pickedJobId: null,
          pickedAt: null,
          discardedAt: null,
          expiredAt: null,
          jobIds: [],
        },
        jobs: [],
      };
      byId.set(j.shootout, entry);
    }
    entry.jobs.push(j);
  }

  for (const entry of byId.values()) {
    const order = new Map((entry.meta.jobIds || []).map((id, idx) => [id, idx]));
    entry.jobs.sort((a, b) => {
      const ia = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
      const ib = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ia - ib || String(a.created || "").localeCompare(String(b.created || ""));
    });
  }
  return byId;
}

export function shootoutStatus(meta, groupJobs = []) {
  if (meta?.pickedJobId || groupJobs.some((j) => j.status === "merged" || j.status === "undone")) return "picked";
  if (groupJobs.some((j) => j.status === "running")) return "running";
  if (meta?.expiredAt) return "expired";
  if (groupJobs.some((j) => j.status === "done")) return "ready";
  if (meta?.discardedAt || (groupJobs.length && groupJobs.every((j) => j.status === "discarded"))) return "discarded";
  if (groupJobs.length && groupJobs.every((j) => ["failed", "discarded"].includes(j.status))) return "failed";
  return "ready";
}

export function listShootouts(jobs) {
  const grouped = groupShootoutRecords(jobs);
  const testConfigured = !!testCommandFor(jobs.home, jobs.repo);
  const out = [];
  for (const { meta, jobs: groupJobs } of grouped.values()) {
    if (!groupJobs.length && !meta.jobIds?.length) continue;
    const pickedJob = groupJobs.find((j) => j.id === meta.pickedJobId || j.status === "merged" || j.status === "undone") || null;
    out.push({
      ...meta,
      pickedJobId: meta.pickedJobId || pickedJob?.id || null,
      jobIds: groupJobs.length ? groupJobs.map((j) => j.id) : (meta.jobIds || []),
      status: shootoutStatus(meta, groupJobs),
      testConfigured,
      readyCount: groupJobs.filter((j) => j.status === "done").length,
      runningCount: groupJobs.filter((j) => j.status === "running").length,
      totalCount: groupJobs.length,
    });
  }
  return out.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
}

export function getShootout(jobs, id) {
  assertSafeId(id);
  const entry = groupShootoutRecords(jobs).get(id);
  if (!entry) throw new Error(`unknown shootout ${id}`);
  const { meta, jobs: groupJobs } = entry;
  const testCmd = testCommandFor(jobs.home, jobs.repo);
  const status = shootoutStatus(meta, groupJobs);
  const pickedJob = groupJobs.find((j) => j.id === meta.pickedJobId || j.status === "merged" || j.status === "undone") || null;

  const candidates = groupJobs.map((j) => {
    const files = j.write && j.status !== "running" ? splitDiff(jobs.diff(j.id)) : [];
    const additions = files.reduce((sum, f) => sum + (f.add || 0), 0);
    const deletions = files.reduce((sum, f) => sum + (f.del || 0), 0);
    let liveTokens = j.tokens || null;
    let liveCost = j.cost ?? null;
    if (j.status === "running") {
      try {
        const u = jobs.usage(j.id);
        if (u.tokens) liveTokens = u.tokens;
        if (typeof u.cost === "number") liveCost = u.cost;
      } catch {}
    }
    const usage = usageOf({ agent: j.agent, model: j.model, tokens: liveTokens, cost: liveCost });
    const conflicts = j.write && j.status === "done" ? jobs.conflicts(j.id) : null;
    const { test, applyPost, ...jobRest } = j;
    const cleanJob = {
      ...jobRest,
      tokens: liveTokens,
      cost: liveCost,
      ...(test ? { test: { ...test, tail: undefined } } : {}),
    };
    return {
      job: cleanJob,
      files,
      stats: {
        filesCount: (j.files || []).length || files.length,
        additions,
        deletions,
      },
      usage,
      conflicts,
    };
  });

  return {
    shootout: {
      ...meta,
      pickedJobId: meta.pickedJobId || pickedJob?.id || null,
      jobIds: groupJobs.map((j) => j.id),
      status,
    },
    testConfigured: !!testCmd,
    testCommand: testCmd ? testCmd.label : null,
    candidates,
  };
}

/** Apply the chosen shootout candidate (with pre-apply snapshot for Undo) and discard all others. */
export function pickShootout(jobs, shootoutId, jobId, { files, autoCheck = true } = {}) {
  assertSafeId(shootoutId);
  const entry = groupShootoutRecords(jobs).get(shootoutId);
  if (!entry) throw new Error(`unknown shootout ${shootoutId}`);
  const { meta, jobs: groupJobs } = entry;
  if (meta.pickedJobId || groupJobs.some((j) => j.status === "merged" || j.status === "undone")) {
    throw new Error("a winner was already picked for this shootout");
  }
  const target = groupJobs.find((j) => j.id === jobId);
  if (!target) throw new Error(`job ${jobId} is not part of shootout ${shootoutId}`);
  if (!target.write) throw new Error("read-only job cannot be picked");
  if (target.status !== "done") throw new Error(`job is ${target.status}; only finished jobs can be picked`);

  // Apply first — if it throws (e.g. working-tree conflict), the other candidates remain intact.
  const picked = jobs.merge(jobId, files, { autoCheck });

  const discardedIds = [];
  for (const other of groupJobs) {
    if (other.id === jobId) continue;
    if (other.status === "running" || other.status === "done") {
      jobs.discard(other.id);
      discardedIds.push(other.id);
    } else if (other.status === "failed") {
      jobs.cleanup(other);
      jobs.save({ ...jobs.get(other.id), discardedReason: "shootout_unchosen" });
      discardedIds.push(other.id);
    }
  }

  const now = new Date().toISOString();
  const shootout = saveShootout(jobs.home, {
    ...meta,
    jobIds: groupJobs.map((j) => j.id),
    pickedJobId: jobId,
    pickedAt: now,
  });

  return { shootout, picked, discardedIds };
}

/** Discard every job in a shootout and mark it discarded. */
export function discardShootout(jobs, shootoutId) {
  assertSafeId(shootoutId);
  const entry = groupShootoutRecords(jobs).get(shootoutId);
  if (!entry) throw new Error(`unknown shootout ${shootoutId}`);
  const { meta, jobs: groupJobs } = entry;
  if (meta.pickedJobId || groupJobs.some((j) => j.status === "merged")) {
    throw new Error("shootout already has a picked winner");
  }

  const discardedIds = [];
  for (const j of groupJobs) {
    if (j.status === "running" || j.status === "done") {
      jobs.discard(j.id);
      discardedIds.push(j.id);
    } else if (j.status === "failed") {
      jobs.cleanup(j);
      discardedIds.push(j.id);
    }
  }

  const shootout = saveShootout(jobs.home, {
    ...meta,
    jobIds: groupJobs.map((j) => j.id),
    discardedAt: new Date().toISOString(),
  });
  return { shootout, discardedIds };
}

/** Automatically discard unchosen shootout worktrees after 24h (or clean any leftover unchosen worktrees). */
export function pruneExpiredShootouts(jobs, { now = Date.now(), maxAgeMs = SHOOTOUT_TTL_MS } = {}) {
  const grouped = groupShootoutRecords(jobs);
  const prunedShootoutIds = [];
  const discardedJobIds = [];

  for (const { meta, jobs: groupJobs } of grouped.values()) {
    const pickedId = meta.pickedJobId || groupJobs.find((j) => j.status === "merged" || j.status === "undone")?.id || null;
    if (pickedId) {
      // Defensive: make sure no unchosen sibling worktree was left behind.
      for (const j of groupJobs) {
        if (j.id === pickedId) continue;
        if (j.status === "running" || j.status === "done") {
          try { jobs.discard(j.id); discardedJobIds.push(j.id); } catch {}
        } else if (j.cwd && fs.existsSync(j.cwd)) {
          try { jobs.cleanup(j); } catch {}
        }
      }
      continue;
    }

    if (meta.expiredAt || meta.discardedAt) continue;
    const hasActiveWorktree = groupJobs.some((j) => j.status === "running" || j.status === "done" || (j.status === "failed" && j.cwd && fs.existsSync(j.cwd)));
    if (!hasActiveWorktree) continue;

    const createdMs = Date.parse(meta.created || groupJobs[0]?.created || "");
    if (!Number.isFinite(createdMs)) continue;
    const expiresMs = maxAgeMs !== SHOOTOUT_TTL_MS
      ? createdMs + maxAgeMs
      : (Number.isFinite(Date.parse(meta.expiresAt)) ? Date.parse(meta.expiresAt) : createdMs + maxAgeMs);
    if (now < expiresMs) continue;

    for (const j of groupJobs) {
      if (j.status === "running" || j.status === "done") {
        try { jobs.discard(j.id); discardedJobIds.push(j.id); } catch {}
      } else if (j.status === "failed") {
        try { jobs.cleanup(j); } catch {}
      }
    }
    saveShootout(jobs.home, {
      ...meta,
      jobIds: groupJobs.map((j) => j.id),
      expiredAt: new Date(now).toISOString(),
    });
    prunedShootoutIds.push(meta.id);
  }

  return { prunedShootoutIds, discardedJobIds };
}
