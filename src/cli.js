#!/usr/bin/env node
// tokenwise-studio [path] [--port N] [--no-open] [--browser] [--pick]
// tokenwise-studio export [--chat <id>] [--out <dir>]
// tokenwise-studio doctor | setup [--dry-run] [--no-mcp] [--no-gemini] [--no-app] | uninstall [--dry-run] | update [--check]
import { projectProblem } from "./projectpath.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "./process.js";
import { launcherHash, quitStudioServers } from "./autoupdate.js";
import { installArgs } from "./version.js";
import { BUNDLE_ID, APP_NAME, EXE, defaultAppPath, appJsonPath, findAppBundle, findOwnedAppBundles, verifyAppBundle } from "./appbundle.js";
import { findAgy, agyMcpAddArgs, agyMcpRemoveArgs, syncGeminiMcp } from "./antigravity.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
const MCP_NAME = "tokenwise-studio";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const HELP = `tokenwise studio ${pkg.version}

Usage:
  tokenwise-studio [path] [--port N] [--no-open] [--browser]
                                                   start the UI for a project (default: current folder);
                                                   opens in the tokenwise studio app if installed, --browser forces a browser tab
  tokenwise-studio --pick                          choose the project in a macOS folder dialog
  tokenwise-studio doctor                          check which workers are ready
  tokenwise-studio setup [--dry-run] [--no-mcp] [--no-gemini] [--no-app]
                                                   register the MCP server with Claude Code and Antigravity (Gemini)
                                                   and, on macOS, create ~/Applications/tokenwise studio.app
  tokenwise-studio uninstall [--dry-run]           undo what setup did
  tokenwise-studio update [--check]                install the latest version and rebuild the Mac app
                                                   (--check only reports whether one is available)
  tokenwise-studio export [--chat <id>] [--out <dir>] [--repo <path>]
                                                   write chats as Markdown and JSON (all chats without --chat);
                                                   default folder: <project>/.tokenwise-studio/exports
  tokenwise-studio --version | --help
`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const home = () => os.homedir();
const appPath = () => findAppBundle({ requireExecutable: false, home })?.appPath || defaultAppPath(home());
// The native app counts only if it is ours and has its executable.
export const nativeAppInstalled = (deps = {}) => Boolean(findAppBundle(deps));
// How to show a running server: "none" | "browser" | "app".
export const decideOpen = ({ noOpen, browser, platform, installed }) =>
  noOpen ? "none" : platform === "darwin" && !browser && installed ? "app" : "browser";
const logPath = () => path.join(home(), ".tokenwise-studio", "launcher.log");

