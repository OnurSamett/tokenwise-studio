// Cursor installs its agent separately from the editor. Prefer its dedicated name,
// never the generic `agent` binary which may belong to another application.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync as cursorSpawn, execFile } from "./process.js";
export function cursorAgentBin() {
  const local = path.join(os.homedir(), ".local", "bin", "cursor-agent");
  try { fs.accessSync(local, fs.constants.X_OK); return local; } catch {}
  return "cursor-agent";
}

// Cursor may list models that are unavailable on a particular plan; the CLI is
// authoritative when a task starts. Never cache credentials or CLI output.
let cachedModels = null;
let loadingModels = false;
export function cursorModelsSnapshot() {
  if (!loadingModels && (!cachedModels || Date.now() - cachedModels.at >= 300000)) {
    loadingModels = true;
    execFile(cursorAgentBin(), ["--list-models"], { encoding: "utf8", timeout: 12000 }, (err, out) => {
      loadingModels = false;
      if (err) return;
      const ids = [...new Set(String(out || "").split(/\r?\n/).map((line) => line.match(/^([a-zA-Z0-9][\w./:-]{0,119})\s+-\s+/)?.[1]).filter(Boolean))].slice(0, 100);
      cachedModels = { at: Date.now(), ids };
    });
  }
  return cachedModels?.ids || [];
}
export function cursorModels() {
  if (cachedModels && Date.now() - cachedModels.at < 300000) return cachedModels.ids;
  const r = cursorSpawn(cursorAgentBin(), ['--list-models'], { encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return [];
  const ids = [...new Set(String(r.stdout || '').split(/\r?\n/).map((line) => line.match(/^([a-zA-Z0-9][\w./:-]{0,119})\s+-\s+/)?.[1]).filter(Boolean))].slice(0, 100);
  if (ids.length) cachedModels = { at: Date.now(), ids };
  return ids;
}
