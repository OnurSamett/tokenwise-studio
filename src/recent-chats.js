// Cross-project navigation is an index only: chats remain in their original project.
import fs from "node:fs";
import path from "node:path";

const canonical = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
export function recentProjectChats(projects, current, limit = 20) {
  const seen = new Set();
  const currentReal = canonical(current);
  const result = [];
  for (const project of projects || []) {
    if (typeof project !== "string") continue;
    const real = canonical(project);
    if (!real || real === currentReal || seen.has(real)) continue;
    seen.add(real);
    const dir = path.join(real, ".tokenwise-studio", "chats");
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^[\w-]+\.json$/.test(name)) continue;
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        const id = name.slice(0, -5);
        // Empty/new chats do not represent a conversation, and malformed files are ignored.
        if (chat.id !== id || typeof chat.title !== "string" || !Array.isArray(chat.turns) || !chat.turns.length) continue;
        const last = chat.turns.at(-1);
        const updated = last?.started || chat.created || "";
        result.push({ id, title: chat.title.slice(0, 120), project: real, projectName: path.basename(real), updated, status: chat.status || "" });
      } catch { /* a removed, incomplete or malformed chat does not break the sidebar */ }
    }
  }
  return result.sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, limit);
}
