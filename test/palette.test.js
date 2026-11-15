import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { fuzzyMatch, filterPaletteItems, formatShortcut } from "../ui/palette.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { handler, initServer } from "../src/ui.js";

const tmp = (prefix = "tw-pal-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("ui/palette.js: fuzzyMatch scoring, indices, and boundary preference", () => {
  assert.deepEqual(fuzzyMatch("", "New task"), { score: 0, indices: [] });
  assert.equal(fuzzyMatch("xyz", "New task"), null);
  assert.equal(fuzzyMatch("ntask", "abc"), null);

  const exact = fuzzyMatch("settings", "Settings");
  const sub = fuzzyMatch("settings", "Open user settings panel");
  assert.ok(exact && sub);
  assert.ok(exact.score > sub.score);
  assert.deepEqual(exact.indices, [0, 1, 2, 3, 4, 5, 6, 7]);

  const boundary = fuzzyMatch("nt", "New task");
  const scattered = fuzzyMatch("nt", "n...t...end");
  assert.ok(boundary && scattered);
  assert.ok(boundary.score > scattered.score);
  assert.deepEqual(boundary.indices, [0, 4]);

  // Keyword match succeeds even when label has no match
  const kw = fuzzyMatch("tema", "Switch theme", "tema karanlik aydinlik");
  assert.ok(kw);
  assert.deepEqual(kw.indices, []);
});

test("ui/palette.js: filterPaletteItems ranks matches and formatShortcut adapts per OS", () => {
  const items = [
    { id: "1", label: "Open folder...", keywords: "project repo" },
    { id: "2", label: "Switch theme", keywords: "dark light" },
    { id: "3", label: "New task", keywords: "create chat" },
    { id: "4", label: "Model guide", keywords: "benchmarks" },
  ];

  const all = filterPaletteItems("   ", items);
  assert.equal(all.length, 4);
  assert.equal(all[0].item.id, "1");

  const filtered = filterPaletteItems("nt", items);
  assert.equal(filtered[0].item.id, "3"); // "New task" beats anything with scattered letters

  const kwFiltered = filterPaletteItems("bench", items);
  assert.equal(kwFiltered.length, 1);
  assert.equal(kwFiltered[0].item.id, "4");

  assert.deepEqual(formatShortcut("⌘ K", true), ["⌘", "K"]);
  assert.deepEqual(formatShortcut("⌘ K", false), ["Ctrl", "K"]);
  assert.deepEqual(formatShortcut("⌘ ⇧ N", false), ["Ctrl", "Shift", "N"]);
});

test("settings.js: animations defaults to true, persists, and validates boolean", () => {
  const prevHome = process.env.HOME;
  const home = tmp("tw-anim-home-");
  process.env.HOME = home;
  try {
    const s0 = loadSettings();
    assert.equal(s0.animations, true);

    const s1 = saveSettings({ animations: false });
    assert.equal(s1.animations, false);
    assert.equal(loadSettings().animations, false);

    const s2 = saveSettings({ animations: true });
    assert.equal(s2.animations, true);

    assert.throws(() => saveSettings({ animations: "yes" }), /true or false/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("UI static server serves /sidebar.js and /palette.js modules", async () => {
  const repo = tmp("tw-uimod-repo-");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t.local", "-c", "user.name=T", "commit", "-q", "-m", "init"], { cwd: repo });

    await initServer({ repo });

    for (const p of ["/sidebar.js", "/palette.js"]) {
      const req = new PassThrough();
      req.method = "GET";
      req.url = p;
      req.headers = { host: "127.0.0.1:4790" };
      let status = 0;
      let headers = {};
      const chunks = [];
      const res = {
        writeHead(c, h = {}) { status = c; headers = h; },
        end(d) { if (d) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); },
      };
      req.end();
      await handler(req, res);
      assert.equal(status, 200);
      assert.match(String(headers["content-type"]), /application\/javascript/);
      assert.ok(Buffer.concat(chunks).toString("utf8").includes("export function"));
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
