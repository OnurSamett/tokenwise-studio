import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectProblem, assertNotRealHomeInTests } from "../src/projectpath.js";

test("projectProblem rejects missing, system, temp and unwritable folders", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tw-pp-"));
  assert.match(projectProblem(path.join(d, "nope")), /does not exist/);
  assert.match(projectProblem("/Library/Application Support"), /system folder/);
  assert.match(projectProblem("/"), /system folder/);
  assert.match(projectProblem(d), /temporary/);
  assert.equal(projectProblem(d, { allowTemp: true }), null);
  const f = path.join(d, "file.txt"); fs.writeFileSync(f, "x");
  assert.match(projectProblem(f, { allowTemp: true }), /not a folder/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("tests run with an isolated HOME", () => {
  assert.doesNotThrow(() => assertNotRealHomeInTests());
  assert.notEqual(path.resolve(os.homedir()), path.resolve(os.userInfo().homedir));
});