// Run a command with an argument array; returns { ok, out }.
const run = (cmd, args, opts = {}) => {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, ...opts });
    return { ok: true, out };
  } catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` || String(e.message) }; }
};
// Stable node path: the PATH entry (e.g. /opt/homebrew/bin/node) survives `brew upgrade node`;
// process.execPath points into a versioned Cellar folder that disappears on upgrade.
function stableNode() {
  if (process.platform === "win32") return process.execPath;
  const r = run("/bin/sh", ["-c", "command -v node"]);
  const p = r.ok ? r.out.trim() : "";
  try { if (p && path.isAbsolute(p) && fs.realpathSync(p) === fs.realpathSync(process.execPath)) return p; } catch {}
  return process.execPath;
}
const hasClaude = () => run("claude", ["--version"]).ok;
const mcpRegistered = () => run("claude", ["mcp", "get", MCP_NAME]).ok;

function doDoctor() {
  return import("./doctor.js").then(({ doctor }) => {
    const d = doctor();
    const rows = [];
    const row = (name, ok, detail, fix) => rows.push({ name, ok, detail, fix: ok ? "" : fix });
    row("git", d.git.installed, d.git.installed ? "installed" : "missing", "install git (https://git-scm.com)");
    const cli = (name, x, fixIn, fixAuth) => {
      const ok = x.installed && x.signedIn;
      row(name, ok, !x.installed ? "not installed" : x.signedIn ? "ready" : "installed, not signed in", !x.installed ? fixIn : fixAuth);
    };
    cli("claude", d.claude, "npm install -g @anthropic-ai/claude-code", "claude auth login");
    cli("codex", d.codex, "npm install -g @openai/codex", "codex login");
    const g = d.gemini;
    row("gemini", g.installed && g.signedIn, g.via === "antigravity" ? (g.signedIn ? "ready (Antigravity)" : "Antigravity found, not signed in") : !g.installed ? "not installed" : g.signedIn ? "ready (API key)" : "installed, no API key",
      g.via === "antigravity" ? "open Antigravity (agy) once and sign in" : !g.installed ? "install Antigravity, or Gemini CLI + set GEMINI_API_KEY" : "set GEMINI_API_KEY");
    const l = d.local;
    row("local", l.installed && l.signedIn, !l.installed ? "ollama not installed" : l.signedIn ? `ready (${l.model})` : `model ${l.model} not ready`, l.fix || "");
    const f = d.free;
    row("free", f.installed && f.signedIn, !f.installed ? "no API key" : f.signedIn ? `ready (${f.via})` : `key found (${f.via}), not enabled`, f.fix || "");
    const w = Math.max(...rows.map((r) => r.name.length));
    const w2 = Math.max(...rows.map((r) => r.detail.length));
    console.log("tokenwise studio readiness\n");
    for (const r of rows) {
      console.log(`  ${r.ok ? "ok " : "-- "} ${r.name.padEnd(w)}  ${r.detail.padEnd(w2)}${r.fix ? "  -> " + r.fix : ""}`);
    }
    console.log("\nAt least one worker needs to be ready. Key values are never printed.");
  });
}

function buildIcon(resourcesDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tws-icon-"));
  const set = path.join(tmp, "AppIcon.iconset");
  try {
    fs.mkdirSync(set);
    const src = path.join(ROOT, "assets", "logo.png");
    for (const s of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [[1, ""], [2, "@2x"]]) {
        const px = s * scale;
        const r = run("sips", ["-z", String(px), String(px), src, "--out", path.join(set, `icon_${s}x${s}${suffix}.png`)]);
        if (!r.ok) throw new Error(r.out.trim());
      }
    }
    const r = run("iconutil", ["-c", "icns", set, "-o", path.join(resourcesDir, "AppIcon.icns")]);
    if (!r.ok) {
      // iconutil may be unavailable through its image service in a restricted build
      // environment. Modern macOS also accepts PNG chunks in a standard ICNS container.
      const chunks = [["ic07", "icon_128x128.png"], ["ic08", "icon_256x256.png"],
        ["ic09", "icon_512x512.png"], ["ic10", "icon_512x512@2x.png"]].map(([type, name]) => {
        const png = fs.readFileSync(path.join(set, name));
        const header = Buffer.alloc(8);
        header.write(type); header.writeUInt32BE(png.length + 8, 4);
        return Buffer.concat([header, png]);
      });
      const header = Buffer.alloc(8);
      header.write("icns"); header.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
      fs.writeFileSync(path.join(resourcesDir, "AppIcon.icns"), Buffer.concat([header, ...chunks]));
    }
    return true;
  } catch (e) {
    console.warn(`  warning: could not build the app icon (${String(e.message).split("\n")[0]}); continuing without it`);
    return false;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function buildApp(target = appPath(), { selfContained = false, sparkleDir = null, sparklePublicKey = null } = {}) {
  if (selfContained && (!sparkleDir || !/^[A-Za-z0-9+/]{43}=$/.test(sparklePublicKey || ""))) {
    throw new Error("DMG builds require verified Sparkle and launcher/sparkle-public-key.txt; run scripts/sparkle-keys.sh");
  }
  const app = target;
  if (fs.existsSync(app) && !ownedApp(app)) throw new Error(`${app} already exists and was not created by tokenwise studio; leaving it alone`);
  fs.rmSync(app, { recursive: true, force: true });
  const macos = path.join(app, "Contents", "MacOS"), res = path.join(app, "Contents", "Resources");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  const hasIcon = buildIcon(res);
  if (selfContained && !hasIcon) throw new Error("release builds require an app icon");
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const pickSh = `#!/bin/bash
# Generated by "tokenwise-studio setup". GUI apps get no shell PATH, so node is an absolute path.
LOG=${q(logPath())}
mkdir -p "$(dirname "$LOG")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$(dirname ${q(stableNode())}):$PATH"
echo "--- $(date) launch" >> "$LOG"
exec ${q(stableNode())} ${q(path.join(SRC, "cli.js"))} --pick >> "$LOG" 2>&1
`;
  // Native executable (own notifications, click opens the studio) when swiftc works; bash launcher otherwise.
  let native = false;
  const swift = path.join(ROOT, "launcher", "TokenwiseStudio.swift");
  if (run("xcrun", ["--find", "swiftc"]).ok || run("swiftc", ["--version"]).ok) {
    console.log("  compiling the native app (swiftc) ...");
    const frameworks = ["-framework", "AppKit", "-framework", "WebKit", "-framework", "UserNotifications", "-framework", "Speech", "-framework", "AVFoundation"];
    if (selfContained) frameworks.push("-F", sparkleDir, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks");
    let r;
    if (selfContained) {
      for (const arch of ["arm64", "x86_64"]) {
        r = run("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos13.5`, "-module-cache-path", path.join(res, ".swift-cache"), "-Xlinker", "-no_adhoc_codesign", ...frameworks, swift, "-o", path.join(macos, `${EXE}-${arch}`)], { timeout: 240000 });
        if (!r.ok) throw new Error(`release Swift compilation (${arch}) failed: ${r.out}`);
      }
      fs.rmSync(path.join(res, ".swift-cache"), { recursive: true, force: true });
      r = run("lipo", ["-create", ...["arm64", "x86_64"].map((a) => path.join(macos, `${EXE}-${a}`)), "-output", path.join(macos, EXE)]);
      for (const arch of ["arm64", "x86_64"]) fs.rmSync(path.join(macos, `${EXE}-${arch}`));
    } else {
      r = run("swiftc", ["-O", ...frameworks, swift, "-o", path.join(macos, EXE)], { timeout: 240000 });
    }
    if (r.ok) native = true;
    else console.warn(`  warning: compiling failed (${r.out.trim().split("\n")[0]})`);
  }
  if (selfContained && !native) throw new Error("release builds require a working Swift compiler and lipo");
  if (native) {
    if (!selfContained) fs.writeFileSync(path.join(res, "pick.sh"), pickSh, { mode: 0o755 });
    fs.writeFileSync(path.join(res, "config.json"), JSON.stringify({ node: selfContained ? "node/bin/node" : stableNode(), cli: selfContained ? "app/src/cli.js" : path.join(SRC, "cli.js"), version: pkg.version, launcherHash: launcherHash(ROOT) }, null, 2));
  } else {
    console.warn("  note: no Swift compiler (install the Xcode command line tools: xcode-select --install, then re-run setup); desktop notifications require the native app");
    const lp = path.join(macos, "launcher");
    fs.writeFileSync(lp, pickSh);
    fs.chmodSync(lp, 0o755);
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>tokenwise studio</string>
  <key>CFBundleDisplayName</key><string>tokenwise studio</string>
  <key>CFBundleExecutable</key><string>${native ? EXE : "launcher"}</string>
${hasIcon ? "  <key>CFBundleIconFile</key><string>AppIcon</string>\n" : ""}  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>LSUIElement</key><false/>
  <key>LSMinimumSystemVersion</key><string>${selfContained ? "13.5" : "13.0"}</string>
${selfContained ? `  <key>SUFeedURL</key><string>https://tokenwise.site/appcast.xml</string>
  <key>SUPublicEDKey</key><string>${sparklePublicKey}</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
  <!-- Non-sandboxed: do not enable SUEnableInstallerLauncherService or SUEnableDownloaderService. -->
` : ""}  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>tokenwise studio uses the microphone to dictate messages in the composer.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>tokenwise studio uses speech recognition to transcribe your dictation in the composer.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
      <key>CFBundleURLSchemes</key>
      <array><string>tokenwise-studio</string></array>
    </dict>
  </array>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), plist);
  if (native && !selfContained) {
    const r = run("codesign", ["--force", "--deep", "-s", "-", app]);
    if (!r.ok) console.warn(`  warning: ad-hoc signing failed (${r.out.trim().split("\n")[0]}); notifications may not work`);
    // macOS only asks for notification permission for apps it knows about and that were started by
    // LaunchServices; a binary run directly is refused silently. Register the app, then post a first
    // notification through `open` so the permission prompt shows up now.
    run("/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister", ["-f", app]);
    const o = run("open", ["-n", "-a", app, "--args", "--notify", "--title", "tokenwise studio", "--message", "Notifications are on. Click one to open the studio.", "--subtitle", "Setup"]);
    console.log(o.ok ? "  asked macOS for notification permission (click Allow if prompted)" : "  could not request notification permission; desktop notifications may not appear");
  }
  return app;
}

