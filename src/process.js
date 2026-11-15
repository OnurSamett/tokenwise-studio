// npm-installed CLIs use .cmd shims on Windows. cross-spawn handles PATH/PATHEXT,
// shebangs and Windows argument escaping; never concatenate prompts into shell text.
import crossSpawn from 'cross-spawn';
import { execFileSync as nativeExecFileSync } from 'node:child_process';
export const spawn = crossSpawn;
export const spawnSync = crossSpawn.sync;
export function execFileSync(command, args, options = {}) {
  if (process.platform !== 'win32') return nativeExecFileSync(command, args, options);
  const result = spawnSync(command, args, options);
  if (result.error || result.status !== 0) {
    const error = result.error || new Error(`Command failed: ${command} (exit ${result.status})`);
    Object.assign(error, { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    throw error;
  }
  return result.stdout;
}
