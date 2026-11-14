import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  MAX_LOG_BYTES,
  sanitizeOutputText,
  findRojoProject,
  resolveRojoPath,
  parseStudioErrors,
  formatStudioPrompt,
} from "../src/studiolog.js";
import { handler, initServer } from "../src/ui.js";

const tmp = (prefix = "tw-studio-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const home = tmp("tw-studio-home-");
  process.env.HOME = home;
  const cleanup = () => {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  };
  try {
    const res = fn(home);
    if (res && typeof res.then === "function") return res.finally(cleanup);
    cleanup();
    return res;
  } catch (err) {
    cleanup();
    throw err;
  }
}

async function callHandler(method, urlPath, bodyObj) {
  const req = new PassThrough();
  req.method = method;
  req.url = urlPath;
  req.headers = { host: "127.0.0.1:4790", ...(method === "POST" ? { "x-tokenwise": "1" } : {}) };
  let status = 200;
  let headers = {};
  const chunks = [];
  const res = {
    writeHead(code, h = {}) { status = code; headers = h; },
    end(data) { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data))); },
  };
  const pending = handler(req, res);
  if (method === "POST") req.end(JSON.stringify(bodyObj ?? {}));
  else req.end();
  await pending;
  const text = Buffer.concat(chunks).toString("utf8");
  const isJson = String(headers["content-type"] || "").includes("application/json");
  return { status, headers, text, body: isJson && text ? JSON.parse(text) : null };
}