export async function doSetup(opts = {}) {
  const args = opts.args || argv;
  const flag = (f) => args.includes(f);
  const log = opts.log || console.log;
  const dry = flag("--dry-run"), mac = (opts.platform ?? process.platform) === "darwin";
  const bundledApp = mac && fs.existsSync(path.join(appPath(), "Contents", "Resources", "app", ".bundled"));
  const wantMcp = !flag("--no-mcp"), noGemini = flag("--no-gemini"), wantApp = !flag("--no-app") && mac && !bundledApp;
  const homeDir = opts.homeDir || home();
  const targetApp = wantApp ? appPath() : defaultAppPath(homeDir);
  const mcpPath = opts.mcpPath || path.join(SRC, "mcp.js");
  const node = opts.nodePath || stableNode();
  const claude = wantMcp && (opts.claudeInstalled !== undefined ? opts.claudeInstalled : hasClaude());
  const registered = claude && (opts.claudeRegistered !== undefined ? opts.claudeRegistered : mcpRegistered());
  const agy = wantMcp && (opts.agyBin !== undefined ? opts.agyBin : findAgy());
  log(`tokenwise studio setup${dry ? " (dry run, nothing will be changed)" : ""}\n`);
  log("This will:");
  if (!wantMcp) log("  - skip MCP registration (--no-mcp)");
  else if (!claude) log("  - skip MCP registration: the `claude` CLI was not found (install Claude Code, then re-run setup)");
  else if (registered) log(`  - skip MCP registration: "${MCP_NAME}" is already registered with Claude Code`);
  else log(`  - register the MCP server with Claude Code (user scope):\n      claude mcp add ${MCP_NAME} --scope user -- ${node} ${mcpPath}`);
  if (wantMcp) {
    if (noGemini) log("  - skip Antigravity MCP registration (--no-gemini)");
    else if (agy) {
      const agyArgs = agyMcpAddArgs({ name: MCP_NAME, nodePath: node, mcpPath });
      log(`  - add tokenwise to Antigravity's MCP servers (Gemini can orchestrate):\n      ${agy} ${agyArgs.join(" ")}`);
    }
  }
  if (flag("--no-app")) log("  - skip the launcher app (--no-app)");
  else if (!mac) log("  - skip the launcher app (macOS only)");
  else if (bundledApp) log("  - keep the self-contained Mac app (use Check for Updates… in the app menu)");
  else log(`  - ${fs.existsSync(targetApp) ? "update" : "create"} the launcher app ${targetApp}\n      (log: ${logPath()})`);
  log("");
  if (!dry) {
    if (claude && !registered) {
      const execClaude = opts.claudeRunner || ((c, a) => run(c, a));
      const r = execClaude("claude", ["mcp", "add", MCP_NAME, "--scope", "user", "--", node, mcpPath]);
      log(r.ok ? "registered MCP server with Claude Code" : `MCP registration failed: ${r.out.trim()}`);
    }
    if (wantMcp && !noGemini && agy) {
      const r = syncGeminiMcp(true, { agyBin: agy, name: MCP_NAME, nodePath: node, mcpPath, runner: opts.runner, force: true, home: homeDir });
      log(r.ok ? "registered MCP server with Antigravity" : `Antigravity MCP registration failed: ${r.error || "unknown error"}`);
    }
    if (wantApp) {
      try { log(`created ${buildApp(targetApp)}`); } catch (e) { console.error(`could not create the launcher app: ${e.message}`); }
    }
    log("");
  }
  if (!opts.skipDoctor) await doDoctor();
  if (!dry) log(`\nDone. Start it with: cd your-project && tokenwise-studio${wantApp ? `  (or open ${targetApp})` : ""}`);
}

