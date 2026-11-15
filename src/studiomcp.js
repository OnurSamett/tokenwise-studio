// Locate and verify Roblox Studio's built-in StudioMCP binary before launching it.
// Because Roblox Studio's app bundle files can be world-writable, we always verify
// the Mach-O code signature (`codesign --verify --deep --strict` and `codesign -dv`
// matching Roblox's TeamIdentifier and Identifier) before every spawn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

export const ROBLOX_TEAM_ID = "2CFABCH843";
export const ROBLOX_IDENTIFIER = "StudioMCP";

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

/** Locate StudioMCP on disk without trusting PATH. Returns { found, path }. */
export function locateStudioMcp({ paths = defaultStudioMcpPaths() } = {}) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      if (process.platform !== "win32" && (st.mode & 0o111) === 0) continue;
      return { found: true, path: candidate };
    } catch {}
  }
  return { found: false, path: null };
}

/** Parse Identifier, TeamIdentifier, and Authority lines from `codesign -dv` output. */
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

/** Verify StudioMCP's code signature and Roblox TeamIdentifier/Identifier. Never throws. */
export function verifyStudioMcpSignature(binPath, { exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return { ok: false, path: binPath || null, teamId: null, identifier: null, reason: "StudioMCP requires macOS" };
  }
  if (!binPath || typeof binPath !== "string") {
    return { ok: false, path: null, teamId: null, identifier: null, reason: "StudioMCP path is missing" };
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

  const verify = runExec("codesign", ["--verify", "--deep", "--strict", binPath]);
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

  const infoRes = runExec("codesign", ["-dv", binPath]);
  const rawInfo = [infoRes?.stderr, infoRes?.stdout].filter(Boolean).join("\n");
  if (!infoRes || infoRes.code !== 0) {
    return {
      ok: false,
      path: binPath,
      teamId: null,
      identifier: null,
      reason: rawInfo.trim() ? `codesign inspection failed: ${rawInfo.trim()}` : "codesign inspection failed",
    };
  }

  const { identifier, teamId } = parseCodesignInfo(rawInfo);
  if (teamId !== ROBLOX_TEAM_ID) {
    return {
      ok: false,
      path: binPath,
      teamId,
      identifier,
      reason: `unexpected TeamIdentifier (${teamId || "missing"}, expected ${ROBLOX_TEAM_ID})`,
    };
  }
  if (identifier !== ROBLOX_IDENTIFIER) {
    return {
      ok: false,
      path: binPath,
      teamId,
      identifier,
      reason: `unexpected Identifier (${identifier || "missing"}, expected ${ROBLOX_IDENTIFIER})`,
    };
  }

  return { ok: true, path: binPath, teamId, identifier, reason: null };
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

/** Verify StudioMCP signature and spawn it over stdio with a minimal environment. */
export function spawnStudioMcp({ binPath, paths, exec = defaultExec, spawn: spawnFn = spawn, env = process.env, platform = process.platform } = {}) {
  const target = binPath || locateStudioMcp({ paths }).path;
  if (!target) {
    throw new Error("StudioMCP binary not found (expected /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP)");
  }
  const sig = verifyStudioMcpSignature(target, { exec, platform });
  if (!sig.ok) {
    throw new Error(`Refusing to launch StudioMCP: ${sig.reason}`);
  }
  const child = spawnFn(target, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: minimalStudioEnv(env),
    shell: false,
  });
  return { child, path: target, signature: sig };
}

/** Best-effort check whether Roblox Studio GUI app is currently running. Never throws. */
export function isRobloxStudioRunning({ exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== "darwin") return false;
  try {
    const r = exec("pgrep", ["-x", "RobloxStudio"]);
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
