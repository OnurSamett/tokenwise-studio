import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_ID,
  MDFIND_QUERY,
  clearAppCache,
  defaultAppPath,
  appJsonPath,
  findAppBundle,
  findOwnedAppBundles,
} from "../src/appbundle.js";
import {
  LIMIT_UNKNOWN_WINDOW_MS,
  nativeNotifier,
  notify,
  resetNotifyState,
  shouldNotifyLimit,
  recordLimitNotified,
  limitHandoffNotice,
  notifyLimitHandoff,
  notifiedFile,
} from "../src/notify.js";
import { nativeAppInstalled, decideOpen } from "../src/cli.js";
import { formatHHMM } from "../src/cooldowns.js";
import { clearDoctorCache } from "../src/doctor.js";
import { Jobs } from "../src/jobs.js";
import { Chats } from "../src/orchestrator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_PLIST = `<plist><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string></dict></plist>`;
const OTHER_PLIST = `<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>`;

function makeFakeFs({ files = {}, executables = [] } = {}) {
  const execSet = new Set(executables);
  const store = new Map(Object.entries(files));
  return {
    constants: { X_OK: fs.constants.X_OK },
    readFileSync(p) {
      if (!store.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = "ENOENT";
        throw e;
      }
      return store.get(p);
    },
    accessSync(p) {
      if (!execSet.has(p)) {
        const e = new Error(`EACCES: ${p}`);
        e.code = "EACCES";
        throw e;
      }
    },
    mkdirSync() {},
    writeFileSync(p, data) { store.set(p, String(data)); },
    renameSync(a, b) { store.set(b, store.get(a)); store.delete(a); },
    store,
  };
}

const binOf = (app) => path.join(app, "Contents", "MacOS", "tokenwise-studio");
const plistOf = (app) => path.join(app, "Contents", "Info.plist");

test("app lookup order: (a) app.json -> (b) mdfind (cached, arg array) -> (c) ~/Applications, with plist & executable checks", () => {
  clearAppCache();
  const home = "/Users/tester";
  const movedA = "/Users/tester/Desktop/Apps/tokenwise studio.app";
  const movedB = "/Users/tester/Documents/tokenwise studio.app";
  const defApp = defaultAppPath(home);

  // (a) app.json wins over mdfind and ~/Applications
  {
    const fsys = makeFakeFs({
      files: {
        [appJsonPath(home)]: JSON.stringify({ bundlePath: movedA }),
        [plistOf(movedA)]: VALID_PLIST,
        [plistOf(movedB)]: VALID_PLIST,
        [plistOf(defApp)]: VALID_PLIST,
      },
      executables: [binOf(movedA), binOf(movedB), binOf(defApp)],
    });
    let mdfindCalls = 0;
    const exec = () => { mdfindCalls++; return movedB + "\n"; };
    assert.equal(nativeNotifier({ fs: fsys, exec, home }), binOf(movedA));
    assert.equal(mdfindCalls, 0);
  }

  // (b) Falls back to mdfind when app.json points to a missing/wrong bundle, skips Trash, caches result
  {
    const trashed = "/Users/tester/.Trash/tokenwise studio.app";
    const fsys = makeFakeFs({
      files: {
        [appJsonPath(home)]: JSON.stringify({ bundlePath: "/nonexistent/tokenwise studio.app" }),
        [plistOf(trashed)]: VALID_PLIST,
        [plistOf(movedB)]: VALID_PLIST,
        [plistOf(defApp)]: VALID_PLIST,
      },
      executables: [binOf(trashed), binOf(movedB), binOf(defApp)],
    });
    const execCalls = [];
    const exec = (cmd, args) => {
      execCalls.push({ cmd, args });
      return `${trashed}\n${movedB}\n`;
    };
    assert.equal(nativeNotifier({ fs: fsys, exec, home }), binOf(movedB));
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].cmd, "/usr/bin/mdfind");
    assert.deepEqual(execCalls[0].args, [MDFIND_QUERY]);

    // Second call uses cached mdfind result
    assert.equal(nativeNotifier({ fs: fsys, exec, home }), binOf(movedB));
    assert.equal(execCalls.length, 1);
  }

  // (c) Falls back to ~/Applications when app.json & mdfind find nothing
  {
    clearAppCache();
    const fsys = makeFakeFs({
      files: { [plistOf(defApp)]: VALID_PLIST },
      executables: [binOf(defApp)],
    });
    const exec = () => "";
    const found = findAppBundle({ fs: fsys, exec, home });
    assert.equal(found?.appPath, defApp);
    assert.equal(found?.binaryPath, binOf(defApp));
    assert.equal(found?.source, "applications");
  }

  // Rejects wrong CFBundleIdentifier or non-executable binary
  {
    clearAppCache();
    const wrongId = makeFakeFs({
      files: {
        [appJsonPath(home)]: JSON.stringify({ bundlePath: movedA }),
        [plistOf(movedA)]: OTHER_PLIST,
        [plistOf(defApp)]: OTHER_PLIST,
      },
      executables: [binOf(movedA), binOf(defApp)],
    });
    assert.equal(nativeNotifier({ fs: wrongId, exec: () => `${movedA}\n`, home }), null);

    const notExec = makeFakeFs({
      files: {
        [appJsonPath(home)]: JSON.stringify({ bundlePath: movedA }),
        [plistOf(movedA)]: VALID_PLIST,
      },
      executables: [],
    });
    assert.equal(nativeNotifier({ fs: notExec, exec: () => `${movedA}\n`, home }), null);
  }
});

