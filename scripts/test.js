// Runs the test suite with an isolated HOME so tests can never touch the real ~/.tokenwise-studio.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "tw-test-home-"));
const r = spawnSync(process.execPath, ["--test", "test/"], {
  stdio: "inherit",
  env: { ...process.env, HOME: home, USERPROFILE: home, TOKENWISE_TEST: "1", TOKENWISE_NOTIFY: "0" },
});
try { rmSync(home, { recursive: true, force: true }); } catch {}
process.exit(r.status ?? 1);
