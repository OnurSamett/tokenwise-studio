// Locate, copy, and verify Roblox Studio's built-in StudioMCP binary before launching it.
// Because Roblox Studio's app bundle files can be user/world-writable (TOCTOU risk), we:
// 1. lstat the source binary and refuse symlinks,
// 2. copy it to ~/.tokenwise-studio/bin/StudioMCP-<sha256> (dir 0700, file 0500, O_EXCL),
// 3. verify the COPY with /usr/bin/codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "2CFABCH843" and identifier "StudioMCP"',
// 4. exec the verified copy with a minimal environment.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

export const ROBLOX_TEAM_ID = "2CFABCH843";
export const ROBLOX_IDENTIFIER = "StudioMCP";
export const CODESIGN_BIN = "/usr/bin/codesign";
export const PGREP_BIN = "/usr/bin/pgrep";
export const CODESIGN_REQUIREMENT = `anchor apple generic and certificate leaf[subject.OU] = "${ROBLOX_TEAM_ID}" and identifier "${ROBLOX_IDENTIFIER}"`;

export function defaultStudioMcpPaths() {
  return [
    "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
    path.join(os.homedir(), "Applications", "RobloxStudio.app", "Contents", "MacOS", "StudioMCP"),
  ];
}

function defaultExec(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout || "", stderr: "" };
  } catch (e) {
    return {
      code: typeof e?.status === "number" ? e.status : 1,
      stdout: String(e?.stdout || ""),
      stderr: String(e?.stderr || e?.message || ""),
    };
  }
}

/** Locate StudioMCP on disk without trusting PATH, refusing symlinks. Returns { found, path, reason? }. */
export function locateStudioMcp(arg = {}) {
  const paths = Array.isArray(arg) ? arg : (arg?.paths || defaultStudioMcpPaths());
  let sawSymlink = false;
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      const st = fs.lstatSync(candidate);
      if (st.isSymbolicLink()) { sawSymlink = true; continue; }
      if (!st.isFile()) continue;
      if (process.platform !== "win32" && (st.mode & 0o111) === 0) continue;
      return { found: true, path: candidate, reason: null };
    } catch {}
  }
  return { found: false, path: null, reason: sawSymlink ? "StudioMCP symlink refused" : "StudioMCP binary not found" };
}

/** Parse Identifier, TeamIdentifier, and Authority lines from `codesign` output. */
export function parseCodesignInfo(output) {
  const text = String(output || "");
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    identifier: get("Identifier"),
    teamId: get("TeamIdentifier"),
    authority: get("Authority"),
  };
}

/**
 * Verify a StudioMCP binary's code signature and Roblox requirement via /usr/bin/codesign.
 * Refuses symlinks and non-regular files. Never throws.
 */