function ownedApp(p = appPath()) {
  return Boolean(verifyAppBundle(p, { requireExecutable: false }));
}

export function doUninstall(opts = {}) {
  const args = opts.args || argv;
  const flag = (f) => args.includes(f);
  const log = opts.log || console.log;
  const dry = flag("--dry-run");
  const homeDir = opts.homeDir || home();
  log(`tokenwise studio uninstall${dry ? " (dry run, nothing will be changed)" : ""}\n`);
  const claude = opts.claudeInstalled !== undefined ? opts.claudeInstalled : hasClaude();
  const registered = claude && (opts.claudeRegistered !== undefined ? opts.claudeRegistered : mcpRegistered());
  if (registered) {
    log(`  - remove the MCP registration: claude mcp remove ${MCP_NAME} --scope user`);
    if (!dry) {
      const execClaude = opts.claudeRunner || ((c, a) => run(c, a));
      const r = execClaude("claude", ["mcp", "remove", MCP_NAME, "--scope", "user"]);
      log(r.ok ? "    removed" : `    failed: ${r.out.trim()}`);
    }
  } else log("  - MCP registration: nothing to remove");
  const agy = opts.agyBin !== undefined ? opts.agyBin : findAgy();
  if (agy) {
    const rmArgs = agyMcpRemoveArgs({ name: MCP_NAME });
    log(`  - remove Antigravity MCP registration: ${agy} ${rmArgs.join(" ")}`);
    if (!dry) {
      const r = syncGeminiMcp(false, { agyBin: agy, name: MCP_NAME, runner: opts.runner, home: homeDir });
      log(r.ok ? "    removed" : `    failed: ${r.error || "unknown error"}`);
    }
  }
  const owned = findOwnedAppBundles({ home: () => homeDir });
  const def = defaultAppPath(homeDir);
  if (owned.length) {
    for (const p of owned) {
      log(`  - delete ${p}`);
      if (!dry) { fs.rmSync(p, { recursive: true, force: true }); log("    deleted"); }
    }
    if (!dry) fs.rmSync(appJsonPath(homeDir), { force: true });
  } else if (fs.existsSync(def)) log(`  - ${def} exists but is not ours (bundle id mismatch); leaving it alone`);
  else {
    log("  - launcher app: nothing to remove");
    if (!dry) fs.rmSync(appJsonPath(homeDir), { force: true });
  }
  log("\nTo finish, run: npm uninstall -g tokenwise-studio");
}

