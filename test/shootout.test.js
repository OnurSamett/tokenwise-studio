import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { Jobs } from "../src/jobs.js";
import { saveSettings } from "../src/settings.js";
import { saveTeam } from "../src/team.js";
import { handler } from "../src/ui.js";
import {
  SHOOTOUT_TTL_MS,
  writeShootoutGate,
  readShootoutGate,
  clearShootoutGate,
  resolveTurnShootoutId,
  registerShootoutJob,
  startShootout,
  listShootouts,
  getShootout,
  pickShootout,
  discardShootout,
  pruneExpiredShootouts,
} from "../src/shootout.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-shootout-home-"));
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withTempPath(extraBin, fn) {
  const prevPath = process.env.PATH || "";
  process.env.PATH = `${extraBin}:${prevPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prevPath;
  }
}

function initRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tw-shootout-repo-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Tester");
  fs.writeFileSync(path.join(repo, "app.txt"), "base line\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "shootout-fixture",
    scripts: { test: "node -e \"console.log('fixture tests ok')\"" },
  }, null, 2));
  g("add", ".");
  g("commit", "-qm", "init");
  return { repo, g };
}

function makeFakeBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tw-shootout-bin-"));
  const codexScript = `#!/bin/sh
if [ "$1" = "debug" ]; then
  echo '{"models":[{"slug":"fake-codex-sol","visibility":"list","priority":1},{"slug":"fake-codex-terra","visibility":"list","priority":2},{"slug":"fake-codex-luna","visibility":"list","priority":3}]}'
  exit 0
fi
if [ "$1" = "login" ]; then
  echo 'Logged in'
  exit 0
fi
printf "codex-impl\\nline2\\n" > feature.txt
echo '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":200,"output_tokens":350}}'
`;
  const claudeScript = `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo '{"loggedIn":true}'
  exit 0
fi
if [ -d ".tokenwise-studio/chats" ]; then
  for f in .tokenwise-studio/chats/*.shootout; do
    if [ -f "$f" ]; then
      cp "$f" ".tokenwise-studio/chats/observed-gate.json"
    fi
  done
fi
printf "claude-impl\\nline2\\nline3\\n" > feature.txt
echo '{"type":"result","result":"Implemented by fake claude","usage":{"input_tokens":900,"cache_read_input_tokens":100,"output_tokens":420},"total_cost_usd":0.0123}'
`;
  const geminiScript = `#!/bin/sh
printf "gemini-impl\\n" > feature.txt
echo '{"type":"result","result":"Implemented by fake gemini","stats":{"input_tokens":700,"output_tokens":210}}'
`;
  for (const [name, body] of [["codex", codexScript], ["claude", claudeScript], ["gemini", geminiScript]]) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
  }
  return bin;
}

function makeCandidateJob(repo, jobs, id, agent, model, shootoutId, editFn, extra = {}) {
  const wt = path.join(jobs.home, "worktrees", id);
  const br = `tokenwise/${id}`;
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", br, wt, "HEAD"], { stdio: "pipe" });
  editFn(wt);
  execFileSync("git", ["-C", wt, "add", "-A"], { stdio: "pipe" });
  const files = execFileSync("git", ["-C", wt, "diff", "--cached", "--name-only", "HEAD"], { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const diff = execFileSync("git", ["-C", wt, "diff", "--cached", "--binary", "HEAD"]);
  fs.writeFileSync(jobs.file(id, "diff"), diff);
  const now = extra.created || new Date().toISOString();
  const job = {
    id,
    title: extra.title || "Compare solution",
    task: extra.task || "Implement feature.txt",
    agent,
    model,
    effort: extra.effort || "medium",
    write: true,
    parent: extra.parent ?? null,
    cwd: wt,
    branch: br,
    base: head,
    status: extra.status || "done",
    created: now,
    finished: extra.status === "running" ? null : (extra.finished || now),
    files,
    tokens: extra.tokens || { input: 1000, cached: 0, output: 300 },
    cost: extra.cost ?? null,
    final: extra.final || `Done by ${agent}/${model}`,
    shootout: shootoutId,
  };
  jobs.save(job);
  registerShootoutJob(jobs.home, shootoutId, job);
  return job;
}

async function callHandler(method, urlPath, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", "sec-fetch-site": "same-origin", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
  let status = 200;
  const chunks = [];
  const res = {
    writeHead(code) { status = code; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
  };
  const pending = handler(req, res);
  if (method === "POST") req.end(JSON.stringify(bodyObj ?? {}));
  else req.end();
  await pending;
  const text = Buffer.concat(chunks).toString("utf8");
  return { status, body: text ? JSON.parse(text) : null };
}

test("startShootout validates inputs, starts 2-3 parallel worktrees, and sibling conflicts are ignored", async () => {
  await withTempHome(async () => {
    const { repo } = initRepo();
    const fakeBin = makeFakeBin();
    try {
      const jobs = new Jobs(repo);

      assert.throws(
        () => startShootout(jobs, { task: "x", workers: [{ agent: "codex", model: "gpt-5-codex" }] }),
        /2 to 3/,
      );
      assert.throws(
        () => startShootout(jobs, {
          task: "x",
          workers: [
            { agent: "codex", model: "gpt-5-codex" },
            { agent: "claude", model: "sonnet" },
            { agent: "gemini", model: "argon" },
            { agent: "claude", model: "haiku" },
          ],
        }),
        /2 to 3/,
      );
      assert.throws(
        () => startShootout(jobs, {
          task: "   ",
          workers: [{ agent: "codex", model: "gpt-5-codex" }, { agent: "claude", model: "sonnet" }],
        }),
        /empty/,
      );

      saveTeam(jobs.home, { allow: { free: false, astra: false } });
      assert.throws(
        () => startShootout(jobs, {
          task: "Test free disabled",
          workers: [{ agent: "free", model: "auto" }, { agent: "claude", model: "sonnet" }],
        }),
        /free workers are disabled/,
      );

      saveSettings({ permissionMode: "plan-only" });
      assert.throws(
        () => startShootout(jobs, {
          task: "Blocked in plan-only",
          workers: [{ agent: "codex", model: "gpt-5-codex" }, { agent: "claude", model: "sonnet" }],
        }),
        /plan-only/,
      );
      saveSettings({ permissionMode: "ask" });

      const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "tw-shootout-nongit-"));
      try {
        assert.throws(
          () => startShootout(new Jobs(nonGit), {
            task: "Needs git",
            workers: [{ agent: "codex", model: "gpt-5-codex" }, { agent: "claude", model: "sonnet" }],
          }),
          /git repository/,
        );
      } finally {
        fs.rmSync(nonGit, { recursive: true, force: true });
      }

      const started = await withTempPath(fakeBin, async () => {
        const res = startShootout(jobs, {
          task: "Implement feature.txt cleanly",
          workers: [
            { agent: "codex", model: "gpt-5-codex", effort: "medium" },
            { agent: "claude", model: "sonnet", effort: "low" },
          ],
          parent: "chat-test",
        });
        assert.equal(res.shootout.jobIds.length, 2);
        assert.equal(res.shootout.parent, "chat-test");
        assert.equal(res.jobs.length, 2);
        assert.equal(res.jobs[0].shootout, res.shootout.id);
        assert.equal(res.jobs[1].shootout, res.shootout.id);
        await Promise.all(res.jobs.map((j) => jobs.wait(j.id)));
        return res;
      });

      const list = listShootouts(jobs);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, started.shootout.id);
      assert.equal(list[0].status, "ready");
      assert.equal(list[0].readyCount, 2);
      assert.equal(list[0].testConfigured, true);

      const detail = getShootout(jobs, started.shootout.id);
      assert.equal(detail.candidates.length, 2);
      assert.equal(detail.testCommand, "npm test");
      for (const c of detail.candidates) {
        assert.equal(c.job.status, "done");
        assert.ok(c.stats.filesCount >= 1);
        assert.ok(c.stats.additions >= 2);
        assert.equal(c.conflicts.clean, true, "shootout siblings must not flag each other as conflicts");
        assert.equal(c.conflicts.overlaps.length, 0);
        assert.ok(c.usage.total > 0);
      }
      assert.equal(detail.candidates[1].usage.cost, 0.0123);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("pickShootout applies winner (with Undo Apply) and discards other candidates; discardShootout discards all", async () => {
  await withTempHome(async () => {
    const { repo, g } = initRepo();
    try {
      const jobs = new Jobs(repo);
      const soId = "so-20261115000001-ab12";
      const j1 = makeCandidateJob(repo, jobs, "20261115000001-c1", "codex", "sol", soId, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "winner codex content\n");
      });
      const j2 = makeCandidateJob(repo, jobs, "20261115000002-c2", "claude", "sonnet", soId, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "loser claude content\n");
      });
      const j3 = makeCandidateJob(repo, jobs, "20261115000003-c3", "gemini", "argon", soId, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "loser gemini content\n");
      });

      const res = pickShootout(jobs, soId, j1.id, { autoCheck: false });
      assert.equal(res.shootout.pickedJobId, j1.id);
      assert.deepEqual(res.discardedIds.sort(), [j2.id, j3.id].sort());
      assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "winner codex content\n");
      assert.equal(jobs.get(j1.id).status, "merged");
      assert.ok(jobs.get(j1.id).applySnapshot, "picked job stores applySnapshot for Undo Apply");
      assert.equal(jobs.get(j2.id).status, "discarded");
      assert.equal(jobs.get(j3.id).status, "discarded");
      assert.equal(fs.existsSync(j2.cwd), false);
      assert.equal(fs.existsSync(j3.cwd), false);
      const branches = g("branch");
      assert.equal(branches.includes(j2.branch), false);
      assert.equal(branches.includes(j3.branch), false);

      assert.throws(() => pickShootout(jobs, soId, j2.id), /already picked/);

      // Undo Apply works normally on the picked candidate.
      jobs.undo(j1.id);
      assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8"), "base line\n");
      assert.equal(jobs.get(j1.id).status, "undone");

      // Separate shootout discarded wholesale.
      const so2 = "so-20261115000004-cd34";
      const d1 = makeCandidateJob(repo, jobs, "20261115000004-d1", "codex", "sol", so2, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "discarded 1\n");
      });
      const d2 = makeCandidateJob(repo, jobs, "20261115000005-d2", "claude", "sonnet", so2, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "discarded 2\n");
      });
      const dRes = discardShootout(jobs, so2);
      assert.deepEqual(dRes.discardedIds.sort(), [d1.id, d2.id].sort());
      assert.equal(getShootout(jobs, so2).shootout.status, "discarded");
      assert.equal(fs.existsSync(d1.cwd), false);
      assert.equal(fs.existsSync(d2.cwd), false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("pruneExpiredShootouts keeps unpicked worktrees before 24h and discards them after 24h", async () => {
  await withTempHome(async () => {
    const { repo, g } = initRepo();
    try {
      const jobs = new Jobs(repo);
      const createdMs = Date.UTC(2026, 10, 14, 12, 0, 0);
      const soId = "so-20261114120000-ef56";
      const j1 = makeCandidateJob(repo, jobs, "20261114120001-e1", "codex", "sol", soId, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "old 1\n");
      }, { created: new Date(createdMs).toISOString() });
      const j2 = makeCandidateJob(repo, jobs, "20261114120002-e2", "claude", "sonnet", soId, (wt) => {
        fs.writeFileSync(path.join(wt, "app.txt"), "old 2\n");
      }, { created: new Date(createdMs).toISOString() });

      const before = pruneExpiredShootouts(jobs, { now: createdMs + SHOOTOUT_TTL_MS - 1000 });
      assert.deepEqual(before.prunedShootoutIds, []);
      assert.equal(fs.existsSync(j1.cwd), true);
      assert.equal(fs.existsSync(j2.cwd), true);

      const after = pruneExpiredShootouts(jobs, { now: createdMs + SHOOTOUT_TTL_MS + 1000 });
      assert.deepEqual(after.prunedShootoutIds, [soId]);
      assert.deepEqual(after.discardedJobIds.sort(), [j1.id, j2.id].sort());
      assert.equal(fs.existsSync(j1.cwd), false);
      assert.equal(fs.existsSync(j2.cwd), false);
      assert.equal(g("branch").includes(j1.branch), false);
      assert.equal(g("branch").includes(j2.branch), false);
      assert.equal(getShootout(jobs, soId).shootout.status, "expired");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("MCP delegate shootout param is gated by the per-turn flag and groups candidates", async () => {
  await withTempHome(async (home) => {
    const { repo } = initRepo();
    const fakeBin = makeFakeBin();
    const chatId = "c-gate-test";
    const client = new Client({ name: "shootout-mcp-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "src", "mcp.js")],
      env: {
        ...process.env,
        HOME: home,
        TOKENWISE_REPO: repo,
        TOKENWISE_PARENT: chatId,
        TOKENWISE_NOTIFY: "0",
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    try {
      const jobs = new Jobs(repo);
      await client.connect(transport);

      // 1. No gate file -> refused.
      const denied1 = await client.callTool({
        name: "delegate",
        arguments: { agent: "claude", model: "sonnet", task: "Try shootout task", write: true, shootout: true },
      });
      assert.equal(denied1.isError, true);
      assert.match(denied1.content[0].text, /asked for it/i);

      // 2. Gate explicitly allowed: false -> refused.
      writeShootoutGate(jobs.home, chatId, { turn: 1, allowed: false });
      const denied2 = await client.callTool({
        name: "delegate",
        arguments: { agent: "claude", model: "sonnet", task: "Try shootout task", write: true, shootout: "cmp1" },
      });
      assert.equal(denied2.isError, true);

      // 3. Gate allowed: true -> read-only shootout still rejected, write shootout allowed & grouped.
      writeShootoutGate(jobs.home, chatId, { turn: 2, allowed: true });
      const roDenied = await client.callTool({
        name: "delegate",
        arguments: { agent: "claude", model: "sonnet", task: "Read only shootout task", write: false, shootout: "cmp1" },
      });
      assert.equal(roDenied.isError, true);
      assert.match(roDenied.content[0].text, /write=true/i);

      const d1 = await client.callTool({
        name: "delegate",
        arguments: { agent: "codex", model: "gpt-5-codex", task: "Implement candidate A", write: true, shootout: "cmp1" },
      });
      assert.notEqual(d1.isError, true, d1.content?.[0]?.text);
      const r1 = JSON.parse(d1.content[0].text);

      const d2 = await client.callTool({
        name: "delegate",
        arguments: { agent: "claude", model: "sonnet", task: "Implement candidate B", write: true, shootout: "cmp1" },
      });
      assert.notEqual(d2.isError, true, d2.content?.[0]?.text);
      const r2 = JSON.parse(d2.content[0].text);

      assert.ok(r1.shootout && r1.shootout.startsWith("so-"));
      assert.equal(r1.shootout, r2.shootout);

      await Promise.all([r1.id, r2.id].map((id) => client.callTool({ name: "job_wait", arguments: { id } })));
      const shootouts = listShootouts(jobs);
      assert.equal(shootouts.length, 1);
      assert.equal(shootouts[0].id, r1.shootout);
      assert.deepEqual(shootouts[0].jobIds, [r1.id, r2.id]);

      // 4. Clearing the per-turn gate blocks subsequent shootout calls.
      clearShootoutGate(jobs.home, chatId, 2);
      assert.equal(readShootoutGate(jobs.home, chatId).allowed, false);
      const deniedAfterClear = await client.callTool({
        name: "delegate",
        arguments: { agent: "claude", model: "sonnet", task: "After clear shootout", write: true, shootout: "cmp1" },
      });
      assert.equal(deniedAfterClear.isError, true);

      assert.throws(() => resolveTurnShootoutId(jobs.home, null, true), /current chat message/);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("UI HTTP endpoints expose shootouts, start/compare/pick/discard, and per-turn chat shootout flag", async () => {
  await withTempHome(async () => {
    const { repo } = initRepo();
    const fakeBin = makeFakeBin();
    try {
      const opened = await callHandler("POST", "/api/project", { path: repo });
      assert.equal(opened.status, 200);

      const waitShootout = async (id) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const d = await callHandler("GET", `/api/shootout/${id}`);
          if (d.status === 200 && d.body.candidates.every((c) => c.job.status !== "running")) return d;
          await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error(`shootout ${id} did not finish in time`);
      };

      await withTempPath(fakeBin, async () => {
        const started = await callHandler("POST", "/api/shootout", {
          task: "Write feature.txt",
          workers: [
            { agent: "codex", model: "gpt-5-codex", effort: "medium" },
            { agent: "claude", model: "sonnet", effort: "medium" },
          ],
        });
        assert.equal(started.status, 200);
        const soId = started.body.shootout.id;
        assert.equal(started.body.jobs.length, 2);

        const detail = await waitShootout(soId);
        const jobs = new Jobs(repo);

        const st = await callHandler("GET", "/api/state");
        assert.equal(st.status, 200);
        assert.ok(Array.isArray(st.body.shootouts));
        const item = st.body.shootouts.find((s) => s.id === soId);
        assert.ok(item);
        assert.equal(item.status, "ready");

        assert.equal(detail.status, 200);
        assert.equal(detail.body.candidates.length, 2);
        assert.equal(detail.body.testConfigured, true);

        const pickId = started.body.jobs[1].id;
        const picked = await callHandler("POST", `/api/shootout-pick/${soId}`, { jobId: pickId, autoCheck: false });
        assert.equal(picked.status, 200);
        assert.equal(picked.body.shootout.pickedJobId, pickId);
        assert.match(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), /claude-impl/);
        assert.equal(fs.existsSync(started.body.jobs[0].cwd), false);

        // Undo applied change via HTTP API too.
        const undone = await callHandler("POST", `/api/undo/${pickId}`, {});
        assert.equal(undone.status, 200);
        assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);

        // Start a second shootout and discard it via HTTP API.
        const s2 = await callHandler("POST", "/api/shootout", {
          task: "Write another feature",
          workers: [
            { agent: "codex", model: "gpt-5-codex" },
            { agent: "claude", model: "haiku" },
          ],
        });
        assert.equal(s2.status, 200);
        await waitShootout(s2.body.shootout.id);
        const disc = await callHandler("POST", `/api/shootout-discard/${s2.body.shootout.id}`, {});
        assert.equal(disc.status, 200);
        assert.equal(disc.body.discardedIds.length, 2);
        assert.equal(fs.existsSync(s2.body.jobs[0].cwd), false);

        // Per-turn shootout gate: POST /api/chat with shootout: true sets allowed: true during turn and clears on finish.
        const chatRes = await callHandler("POST", "/api/chat", {
          message: "Compare claude and codex on this change",
          model: "haiku",
          shootout: true,
        });
        assert.equal(chatRes.status, 200);
        const cid = chatRes.body.id;
        // Wait for fake claude orchestrator turn to finish.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const sNow = await callHandler("GET", "/api/state");
          const ch = sNow.body.chats.find((c) => c.id === cid);
          if (ch && ch.status !== "running") break;
          await new Promise((r) => setTimeout(r, 40));
        }
        const gateObserved = JSON.parse(fs.readFileSync(path.join(jobs.home, "chats", "observed-gate.json"), "utf8"));
        assert.equal(gateObserved.allowed, true);
        const gateAfter = readShootoutGate(jobs.home, cid);
        assert.equal(gateAfter.allowed, false);
      });
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
