// Image attachments: validated upload, storage under <repo>/.tokenwise-studio/uploads/<chat>/, and
// strict path resolution so only files we saved there can be read, served or forwarded to workers.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 6;
export const UPLOAD_BODY_LIMIT = 14 * 1024 * 1024; // base64 of 10 MB is ~13.4 MB, plus JSON overhead
export const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export const uploadsRoot = (repo) => path.join(path.resolve(repo), ".tokenwise-studio", "uploads");
const REL_PREFIX = ".tokenwise-studio/uploads/";

/** Image type from the file's magic bytes, or null. */
export function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "image/gif";
  return null;
}

const safeSeg = (s) => (/^[\w-]{1,40}$/.test(String(s || "")) ? String(s) : "new");

// Refuse symlinks in every state-directory component, including the uploads root.
function checkDirs(repo, dir, create = false) {
  let current = path.resolve(repo);
  for (const part of path.relative(current, dir).split(path.sep)) {
    current = path.join(current, part);
    let st;
    try { st = fs.lstatSync(current); }
    catch {
      if (!create) throw new Error("image not found");
      fs.mkdirSync(current);
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("uploads directory must not use symlinks");
  }
}

/** Save one image; the client name never participates in the path. */
export function saveUpload(repo, { type, data, chat, chatId } = {}) {
  const ext = Object.hasOwn(TYPES, type) ? TYPES[type] : null;
  if (!ext) throw new Error("only png, jpeg, webp and gif images are accepted");
  if (typeof data !== "string" || !data) throw new Error("missing image data");
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new Error("image is larger than 10 MB");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("image data is not valid base64");
  const buf = Buffer.from(data, "base64");
  if (buf.toString("base64") !== data) throw new Error("image data is not valid base64");
  if (!buf.length) throw new Error("image is empty");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("image is larger than 10 MB");
  if (sniff(buf) !== type) throw new Error("file content does not match its image type");
  const dir = path.join(uploadsRoot(repo), safeSeg(chat ?? chatId));
  checkDirs(repo, dir, true);
  const file = `${Date.now()}-${crypto.randomBytes(12).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf, { flag: "wx", mode: 0o600 });
  return { path: `${REL_PREFIX}${path.basename(dir)}/${file}` };
}

/** Resolve a repo-relative path to a real file inside the uploads dir, or throw.
 *  The real path must equal the lexical path under the real root, so symlinks anywhere are refused. */
export function resolveUpload(repo, p) {
  if (typeof p !== "string" || !p || p.includes("\0") || path.isAbsolute(p)) throw new Error("invalid image path");
  const root = uploadsRoot(repo);
  const abs = path.resolve(repo, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("image is not inside the uploads folder");
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!MIME[ext]) throw new Error("not an image file");
  checkDirs(repo, path.dirname(abs));
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new Error("image not found"); }
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { throw new Error("image not found"); }
  if (real !== path.join(realRoot, rel)) throw new Error("image path must not use symlinks");
  const st = fs.lstatSync(abs);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular file");
  if (st.size > MAX_IMAGE_BYTES || sniff(fs.readFileSync(abs)) !== MIME[ext]) throw new Error("invalid uploaded image");
  return { abs, rel: REL_PREFIX + rel.split(path.sep).join("/"), type: MIME[ext] };
}

/** Validate a list of image paths; returns [{abs, rel, type}] (deduplicated, at most MAX_IMAGES). */
export function validateImages(repo, list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("images must be a list of paths");
  if (list.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per message`);
  const seen = new Map();
  for (const p of list) { const r = resolveUpload(repo, p); seen.set(r.abs, r); }
  return [...seen.values()];
}

/** Mention attached images in a prompt for agents that read files themselves. */
export function imageNote(paths) {
  return paths.length ? `Attached images (read them with the Read tool):\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
}
