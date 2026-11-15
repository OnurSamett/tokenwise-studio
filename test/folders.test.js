import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";

import {
  MAX_FOLDERS,
  MAX_FOLDER_NAME,
  foldersFile,
  normalizeFolders,
  loadFolders,
  saveFolders,
  applyFolderAction,
  removeChatFromFolders,
} from "../src/folders.js";
import { Jobs } from "../src/jobs.js";
import { Chats } from "../src/orchestrator.js";
import { handler, initServer } from "../src/ui.js";
import {
  DATE_GROUPS,
  dateGroupKey,
  sortChatsByActivity,
  sortFolders,
  groupChatsByDate,
  partitionChatsByFolders,
} from "../ui/sidebar.js";

const tmp = (prefix = "tw-folders-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function callHandler(method, urlPath, bodyObj, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  const h = { host: "127.0.0.1:4790", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  req.headers = h;
  let status = 200;
  let resHeaders = {};
  const chunks = [];
  const res = {
    writeHead(code, hh = {}) { status = code; resHeaders = hh; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
  };
  const pending = handler(req, res);
  if (method === "POST") req.end(typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj ?? {}));
  else req.end();
  await pending;
  const text = Buffer.concat(chunks).toString("utf8");
  const isJson = String(resHeaders["content-type"] || "").includes("application/json");
  return { status, headers: resHeaders, text, body: isJson && text ? JSON.parse(text) : null };
}

