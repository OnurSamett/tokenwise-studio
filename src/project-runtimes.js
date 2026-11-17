// One isolated server/module instance per project. Never mutate a live project's
// Jobs or Chats when a different project is selected in the window.
import fs from "node:fs";
import path from "node:path";

const runtimes = new Map();
const pending = new Map();
let nextId = 0;
export function projectKey(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
export function rememberRuntime(p, url, isBusy = null) {
  const key = projectKey(p);
  runtimes.set(key, { ...runtimes.get(key), url, isBusy });
}
export function anyProjectBusy() { return [...runtimes.values()].some((r) => r.isBusy?.()); }
export async function projectRuntime(p, options = {}) {
  const key = projectKey(p);
  if (runtimes.has(key)) return runtimes.get(key);
  if (pending.has(key)) return pending.get(key);
  if (runtimes.size >= 24) throw new Error("Too many open projects. Restart Studio after active tasks finish.");
  const promise = (async () => {
    // A unique module URL gives each runtime independent module-scoped state.
    const mod = await import(`./ui.js?project-runtime=${++nextId}`);
    const url = await mod.startServer({ ...options, repo: key, port: 0 });
    const entry = { ...runtimes.get(key), url, instance: mod };
    runtimes.set(key, entry);
    return entry;
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}
export async function closeProjectRuntimes() {
  const children = [...runtimes.values()].filter((r) => r.instance);
  runtimes.clear();
  await Promise.all(children.map((r) => r.instance.stopServer()));
}