test("cli.js nativeAppInstalled, decideOpen, and findOwnedAppBundles work with moved app", () => {
  clearAppCache();
  const home = "/Users/tester";
  const moved = "/Users/tester/Desktop/Studio/tokenwise studio.app";
  const fsys = makeFakeFs({
    files: {
      [appJsonPath(home)]: JSON.stringify({ bundlePath: moved }),
      [plistOf(moved)]: VALID_PLIST,
    },
    executables: [binOf(moved)],
  });
  assert.equal(nativeAppInstalled({ fs: fsys, exec: () => "", home }), true);
  assert.equal(decideOpen({ noOpen: false, browser: false, platform: "darwin", installed: true }), "app");
  assert.equal(decideOpen({ noOpen: false, browser: true, platform: "darwin", installed: true }), "browser");
  assert.equal(decideOpen({ noOpen: true, browser: false, platform: "darwin", installed: true }), "none");
  assert.deepEqual(findOwnedAppBundles({ fs: fsys, exec: () => "", home }), [moved]);

  const missingFs = makeFakeFs();
  assert.equal(nativeAppInstalled({ fs: missingFs, exec: () => "", home }), false);
  assert.equal(decideOpen({ noOpen: false, browser: false, platform: "darwin", installed: false }), "browser");
});

test("notify() removes osascript fallback: returns false and logs once when no native app is found", () => {
  resetNotifyState();
  const prevNotify = process.env.TOKENWISE_NOTIFY;
  delete process.env.TOKENWISE_NOTIFY;
  try {
    const execCalls = [];
    const logs = [];
    const deps = {
      platform: "darwin",
      native: null,
      settings: { notifications: true, language: "en" },
      exec: (...args) => execCalls.push(args),
      log: (msg) => logs.push(msg),
    };
    assert.equal(notify({ title: "Done", message: "All good" }, deps), false);
    assert.equal(notify({ title: "Done 2", message: "Still good" }, deps), false);
    assert.equal(execCalls.length, 0);
    assert.equal(logs.length, 1);
  } finally {
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY;
    else process.env.TOKENWISE_NOTIFY = prevNotify;
    resetNotifyState();
  }
});

