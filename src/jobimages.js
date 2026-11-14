// Images a worker produced (png/jpg/webp/gif): copied out of the worktree when the job finishes, so they
// stay viewable after Apply or Discard, and served through a confined lookup (job worktree or artifacts only).
import fs from "node:fs";
import path from "node:path";

export const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 24;

export const imageType = (p) => IMAGE_TYPES[path.extname(String(p)).slice(1).toLowerCase()] || null;
export const artifactsDir = (jobs, id) => path.join(jobs.home, "artifacts", id);

/** Is `abs` a regular file (not a symlink) whose real path stays inside `root`? Returns its real path or null. */
function confined(root, abs) {
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return null;
    const real = fs.realpathSync(abs), base = fs.realpathSync(root);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/** A repo-relative path from the client: no absolute paths, no "..", no NUL, only image extensions. */
export function safeRel(rel) {
  rel = String(rel ?? "");
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || !imageType(rel)) return null;
  return path.normalize(rel);
}

/** Copy the job's changed image files (from its worktree) into artifacts/<id>/ and return [{ path, size }]. */
export function captureImages(jobs, job, files) {
  const out = [];
  for (const rel of files || []) {
    if (out.length >= IMAGE_MAX_COUNT) break;
    const r = safeRel(rel);
    if (!r) continue;
    const src = confined(job.cwd, path.join(job.cwd, r));
    if (!src) continue; // deleted in the diff, a symlink, or outside the worktree
    const size = fs.statSync(src).size;
    if (size > IMAGE_MAX_BYTES) continue;
    const dst = path.join(artifactsDir(jobs, job.id), r);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    out.push({ path: rel, size });
  }
  return out;
}

/** Resolve an image of a job for serving: artifacts copy first, then the live worktree. Returns { abs, type } or throws. */
export function resolveJobImage(jobs, id, rel) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error("bad job id");
  const r = safeRel(rel), type = r && imageType(r);
  if (!r) throw new Error("not an image path");
  const j = jobs.get(id); // throws on unknown job
  const roots = [artifactsDir(jobs, id)];
  if (j.write && j.cwd && path.dirname(path.resolve(j.cwd)) === path.resolve(jobs.home, "worktrees")) roots.push(j.cwd);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const abs = confined(root, path.join(root, r));
    if (!abs) continue;
    if (fs.statSync(abs).size > IMAGE_MAX_BYTES) throw new Error("image is larger than 15 MB");
    return { abs, type };
  }
  throw new Error("image not found");
}