async function doUpdate() {
  const { currentVersion, installSource, latestVersion, compareVersions } = await import("./version.js");
  const cur = currentVersion(), source = installSource();
  if (source === "windows") return console.log("Download and extract the latest Windows beta zip: https://github.com/OnurSamett/tokenwise-studio/releases/latest/download/tokenwise-studio-windows.zip");
  if (source === "dmg") return console.log("In the Mac app, choose tokenwise studio > Check for Updates… (Sparkle). You can also download a replacement DMG from https://github.com/OnurSamett/tokenwise-studio/releases/latest.");
  const latest = await latestVersion({ force: true });
  console.log(`tokenwise studio ${cur} (installed from ${source})`);
  if (!latest) { console.log("could not check for the latest version (offline?)"); if (has("--check")) return; }
  else console.log(`latest: ${latest.version} (${latest.source})`);
  const newer = latest && compareVersions(latest.version, cur) > 0;
  if (latest && !newer) return console.log("you are up to date");
  if (has("--check")) return console.log(newer ? "an update is available: run `tokenwise-studio update`" : "");
  if (source === "dev") return console.log("this is a git checkout: update it with `git pull` (then `tokenwise-studio setup` to rebuild the Mac app)");
  // npm records no install source, so a registry install looks like "github". If the registry has the package, use it.
  const args = installArgs(latest?.source);
  console.log(`\nnpm ${args.join(" ")}\n`);
  try { execFileSync("npm", args, { stdio: "inherit" }); }
  catch { console.error("\nupdate failed; nothing else was changed. Try the command above yourself (you may need different permissions)."); process.exit(1); }
  console.log("\nrebuilding the Mac app with the new version ...\n");
  const r = spawnSync(EXE, ["setup"], { stdio: "inherit" });
  if (r.error || r.status) { console.error(`\nupdated, but \`${EXE} setup\` did not finish; run it yourself.`); process.exit(1); }
  // Running studio servers still serve the old code; stop them so the next open starts the new version.
  const q = await quitStudioServers();
  if (q.quit) console.log(`stopped ${q.quit} running studio server${q.quit === 1 ? "" : "s"}; open windows will reload on their own`);
  if (q.busy) console.log(`${q.busy} studio server${q.busy === 1 ? " is" : "s are"} busy with a running job and kept running: restart ${q.busy === 1 ? "it" : "them"} from the app when done`);
  if (q.unsupported) console.log(`${q.unsupported} older studio server${q.unsupported === 1 ? "" : "s"} cannot be stopped remotely: quit and reopen the app`);
  console.log("\nUpdated to the new version.");
}