test("normalizeFolders & loadFolders: validates structure strictly, rejects bad ids/refs, recovers from corrupt JSON", () => {
  const home = tmp("tw-fhome-");
  try {
    assert.deepEqual(loadFolders(home), { folders: [], chatFolder: {}, pinnedChats: [] });

    fs.writeFileSync(foldersFile(home), "{not json");
    assert.deepEqual(loadFolders(home), { folders: [], chatFolder: {}, pinnedChats: [] });

    const norm = normalizeFolders({
      folders: [
        { id: "work_1", name: "  Feature Work  ", pinned: true, collapsed: false },
        { id: "work_2", name: "Second", collapsed: true },
      ],
      chatFolder: {
        chat_abc: "work_1",
        chat_unfiled: null,
      },
      pinnedChats: ["chat_abc", "chat_abc", "chat_2"],
    });

    assert.equal(norm.folders.length, 2);
    assert.deepEqual(norm.folders[0], { id: "work_1", name: "Feature Work", pinned: true, collapsed: false });
    assert.deepEqual(norm.folders[1], { id: "work_2", name: "Second", pinned: false, collapsed: true });
    assert.deepEqual(norm.chatFolder, { chat_abc: "work_1" });
    assert.deepEqual(norm.pinnedChats, ["chat_abc", "chat_2"]);

    assert.throws(() => normalizeFolders({ folders: [{ id: "bad/id", name: "X" }] }), /invalid folder id/);
    assert.throws(() => normalizeFolders({ folders: [{ id: "ok", name: "   " }] }), /cannot be empty/);
    assert.throws(() => normalizeFolders({ folders: [{ id: "ok", name: "x".repeat(MAX_FOLDER_NAME + 1) }] }), /at most/);
    assert.throws(() => normalizeFolders({ folders: [{ id: "ok", name: "A" }, { id: "ok", name: "B" }] }), /duplicate folder id/);
    assert.throws(() => normalizeFolders({ folders: [], chatFolder: { c1: "missing_folder" } }), /unknown folder/);
    assert.throws(() => normalizeFolders({ unknownKey: 1 }), /unknown folders field/);

    const saved = saveFolders(home, norm);
    assert.deepEqual(loadFolders(home), saved);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("applyFolderAction: CRUD, pin, collapse, moveChat, delete preserves unfiled, removeChatFromFolders cleans up", () => {
  const home = tmp("tw-fcrud-");
  try {
    assert.throws(() => applyFolderAction(home, { action: "create", name: "   " }), /cannot be empty/);
    assert.throws(() => applyFolderAction(home, { action: "unknown" }), /unknown folders action/);

    let s = applyFolderAction(home, { action: "create", name: "Backend" });
    assert.equal(s.folders.length, 1);
    const f1 = s.folders[0].id;

    s = applyFolderAction(home, { action: "rename", id: f1, name: "Backend API" });
    assert.equal(s.folders[0].name, "Backend API");
    assert.throws(() => applyFolderAction(home, { action: "rename", id: "missing", name: "Nope" }), /unknown folder/);

    s = applyFolderAction(home, { action: "pinFolder", id: f1, pinned: true });
    assert.equal(s.folders[0].pinned, true);
    s = applyFolderAction(home, { action: "collapse", id: f1, collapsed: true });
    assert.equal(s.folders[0].collapsed, true);

    s = applyFolderAction(home, { action: "moveChat", chatId: "c1", folderId: f1 });
    assert.equal(s.chatFolder.c1, f1);
    assert.throws(() => applyFolderAction(home, { action: "moveChat", chatId: "c1", folderId: "missing" }), /unknown folder/);

    s = applyFolderAction(home, { action: "pinChat", chatId: "c1", pinned: true });
    assert.deepEqual(s.pinnedChats, ["c1"]);

    // Deleting a folder removes only the folder and leaves chats unfiled & pinned status intact
    s = applyFolderAction(home, { action: "delete", id: f1 });
    assert.deepEqual(s.folders, []);
    assert.equal(s.chatFolder.c1, undefined);
    assert.deepEqual(s.pinnedChats, ["c1"]);

    // Enforce folder cap
    for (let i = 0; i < MAX_FOLDERS; i++) {
      applyFolderAction(home, { action: "create", name: `F${i}` });
    }
    assert.throws(() => applyFolderAction(home, { action: "create", name: "Overflow" }), /at most/);

    // removeChatFromFolders cleans chatFolder & pinnedChats
    applyFolderAction(home, { action: "pinChat", chatId: "c2", pinned: true });
    removeChatFromFolders(home, "c1");
    const after = loadFolders(home);
    assert.equal(after.pinnedChats.includes("c1"), false);
    assert.equal(after.pinnedChats.includes("c2"), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("HTTP /api/folders: GET, POST actions, validation, CSRF check, and state integration", async () => {
  const repo = tmp("tw-fhttp-repo-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t.local", "-c", "user.name=T", "commit", "-q", "-m", "init"], { cwd: repo });

    await initServer({ repo });

    // Non-local Host is rejected
    const badHost = await callHandler("GET", "/api/folders", null, { host: "evil.example:4790" });
    assert.equal(badHost.status, 403);

    // POST without x-tokenwise header fails CSRF check
    const noCsrf = await callHandler("POST", "/api/folders", { action: "create", name: "X" }, { "x-tokenwise": undefined });
    assert.equal(noCsrf.status, 403);

    // Initial GET /api/folders and GET /api/state
    const g0 = await callHandler("GET", "/api/folders");
    assert.equal(g0.status, 200);
    assert.deepEqual(g0.body, { folders: [], chatFolder: {}, pinnedChats: [] });

    // POST create folder
    const c1 = await callHandler("POST", "/api/folders", { action: "create", name: "Bugfixes" });
    assert.equal(c1.status, 200);
    assert.equal(c1.body.folders.length, 1);
    const fid = c1.body.folders[0].id;

    // GET /api/state includes folders
    const st = await callHandler("GET", "/api/state");
    assert.equal(st.status, 200);
    assert.equal(st.body.folders.folders.length, 1);
    assert.equal(st.body.folders.folders[0].name, "Bugfixes");

    // POST invalid action -> 400
    const badAct = await callHandler("POST", "/api/folders", { action: "explode" });
    assert.equal(badAct.status, 400);

    // POST moveChat to non-existent folder -> 400
    const badMove = await callHandler("POST", "/api/folders", { action: "moveChat", chatId: "chat1", folderId: "nope" });
    assert.equal(badMove.status, 400);

    // POST full-state update rejects dangling chatFolder refs -> 400
    const badFull = await callHandler("POST", "/api/folders", {
      folders: [{ id: fid, name: "Bugs", pinned: true, collapsed: false }],
      chatFolder: { chat1: fid, chat2: "missing" },
      pinnedChats: ["chat1"],
    });
    assert.equal(badFull.status, 400);

    // Valid full-state update succeeds
    const full = await callHandler("POST", "/api/folders", {
      folders: [{ id: fid, name: "Bugs", pinned: true, collapsed: false }],
      chatFolder: { chat1: fid },
      pinnedChats: ["chat1"],
    });
    assert.equal(full.status, 200);
    assert.deepEqual(full.body.chatFolder, { chat1: fid });
    assert.equal(full.body.folders[0].name, "Bugs");

    // Chats.remove cleans up folders.json for removed chat
    const jobs = new Jobs(repo);
    const chats = new Chats(jobs);
    const ch = chats.save({ id: "chat1", title: "Chat 1", status: "done", turns: [], created: new Date().toISOString() });
    applyFolderAction(jobs.home, { action: "moveChat", chatId: ch.id, folderId: fid });
    applyFolderAction(jobs.home, { action: "pinChat", chatId: ch.id, pinned: true });
    chats.remove(ch.id);
    const afterDel = loadFolders(jobs.home);
    assert.equal(afterDel.chatFolder[ch.id], undefined);
    assert.equal(afterDel.pinnedChats.includes(ch.id), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("ui/sidebar.js: dateGroupKey, groupChatsByDate, sortFolders, partitionChatsByFolders", () => {
  assert.deepEqual(DATE_GROUPS, ["today", "yesterday", "week", "older"]);

  const now = new Date(2026, 4, 15, 14, 30, 0, 0); // May 15, 2026 14:30 local
  const at = (dayOffset, hour = 10, min = 0) => new Date(2026, 4, 15 - dayOffset, hour, min, 0, 0).toISOString();

  assert.equal(dateGroupKey(at(0, 0, 5), now), "today");
  assert.equal(dateGroupKey(at(1, 23, 55), now), "yesterday");
  assert.equal(dateGroupKey(at(2, 12, 0), now), "week");
  assert.equal(dateGroupKey(at(7, 0, 0), now), "week");
  assert.equal(dateGroupKey(at(8, 23, 59), now), "older");
  assert.equal(dateGroupKey(at(30, 10, 0), now), "older");
  assert.equal(dateGroupKey("invalid-date", now), "older");

  const chats = [
    { id: "c_old", title: "Old task", created: at(10) },
    { id: "c_yest", title: "Yesterday task", created: at(1, 9) },
    { id: "c_today_early", title: "Today early", created: at(0, 8), turns: [{ started: at(0, 9) }] },
    { id: "c_today_late", title: "Today late", created: at(3), turns: [{ started: at(0, 12) }] },
    { id: "c_week", title: "Week task", created: at(4) },
    { id: "c_pin", title: "Pinned old", created: at(20) },
  ];

  const sorted = sortChatsByActivity(chats);
  assert.equal(sorted[0].id, "c_today_late");
  assert.equal(sorted[1].id, "c_today_early");

  const grouped = groupChatsByDate(chats, { pinnedIds: ["c_pin"], now });
  assert.deepEqual(grouped.pinned.map((c) => c.id), ["c_pin"]);
  assert.deepEqual(grouped.groups.map((g) => [g.key, g.chats.map((c) => c.id)]), [
    ["today", ["c_today_late", "c_today_early"]],
    ["yesterday", ["c_yest"]],
    ["week", ["c_week"]],
    ["older", ["c_old"]],
  ]);

  const sf = sortFolders([
    { id: "f1", name: "Zebra", pinned: false },
    { id: "f2", name: "Beta", pinned: true },
    { id: "f3", name: "Alpha", pinned: false },
  ]);
  assert.deepEqual(sf.map((f) => f.id), ["f2", "f1", "f3"]);

  const part = partitionChatsByFolders(chats, {
    folders: sf,
    chatFolder: { c_today_late: "f2", c_week: "f2", c_old: "missing" },
    pinnedChats: ["c_pin", "c_week"],
  });
  assert.deepEqual(part.byFolder.f2.map((c) => c.id), ["c_today_late", "c_week"]);
  assert.deepEqual(part.byFolder.f3, []);
  assert.equal(part.unfiled.some((c) => c.id === "c_old"), true);
  assert.equal(part.unfiled.some((c) => c.id === "c_today_late"), false);
  assert.equal(part.pinnedIds.includes("c_week"), true);
});