export function verifyStudioMcpSignature(binPath, { exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return { ok: false, path: binPath || null, teamId: null, identifier: null, reason: "StudioMCP requires macOS" };
  }
  if (!binPath || typeof binPath !== "string") {
    return { ok: false, path: null, teamId: null, identifier: null, reason: "StudioMCP path is missing" };
  }

  let st;
  try {
    st = fs.lstatSync(binPath);
  } catch {
    return { ok: false, path: binPath, teamId: null, identifier: null, reason: `StudioMCP binary not found: ${binPath}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, path: binPath, teamId: null, identifier: null, reason: "StudioMCP binary must not be a symlink" };
  }
  if (!st.isFile()) {
    return { ok: false, path: binPath, teamId: null, identifier: null, reason: "StudioMCP path is not a regular file" };
  }

  const runExec = (cmd, args) => {
    try {
      const r = exec(cmd, args);
      if (typeof r === "string") return { code: 0, stdout: r, stderr: "" };
      return r;
    } catch (err) {
      return { code: 1, stdout: "", stderr: String(err?.message || err || "exec failed") };
    }
  };

  const verify = runExec(CODESIGN_BIN, ["--verify", "--strict", `-R=${CODESIGN_REQUIREMENT}`, binPath]);
  if (!verify || verify.code !== 0) {
    const detail = [verify?.stderr, verify?.stdout].filter(Boolean).join(" ").trim();
    return {
      ok: false,
      path: binPath,
      teamId: null,
      identifier: null,
      reason: detail ? `codesign verification failed: ${detail}` : "codesign verification failed",
    };
  }

  const rawInfo = [verify?.stderr, verify?.stdout].filter(Boolean).join("\n");
  const { identifier, teamId } = parseCodesignInfo(rawInfo);
  if (teamId !== null && teamId !== ROBLOX_TEAM_ID) {
    return {
      ok: false,
      path: binPath,
      teamId,
      identifier,
      reason: `unexpected TeamIdentifier (${teamId || "missing"}, expected ${ROBLOX_TEAM_ID})`,
    };
  }
  if (identifier !== null && identifier !== ROBLOX_IDENTIFIER) {
    return {
      ok: false,
      path: binPath,
      teamId,
      identifier,
      reason: `unexpected Identifier (${identifier || "missing"}, expected ${ROBLOX_IDENTIFIER})`,
    };
  }

  return {
    ok: true,
    path: binPath,
    teamId: teamId || ROBLOX_TEAM_ID,
    identifier: identifier || ROBLOX_IDENTIFIER,
    reason: null,
  };
}

/** Build a minimal environment with no secrets or tokenwise env vars for StudioMCP. */
export function minimalStudioEnv(baseEnv = process.env) {
  const out = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]) {
    const val = baseEnv?.[key];
    if (typeof val === "string" && val.length > 0) out[key] = val;
  }
  return out;
}

/**
 * Copy StudioMCP to ~/.tokenwise-studio/bin/StudioMCP-<sha256> (dir 0700, file 0500, O_EXCL),
 * verify the COPY with /usr/bin/codesign --verify --strict -R=..., and spawn the verified copy.
 */
export function spawnStudioMcp({
  binPath,
  paths,
  cacheDir,
  exec = defaultExec,
  spawn: spawnFn = spawn,
  env = process.env,
  platform = process.platform,
} = {}) {
  const target = binPath || locateStudioMcp({ paths }).path;
  if (!target) {
    throw new Error("StudioMCP binary not found (expected /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP)");
  }
  if (platform !== "darwin") {
    throw new Error("Refusing to launch StudioMCP: StudioMCP requires macOS");
  }

  let srcStat;
  try {
    srcStat = fs.lstatSync(target);
  } catch {
    throw new Error(`Refusing to launch StudioMCP: StudioMCP binary not found at ${target}`);
  }
  if (srcStat.isSymbolicLink()) {
    throw new Error("Refusing to launch StudioMCP: StudioMCP binary must not be a symlink");
  }
  if (!srcStat.isFile()) {
    throw new Error("Refusing to launch StudioMCP: StudioMCP path is not a regular file");
  }

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let srcFd;
  try {
    srcFd = fs.openSync(target, openFlags);
  } catch (err) {
    throw new Error(`Refusing to launch StudioMCP: cannot open binary (${err?.code || err?.message || err})`);
  }
  let srcBuf;
  try {
    const fdStat = fs.fstatSync(srcFd);
    if (!fdStat.isFile() || fdStat.dev !== srcStat.dev || fdStat.ino !== srcStat.ino) {
      throw new Error("Refusing to launch StudioMCP: source binary was swapped before copying");
    }
    srcBuf = fs.readFileSync(srcFd);
  } finally {
    try { fs.closeSync(srcFd); } catch {}
  }

  const sha256 = crypto.createHash("sha256").update(srcBuf).digest("hex");
  const homeDir = env?.HOME || os.homedir();
  const binDir = cacheDir || path.join(homeDir, ".tokenwise-studio", "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const binDirStat = fs.lstatSync(binDir);
  if (binDirStat.isSymbolicLink() || !binDirStat.isDirectory()) {
    throw new Error("Refusing to launch StudioMCP: bin cache directory must not be a symlink");
  }
  fs.chmodSync(binDir, 0o700);

  const copyPath = path.join(binDir, `StudioMCP-${sha256}`);
  let reused = false;
  let existingStat = null;
  try {
    existingStat = fs.lstatSync(copyPath);
  } catch {}
  if (existingStat) {
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      try { fs.unlinkSync(copyPath); } catch {}
      throw new Error("Refusing to launch StudioMCP: cached binary is a symlink or not a regular file");
    }
    const existingBuf = fs.readFileSync(copyPath);
    const existingSha = crypto.createHash("sha256").update(existingBuf).digest("hex");
    if (existingSha === sha256) {
      fs.chmodSync(copyPath, 0o500);
      reused = true;
    } else {
      fs.unlinkSync(copyPath);
    }
  }

  if (!reused) {
    const outFd = fs.openSync(copyPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o500);
    try {
      fs.writeFileSync(outFd, srcBuf);
      fs.fchmodSync(outFd, 0o500);
    } finally {
      try { fs.closeSync(outFd); } catch {}
    }
  }

  const sig = verifyStudioMcpSignature(copyPath, { exec, platform });
  if (!sig.ok) {
    try { fs.unlinkSync(copyPath); } catch {}
    throw new Error(`Refusing to launch StudioMCP: ${sig.reason}`);
  }

  const postStat = fs.lstatSync(copyPath);
  if (postStat.isSymbolicLink() || !postStat.isFile()) {
    try { fs.unlinkSync(copyPath); } catch {}
    throw new Error("Refusing to launch StudioMCP: verified copy is not a regular file");
  }
  const postSha = crypto.createHash("sha256").update(fs.readFileSync(copyPath)).digest("hex");
  if (postSha !== sha256) {
    try { fs.unlinkSync(copyPath); } catch {}
    throw new Error("Refusing to launch StudioMCP: verified copy hash mismatch");
  }

  const child = spawnFn(copyPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: minimalStudioEnv(env),
    shell: false,
  });
  return { child, path: copyPath, sourcePath: target, sha256, reused, signature: sig };
}

/** Best-effort check whether Roblox Studio GUI app is currently running. Never throws. */
export function isRobloxStudioRunning({ exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== "darwin") return false;
  try {
    const r = exec(PGREP_BIN, ["-x", "RobloxStudio"]);
    return !!r && r.code === 0;
  } catch {
    return false;
  }
}

/** Combined StudioMCP + Roblox Studio status for Settings and UI gating. Never throws. */
export function getRobloxStudioStatus({ paths, exec = defaultExec, platform = process.platform } = {}) {
  const loc = locateStudioMcp({ paths });
  const sig = loc.found
    ? verifyStudioMcpSignature(loc.path, { exec, platform })
    : { ok: false, teamId: null, identifier: null, reason: "StudioMCP not found" };
  return {
    found: loc.found,
    path: loc.path,
    signatureOk: sig.ok,
    signatureError: sig.ok ? null : sig.reason,
    signatureReason: sig.ok ? null : sig.reason,
    teamId: sig.teamId || null,
    identifier: sig.identifier || null,
    studioRunning: isRobloxStudioRunning({ exec, platform }),
  };
}