function pickFolder() {
  if (process.platform !== "darwin") { console.error("tokenwise studio: --pick needs macOS. Pass a folder instead: tokenwise-studio /path/to/project"); process.exit(1); }
  try {
    const out = execFileSync("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a project for tokenwise studio")'], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return out || null;
  } catch { return null; } // cancelled
}

async function startUi() {
  const { startServer, startAutoUpdater } = await import("./ui.js");
  const pi = argv.indexOf("--port");
  const first = pi >= 0 ? Number(argv[pi + 1]) : 4777;
  let dir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port");
  if (has("--pick")) { dir = pickFolder(); if (!dir) process.exit(0); }
  const repo = path.resolve(dir || process.cwd());
  const bad = projectProblem(repo, { allowTemp: true });
  if (bad) { console.error(`tokenwise studio: cannot use this project folder: ${bad}`); process.exit(2); }
  let url = null;
  for (let p = first; p <= first + 10 && !url; p++) {
    try { url = await startServer({ repo, port: p }); } catch (e) {
      if (e.code === "EADDRINUSE") continue;
      console.error(`tokenwise studio: could not start in ${repo}: ${e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS" ? "no permission to write there" : e.message}`);
      process.exit(2);
    }
  }
  if (!url) { console.error(`tokenwise studio: ports ${first}-${first + 10} are all busy`); process.exit(1); }
  startAutoUpdater();
  console.log(`tokenwise studio is running at ${url}  (project: ${path.basename(repo)})`);
  const found = process.platform === "darwin" ? findAppBundle({ home }) : null;
  const mode = decideOpen({ noOpen: has("--no-open"), browser: has("--browser"), platform: process.platform, installed: !!found });
  const appUrl = `tokenwise-studio://open?repo=${encodeURIComponent(repo)}&url=${encodeURIComponent(url)}`;
  if (process.env.TOKENWISE_DRY_OPEN === "1") { console.log(`open-mode: ${mode}${mode === "app" ? ` ${appUrl}` : ""}`); process.exit(0); }
  if (mode === "app" && !run("open", ["-a", found.appPath, appUrl]).ok) {
    console.warn("tokenwise studio: could not open the app; falling back to the browser");
    openBrowser(url);
  } else if (mode === "browser") openBrowser(url);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["explorer.exe", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

async function doExport() {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  for (const n of ["--chat", "--out", "--repo"]) if (has(n) && !opt(n)) { console.error(`tokenwise-studio export: ${n} needs a value`); process.exit(1); }
  const repo = path.resolve(opt("--repo") || process.cwd());
  const { Jobs } = await import("./jobs.js");
  const { Chats } = await import("./orchestrator.js");
  const { writeExports } = await import("./export.js");
  const chats = new Chats(new Jobs(repo));
  const out = path.resolve(opt("--out") || path.join(repo, ".tokenwise-studio", "exports"));
  try {
    const files = writeExports(chats.jobs, chats, { id: opt("--chat"), out });
    if (!files.length) { console.log("No chats to export in " + repo); return; }
    console.log(`Exported ${files.length / 2} chat${files.length === 2 ? "" : "s"} (Markdown and JSON) to ${out}`);
    console.log("Chats can contain pasted secrets: keep the folder private.");
  } catch (e) { console.error("tokenwise-studio export: " + (e.code === "ENOENT" ? `unknown chat ${opt("--chat")}` : e.message)); process.exit(1); }
}

const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const cmd = argv[0];
  if (has("--help") || has("-h") || cmd === "help") console.log(HELP);
  else if (has("--version") || has("-v")) console.log(pkg.version);
  else if (cmd === "doctor") await doDoctor();
  else if (cmd === "setup") await doSetup();
  else if (cmd === "uninstall") doUninstall();
  else if (cmd === "update") await doUpdate();
  else if (cmd === "export") await doExport();
  else await startUi();
}
