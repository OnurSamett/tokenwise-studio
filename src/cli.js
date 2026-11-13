#!/usr/bin/env node
// Usage: tokenwise-studio [path] [--port N] [--no-open]
import path from "node:path";
import { spawn } from "node:child_process";
import { startServer } from "./ui.js";

const argv = process.argv.slice(2);
const pi = argv.indexOf("--port");
const first = pi >= 0 ? Number(argv[pi + 1]) : 4777;
const dir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port");
const repo = path.resolve(dir || process.cwd());

let url = null;
for (let p = first; p <= first + 10 && !url; p++) {
  try { url = await startServer({ repo, port: p }); } catch (e) { if (e.code !== "EADDRINUSE") throw e; }
}
if (!url) { console.error(`tokenwise studio: ports ${first}-${first + 10} are all busy`); process.exit(1); }
console.log(`tokenwise studio is running at ${url}  (project: ${path.basename(repo)})`);

if (!argv.includes("--no-open")) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}
