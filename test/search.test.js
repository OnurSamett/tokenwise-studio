import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";

import { normalizeSearchText, normalizeWithMap, matchText, buildSnippet, searchChats } from "../src/search.js";
import { Jobs } from "../src/jobs.js";
import { Chats } from "../src/orchestrator.js";
import { handler, initServer } from "../src/ui.js";

const tmp = (prefix = "tw-search-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function makeRepo() {
  const repo = tmp("tw-search-repo-");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t.local", "-c", "user.name=T", "commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

test("normalizeSearchText and normalizeWithMap handle case, diacritics, and Turkish ı/İ/ş/ğ/ü/ö/ç", () => {
  assert.equal(normalizeSearchText("İstanbul'da IŞIK ve ışık"), "istanbul'da isik ve isik");
  assert.equal(normalizeSearchText("Şahin Çağrı Güncelleme Özellik"), "sahin cagri guncelleme ozellik");
  assert.equal(normalizeSearchText("Café Über Résumé"), "cafe uber resume");

  const sample = "İstanbul'da ışık ve özellik güncellemesi";
  const m = matchText(sample, { normQuery: "istanbul isik guncellemesi", tokens: ["istanbul", "isik", "guncellemesi"] });
  assert.ok(m);
  const slices = m.ranges.map(([a, b]) => sample.slice(a, b));
  assert.deepEqual(slices, ["İstanbul", "ışık", "güncellemesi"]);

  // Decomposed Unicode (I + combining dot above) maps cleanly back to full cluster
  const decomposed = "I\u0307stanbul";
  const { norm, spans } = normalizeWithMap(decomposed);
  assert.equal(norm, "istanbul");
  assert.equal(decomposed.slice(spans[0][0], spans[0][1]), "I\u0307");
});

test("searchChats ranks titles > user messages > replies, builds accurate snippets, and searches jsonl replies", () => {
  const repo = makeRepo();
  try {
    const jobs = new Jobs(repo);
    const chats = new Chats(jobs);

    // Older chat with match in reply
    chats.save({
      id: "chat-reply",
      title: "Database cleanup",
      created: "2026-11-20T10:00:00.000Z",
      turns: [{
        user: "Check old records",
        reply: "Found an authentication token leak in the legacy session handler and fixed it.",
        started: "2026-11-20T10:00:05.000Z",
        finished: "2026-11-20T10:01:00.000Z",
      }],
    });

    // Chat with match in user message
    chats.save({
      id: "chat-user",
      title: "Login screen polish",
      created: "2026-11-21T10:00:00.000Z",
      turns: [{
        user: "Update authentication middleware to reject expired cookies",
        reply: "Done.",
        started: "2026-11-21T10:00:05.000Z",
        finished: "2026-11-21T10:01:00.000Z",
      }],
    });

    // Chat with match in title
    chats.save({
      id: "chat-title",
      title: "Authentication refactor",
      created: "2026-11-19T10:00:00.000Z",
      turns: [{
        user: "Split helpers",
        reply: "Moved helpers.",
        started: "2026-11-19T10:00:05.000Z",
        finished: "2026-11-19T10:01:00.000Z",
      }],
    });

    // Chat with intermediate Claude 'say' text stored only in jsonl
    chats.save({
      id: "chat-jsonl",
      title: "Turkish text fix",
      created: "2026-11-22T10:00:00.000Z",
      turns: [{
        user: "Şifre sıfırlama bağlantısını kontrol et",
        reply: "Tamamlandı.",
        started: "2026-11-22T10:00:05.000Z",
        finished: "2026-11-22T10:01:00.000Z",
      }],
    });
    fs.writeFileSync(
      chats.f("chat-jsonl", "jsonl"),
      JSON.stringify({
        t: Date.now(),
        stream: "out",
        turn: 0,
        agent: "claude",
        line: JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Çağrı akışındaki authentication doğrulaması güncellendi." }] },
        }),
      }) + "\n",
    );

    const res = searchChats({ chats, repo, query: "authentication", limit: 10 });
    assert.equal(res.results.length, 4);
    assert.equal(res.results[0].chatId, "chat-title");
    assert.equal(res.results[0].kind, "title");
    assert.equal(res.results[1].chatId, "chat-user");
    assert.equal(res.results[1].kind, "user");
    assert.ok(["chat-jsonl", "chat-reply"].includes(res.results[2].chatId));
    assert.equal(res.results[2].kind, "reply");

    // Verify Turkish query matches diacritic-insensitively and highlights original Turkish text
    const trRes = searchChats({ chats, repo, query: "sifre baglantisini cagri", limit: 10 });
    assert.equal(trRes.results.length, 0); // not all 3 in the same message
    const trUser = searchChats({ chats, repo, query: "sifre baglantisini", limit: 10 });
    assert.equal(trUser.results.length, 1);
    assert.equal(trUser.results[0].chatId, "chat-jsonl");
    assert.equal(trUser.results[0].kind, "user");
    assert.deepEqual(
      trUser.results[0].matches.map(([a, b]) => trUser.results[0].snippet.slice(a, b)),
      ["Şifre", "bağlantısını"],
    );

    // Long text snippet clipping preserves exact highlight slice
    const longBody = `${"prefix ".repeat(25)}targetMatchToken${" suffix".repeat(25)}`;
    const mLong = matchText(longBody, { normQuery: "targetmatchtoken", tokens: ["targetmatchtoken"] });
    const snip = buildSnippet(mLong.clean, mLong.ranges, 80);
    assert.ok(snip.snippet.length <= 82);
    assert.equal(snip.matches.length, 1);
    assert.equal(snip.snippet.slice(snip.matches[0][0], snip.matches[0][1]), "targetMatchToken");

    // Empty query returns empty results
    assert.deepEqual(searchChats({ chats, repo, query: "   " }), { query: "", total: 0, results: [] });

    // Limit is respected
    assert.equal(searchChats({ chats, repo, query: "authentication", limit: 2 }).results.length, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("GET /api/search?q= searches project chats and enforces local access rules", async () => {
  const repo = makeRepo();
  try {
    await initServer({ repo });
    const jobs = new Jobs(repo);
    const chats = new Chats(jobs);
    chats.save({
      id: "chat-api-1",
      title: "Ödeme ekranı hatası",
      created: "2026-11-24T10:00:00.000Z",
      turns: [{
        user: "İndirim kuponu uygulanmıyor",
        reply: "Çözüm: kupon doğrulaması düzeltildi.",
        started: "2026-11-24T10:00:01.000Z",
        finished: "2026-11-24T10:00:10.000Z",
      }],
    });

    const call = async (url, headers = { host: "127.0.0.1:4790", "x-tokenwise": "1" }) => {
      const req = new PassThrough();
      req.method = "GET";
      req.url = url;
      req.headers = headers;
      let status = 0;
      const chunks = [];
      const res = {
        writeHead(c) { status = c; },
        end(d) { if (d) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); },
      };
      req.end();
      await handler(req, res);
      return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    };

    const hit = await call("/api/search?q=indirim%20kuponu");
    assert.equal(hit.status, 200);
    assert.equal(hit.body.results.length, 1);
    assert.equal(hit.body.results[0].chatId, "chat-api-1");
    assert.equal(hit.body.results[0].kind, "user");
    assert.equal(hit.body.results[0].turn, 0);

    const trHit = await call("/api/search?q=odeme");
    assert.equal(trHit.status, 200);
    assert.equal(trHit.body.results[0].kind, "title");

    const forbidden = await call("/api/search?q=odeme", { host: "evil.example:4790", "x-tokenwise": "1" });
    assert.equal(forbidden.status, 403);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