test("grep check: no osascript or Script Editor in notification / orchestrator / UI code", () => {
  for (const rel of ["src/notify.js", "src/appbundle.js", "src/orchestrator.js", "src/jobs.js", "src/ui.js"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(/osascript/i.test(src), false, `${rel} must not reference osascript`);
    assert.equal(/Script Editor/i.test(src), false, `${rel} must not reference Script Editor`);
  }
  const cliSrc = fs.readFileSync(path.join(ROOT, "src", "cli.js"), "utf8");
  assert.equal(/Script Editor/i.test(cliSrc), false, "src/cli.js must not mention Script Editor");

  const swiftSrc = fs.readFileSync(path.join(ROOT, "launcher", "TokenwiseStudio.swift"), "utf8");
  assert.ok(swiftSrc.includes("Bundle.main.bundlePath"));
  assert.ok(swiftSrc.includes("app.json"));
});

test("limit notification formatting (EN/TR) and deduplication in notified.json across windows", () => {
  resetNotifyState();
  const prevNotify = process.env.TOKENWISE_NOTIFY;
  delete process.env.TOKENWISE_NOTIFY;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tw-notified-home-"));
  try {
    const now = 1_700_000_000_000;
    const resetsAt = now + 2 * 3600 * 1000;
    const hhmm = formatHHMM(resetsAt);

    const enWithReset = limitHandoffNotice({ resetsAt, lang: "en" }, { now });
    assert.equal(enWithReset.title, "Codex took over");
    assert.equal(enWithReset.message, `Claude hit its limit · Codex is orchestrating until ${hhmm}`);

    const trWithReset = limitHandoffNotice({ resetsAt, lang: "tr" }, { now });
    assert.equal(trWithReset.title, "Codex devraldı");
    assert.equal(trWithReset.message, `Claude limitine ulaştı · Codex ${hhmm} saatine kadar yönetiyor`);

    const enNoReset = limitHandoffNotice({ resetsAt: null, lang: "en" }, { now });
    assert.equal(enNoReset.message, "Claude hit its limit · Codex is orchestrating");

    const trNoReset = limitHandoffNotice({ resetsAt: null, lang: "tr" }, { now });
    assert.equal(trNoReset.message, "Claude limitine ulaştı · Codex yönetiyor");

    const sentCalls = [];
    const baseDeps = {
      platform: "darwin",
      native: "/Applications/tokenwise studio.app/Contents/MacOS/tokenwise-studio",
      settings: { notifications: true, language: "en" },
      home: tmpHome,
      exec: (bin, args) => sentCalls.push({ bin, args }),
    };

    // First limit hit sends notification and persists ~/.tokenwise-studio/notified.json
    assert.equal(notifyLimitHandoff({ provider: "claude", resetsAt, subtitle: "Chat 1" }, { ...baseDeps, now }), true);
    assert.equal(sentCalls.length, 1);
    const saved = JSON.parse(fs.readFileSync(notifiedFile(tmpHome), "utf8"));
    assert.equal(saved["limit:claude"].resetsAt, resetsAt);

    // Second chat / turn before reset does NOT send another notification (even after resetNotifyState)
    resetNotifyState();
    assert.equal(notifyLimitHandoff({ provider: "claude", resetsAt, subtitle: "Chat 2" }, { ...baseDeps, now: now + 60_000 }), false);
    assert.equal(sentCalls.length, 1);

    // After resetsAt passes, notifies once for the new window
    const nextReset = resetsAt + 5 * 3600 * 1000;
    assert.equal(notifyLimitHandoff({ provider: "claude", resetsAt: nextReset, subtitle: "Chat 3" }, { ...baseDeps, now: resetsAt + 1000 }), true);
    assert.equal(sentCalls.length, 2);

    // Unknown resetsAt uses 5h window
    fs.rmSync(notifiedFile(tmpHome), { force: true });
    assert.equal(shouldNotifyLimit("claude", { now, home: tmpHome }), true);
    recordLimitNotified("claude", { resetsAt: null, now, home: tmpHome });
    assert.equal(shouldNotifyLimit("claude", { now: now + LIMIT_UNKNOWN_WINDOW_MS - 1000, home: tmpHome }), false);
    assert.equal(shouldNotifyLimit("claude", { now: now + LIMIT_UNKNOWN_WINDOW_MS, home: tmpHome }), true);
  } finally {
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY;
    else process.env.TOKENWISE_NOTIFY = prevNotify;
    resetNotifyState();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Chats.send deduplicates limit notifications across chats while Claude is cooling down", async () => {
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;
  const prevNotify = process.env.TOKENWISE_NOTIFY;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tw-chat-dedupe-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-chat-dedupe-repo-"));
  const binDir = path.join(tmpHome, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  // Fake CLIs (no real AI models called)
  fs.writeFileSync(path.join(binDir, "claude"), `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true}));\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "codex"), [
    `#!${process.execPath}`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }',
    'if (args[0] === "debug" && args[1] === "models") { console.log(JSON.stringify({ models: [{ slug: "gpt-5-codex-sol", visibility: "list", priority: 1 }] })); process.exit(0); }',
  ].join("\n"), { mode: 0o755 });

  // Fake native app recorded in app.json (so tests never touch any real app via mdfind)
  const app = defaultAppPath(tmpHome);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), VALID_PLIST);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "tokenwise-studio"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.dirname(appJsonPath(tmpHome)), { recursive: true });
  fs.writeFileSync(appJsonPath(tmpHome), JSON.stringify({ bundlePath: app }));

  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-m", "init");

  process.env.HOME = tmpHome;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
  delete process.env.TOKENWISE_NOTIFY;
  clearDoctorCache();
  clearAppCache();
  resetNotifyState();

  const fakeSpawn = () => (cmd) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (cmd === "claude") {
        child.stderr.emit("data", Buffer.from("You have hit your limit, resets in 2h\n"));
        child.emit("close", 1);
      } else {
        child.stdout.emit("data", Buffer.from(
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex reply" } }) + "\n" +
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }) + "\n"
        ));
        child.emit("close", 0);
      }
    });
    return child;
  };

  try {
    const jobs = new Jobs(repo);
    const chats = new Chats(jobs, { spawn: fakeSpawn() });
    const c1 = chats.send({ message: "first chat", model: "opus", effort: "medium" });
    await new Promise((r) => setTimeout(r, 80));
    const c1Done = chats.get(c1.id);
    assert.equal(c1Done.turns[0].agent, "codex");
    assert.ok(c1Done.turns[0].handoff);

    if (process.platform === "darwin") {
      const firstNotif = JSON.parse(fs.readFileSync(notifiedFile(tmpHome), "utf8"));
      assert.ok(firstNotif["limit:claude"], "first limit hit writes notified.json");
      const firstRecordedAt = firstNotif["limit:claude"].at;

      const c2 = chats.send({ message: "second chat", model: "opus", effort: "medium" });
      await new Promise((r) => setTimeout(r, 80));
      const c2Done = chats.get(c2.id);
      assert.equal(c2Done.turns[0].agent, "codex");

      const secondNotif = JSON.parse(fs.readFileSync(notifiedFile(tmpHome), "utf8"));
      assert.equal(secondNotif["limit:claude"].at, firstRecordedAt, "second chat must not re-notify or overwrite window");
    }
  } finally {
    process.env.HOME = prevHome;
    process.env.PATH = prevPath;
    if (prevNotify === undefined) delete process.env.TOKENWISE_NOTIFY;
    else process.env.TOKENWISE_NOTIFY = prevNotify;
    clearDoctorCache();
    clearAppCache();
    resetNotifyState();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
