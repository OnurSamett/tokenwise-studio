// npm-installed CLIs use .cmd shims on Windows. cross-spawn handles PATH/PATHEXT,
// shebangs and Windows argument escaping; never concatenate prompts into shell text.
// Every command name is first resolved to an absolute path by walking PATH ourselves (see resolve.js),
// so a project that ships git.cmd/claude.cmd cannot get it executed through the working directory.
import crossSpawn from 'cross-spawn';
import path from 'node:path';
import { execFileSync as nativeExecFileSync, execFile as nativeExecFile } from 'node:child_process';
import { resolveTool } from './resolve.js';
export { addUntrustedDir } from './resolve.js';

const cache = new Map();
export function resolveCommand(command, options = {}) {
  if (typeof command !== 'string') return command;
  const env = options.env || process.env;
  const win = process.platform === 'win32';
  const key = [command, env.PATH ?? env.Path ?? '', options.cwd || '', process.cwd()].join('\0');
  let found = cache.get(key);
  if (found === undefined) {
    found = resolveTool(command, { env, cwd: options.cwd ? path.resolve(String(options.cwd)) : process.cwd() });
    if (found) { if (cache.size > 200) cache.clear(); cache.set(key, found); }
  }
  if (found) return found;
  // Not found: on Windows never fall back to the bare name (CreateProcess would search the cwd).
  if (win) return path.win32.join('C:\\', '__tokenwise_not_found__', command);
  return command;
}

export const spawn = (command, args, options) => crossSpawn(resolveCommand(command, options), args, options);
export const spawnSync = (command, args, options) => crossSpawn.sync(resolveCommand(command, options), args, options);
export function execFile(command, ...rest) {
  const opts = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r));
  return nativeExecFile(resolveCommand(command, opts), ...rest);
}
export function execFileSync(command, args, options = {}) {
  if (process.platform !== 'win32') return nativeExecFileSync(resolveCommand(command, options), args, options);
  const result = spawnSync(command, args, options);
  if (result.error || result.status !== 0) {
    const error = result.error || new Error(`Command failed: ${command} (exit ${result.status})`);
    Object.assign(error, { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    throw error;
  }
  return result.stdout;
}