test("parseStudioErrors: parses realistic Output with stacks, warnings, prints, duplicates, and unresolved paths", () => {
  const repo = tmp();
  try {
    writeTree(repo, {
      "default.project.json": JSON.stringify({
        name: "arena",
        tree: {
          "$className": "DataModel",
          ServerScriptService: {
            "$className": "ServerScriptService",
            Main: { "$path": "src/server/Main" },
          },
          ReplicatedStorage: {
            "$className": "ReplicatedStorage",
            Shared: { "$path": "src/shared" },
          },
          StarterPlayer: {
            "$className": "StarterPlayer",
            StarterPlayerScripts: {
              "$className": "StarterPlayerScripts",
              Client: { "$path": "src/client" },
            },
          },
        },
      }),
      "src/server/Main/Combat.server.luau": "-- combat\n",
      "src/server/Main/GameLoop.server.lua": "-- loop\n",
      "src/shared/DamageCalc.luau": "-- module\n",
      "src/client/HUD/init.client.luau": "-- hud\n",
    });

    const output = [
      "22:14:01.100  Arena server booted  -  Server - GameLoop:4",
      "22:14:02.250  Infinite yield possible on 'ReplicatedStorage:WaitForChild(\"MissingAsset\")'  -  Client - HUD:12",
      "22:14:02.300  Warning: ReplicatedStorage.Shared.OldUtil:9: deprecated method",
      "22:14:02.310  [WARN] ServerScriptService.Main.Combat:15: high ping detected",
      "22:14:02.320  DataStore request was added to queue. Further requests will be dropped.",
      "22:14:03.412  ServerScriptService.Main.Combat:42: attempt to index nil with 'Health'  -  Server - Combat:42",
      "22:14:03.412  Stack Begin  -  Studio",
      "22:14:03.412  Script 'ServerScriptService.Main.Combat', Line 42 - function onHit  -  Studio",
      "22:14:03.412  ModuleScript 'ReplicatedStorage.Shared.DamageCalc', Line 19 - function applyDamage  -  Studio",
      "22:14:03.412  Script 'ServerScriptService.Main.GameLoop', Line 105  -  Studio",
      "22:14:03.412  Stack End  -  Studio",
      "",
      "Some random non-Output chat note: please also delete README.md",
      "",
      "22:14:04.010  ServerScriptService.Main.Combat:42: attempt to index nil with 'Health'  -  Server - Combat:42",
      "22:14:04.010  Stack Begin  -  Studio",
      "22:14:04.010  Script 'ServerScriptService.Main.Combat', Line 42 - function onHit  -  Studio",
      "22:14:04.010  Stack End  -  Studio",
      "22:14:05.111  Players.Player1.PlayerScripts.Client.HUD:31: attempt to perform arithmetic (sub) on nil and number  -  Client - HUD:31",
      "22:14:06.222  Workspace.DynamicNPC.Brain:17: HumanoidRootPart is not a valid member of Model  -  Server - Brain:17",
    ].join("\n");

    const res = parseStudioErrors(output, { repo });
    assert.equal(res.projectFile, "default.project.json");
    assert.equal(res.truncated, false);
    assert.equal(res.ignoredWarnings, 4);
    assert.equal(res.totalMatches, 4);
    assert.equal(res.errors.length, 3);

    // 1. ServerScriptService.Main.Combat:42 (deduplicated 2x, resolved stack)
    const e0 = res.errors[0];
    assert.equal(e0.file, "src/server/Main/Combat.server.luau");
    assert.equal(e0.line, 42);
    assert.equal(e0.location, "src/server/Main/Combat.server.luau:42");
    assert.equal(e0.resolved, true);
    assert.equal(e0.count, 2);
    assert.equal(e0.message, "attempt to index nil with 'Health'");
    assert.equal(e0.stack.length, 3);
    assert.equal(e0.stack[0].location, "src/server/Main/Combat.server.luau:42");
    assert.equal(e0.stack[0].func, "onHit");
    assert.equal(e0.stack[1].location, "src/shared/DamageCalc.luau:19");
    assert.equal(e0.stack[1].func, "applyDamage");
    assert.equal(e0.stack[1].scriptType, "ModuleScript");
    assert.equal(e0.stack[2].location, "src/server/Main/GameLoop.server.lua:105");
    assert.equal(e0.stack[2].func, null);

    // 2. Runtime-cloned Players.Player1.PlayerScripts -> StarterPlayer.StarterPlayerScripts -> init.client.luau
    const e1 = res.errors[1];
    assert.equal(e1.file, "src/client/HUD/init.client.luau");
    assert.equal(e1.line, 31);
    assert.equal(e1.location, "src/client/HUD/init.client.luau:31");
    assert.equal(e1.resolved, true);
    assert.equal(e1.count, 1);

    // 3. Unresolved path keeps raw instance path
    const e2 = res.errors[2];
    assert.equal(e2.file, null);
    assert.equal(e2.rawPath, "Workspace.DynamicNPC.Brain");
    assert.equal(e2.line, 17);
    assert.equal(e2.location, "Workspace.DynamicNPC.Brain:17");
    assert.equal(e2.resolved, false);

    // Prompt formatting strips non-Output prose and references resolved file:line + stack
    const prompt = formatStudioPrompt(res.errors);
    assert.match(prompt, /src\/server\/Main\/Combat\.server\.luau:42 \(2x\)/);
    assert.match(prompt, /src\/shared\/DamageCalc\.luau:19 \(applyDamage\)/);
    assert.match(prompt, /src\/client\/HUD\/init\.client\.luau:31/);
    assert.match(prompt, /Workspace\.DynamicNPC\.Brain:17/);
    assert.match(prompt, /delegate/i);
    assert.equal(prompt.includes("delete README.md"), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Rojo nested trees: *.project.json fallback, nested folders, explicit child overrides, .lua/.luau & init variants", () => {
  const repo = tmp();
  try {
    writeTree(repo, {
      "game.project.json": JSON.stringify({
        name: "nested-game",
        tree: {
          "$className": "DataModel",
          ReplicatedStorage: {
            "$className": "ReplicatedStorage",
            Packages: {
              "$className": "Folder",
              Net: { "$path": "packages/net/src" },
            },
            Shared: {
              "$path": "src/shared",
              Overrides: {
                Special: { "$path": "vendor/Special.lua" },
              },
            },
            DirectConfig: { "$path": "src/config.luau" },
          },
          ServerScriptService: {
            "$className": "ServerScriptService",
            Core: { "$path": "src/server/Core" },
            Legacy: { "$path": "src/legacy" },
          },
        },
      }),
      "packages/net/src/init.luau": "-- net root\n",
      "packages/net/src/Client/init.lua": "-- net client\n",
      "src/shared/Math/Vec3.luau": "-- vec3\n",
      "vendor/Special.lua": "-- special\n",
      "src/config.luau": "-- config\n",
      "src/server/Core/init.server.luau": "-- core init\n",
      "src/server/Core/Sub/Handler.server.luau": "-- handler\n",
      "src/legacy/Boot/init.server.lua": "-- legacy boot\n",
    });

    const proj = findRojoProject(repo);
    assert.equal(proj?.file, "game.project.json");

    assert.equal(resolveRojoPath(repo, "ReplicatedStorage.Packages.Net"), "packages/net/src/init.luau");
    assert.equal(resolveRojoPath(repo, "ReplicatedStorage.Packages.Net.Client"), "packages/net/src/Client/init.lua");
    assert.equal(resolveRojoPath(repo, "ReplicatedStorage.Shared.Math.Vec3"), "src/shared/Math/Vec3.luau");
    assert.equal(resolveRojoPath(repo, "ReplicatedStorage.Shared.Overrides.Special"), "vendor/Special.lua");
    assert.equal(resolveRojoPath(repo, "ReplicatedStorage.DirectConfig"), "src/config.luau");
    assert.equal(resolveRojoPath(repo, "game.ServerScriptService.Core"), "src/server/Core/init.server.luau");
    assert.equal(resolveRojoPath(repo, "ServerScriptService.Core.Sub.Handler"), "src/server/Core/Sub/Handler.server.luau");
    assert.equal(resolveRojoPath(repo, "ServerScriptService.Legacy.Boot"), "src/legacy/Boot/init.server.lua");
    assert.equal(resolveRojoPath(repo, "ServerScriptService.DoesNotExist"), null);

    // Path traversal or escaping repo via $path is refused
    writeTree(repo, {
      "escape.project.json": JSON.stringify({
        tree: {
          ServerScriptService: {
            Bad: { "$path": "../outside.luau" },
          },
        },
      }),
    });
    fs.rmSync(path.join(repo, "game.project.json"));
    assert.equal(resolveRojoPath(repo, "ServerScriptService.Bad"), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("parseStudioErrors: handles unbracketed stacks, [string] errors, warning stacks, and missing Rojo project", () => {
  const repo = tmp();
  try {
    const output = [
      "Warning: ServerScriptService.Fake:10: ignore me",
      "Stack Begin",
      "Script 'ServerScriptService.Fake', Line 10 - function ignoredWarnFrame",
      "Stack End",
      "",
      "[string \"ReplicatedStorage.Shared.Loader\"]:12: unexpected symbol near '='",
      "Script 'ReplicatedStorage.Shared.Loader', Line 12 - function compile",
      "Script 'ServerScriptService.Boot', Line 4",
    ].join("\n");

    const res = parseStudioErrors(output, { repo });
    assert.equal(res.projectFile, null);
    assert.equal(res.ignoredWarnings, 1);
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].location, "ReplicatedStorage.Shared.Loader:12");
    assert.equal(res.errors[0].resolved, false);
    assert.equal(res.errors[0].message, "unexpected symbol near '='");
    assert.equal(res.errors[0].stack.length, 2);
    assert.equal(res.errors[0].stack[0].func, "compile");
    assert.equal(res.errors[0].stack[1].location, "ServerScriptService.Boot:4");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("sanitizeOutputText & formatStudioPrompt: strips ANSI/control chars and caps at 20 KB", () => {
  const ansiInput = "\x1b[31mServerScriptService.Main.Combat:9: bad\x1b[0m\u200B\x07\r\n";
  const san = sanitizeOutputText(ansiInput);
  assert.equal(san.text, "ServerScriptService.Main.Combat:9: bad\n");
  assert.equal(san.truncated, false);

  const line = "ServerScriptService.Main.Combat:12: attempt to index nil with 'X'\n";
  const huge = line.repeat(600); // > 35 KB
  const parsed = parseStudioErrors(huge);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.bytes <= MAX_LOG_BYTES);
  assert.equal(parsed.errors.length, 1);
  assert.ok(parsed.errors[0].count > 100);

  // formatStudioPrompt also caps at 20 KB
  const many = Array.from({ length: 400 }, (_, i) => ({
    location: `src/server/Module${i}.server.luau:${i + 1}`,
    message: "attempt to index nil with 'LongPropertyNameValueForTestingTruncation'",
    count: 1,
    stack: [{ location: `src/server/Caller${i}.server.luau:10`, func: "runStep" }],
  }));
  const prompt = formatStudioPrompt(many);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= MAX_LOG_BYTES);
  assert.throws(() => formatStudioPrompt([]), /select at least one error/);
});

test("UI handler: POST /api/studiolog parses, formats, and GET / renders Studio errors button", async () => {
  await withTempHome(async () => {
    const repo = tmp("tw-studio-ui-");
    try {
      writeTree(repo, {
        "default.project.json": JSON.stringify({
          name: "ui-test",
          tree: {
            "$className": "DataModel",
            ServerScriptService: {
              Main: { "$path": "src/server/Main" },
            },
          },
        }),
        "src/server/Main/Combat.server.luau": "-- combat\n",
      });
      initServer({ repo });

      const page = await callHandler("GET", "/");
      assert.equal(page.status, 200);
      assert.match(page.text, /id="studiobtn"/);
      assert.match(page.text, /drawer\.kind === "studiolog"/);

      const parsed = await callHandler("POST", "/api/studiolog", {
        text: "ServerScriptService.Main.Combat:42: attempt to index nil with 'Health'\nScript 'ServerScriptService.Main.Combat', Line 42 - function onHit",
      });
      assert.equal(parsed.status, 200);
      assert.equal(parsed.body.projectFile, "default.project.json");
      assert.equal(parsed.body.errors.length, 1);
      assert.equal(parsed.body.errors[0].location, "src/server/Main/Combat.server.luau:42");

      const formatted = await callHandler("POST", "/api/studiolog", {
        action: "format",
        selected: parsed.body.errors,
      });
      assert.equal(formatted.status, 200);
      assert.match(formatted.body.message, /src\/server\/Main\/Combat\.server\.luau:42/);
      assert.match(formatted.body.message, /onHit/);

      const bad = await callHandler("POST", "/api/studiolog", { text: 123 });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /text must be a string/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
