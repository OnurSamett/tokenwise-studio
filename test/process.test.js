import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync, execFile, execFileSync, resolveCommand, addUntrustedDir } from '../src/process.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Windows wrappers disable cmd current-directory lookup with custom and inherited environments', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originals = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFile: cp.execFile };
  const seen = [];
  const fake = (_command, _args, opts) => {
    if (!Array.isArray(_args)) opts = _args;
    seen.push(opts);
    return { status: 0, stdout: Buffer.from('ok') };
  };
  try {
    cp.spawn = cp.spawnSync = cp.execFile = fake;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const wrapper of [spawn, spawnSync, execFile, execFileSync]) {
      const env = { PATH: '', KEEP: 'yes', NoDefaultCurrentDirectoryInExePath: '0' };
      wrapper('C:\\tools\\node.exe', [], { env });
      assert.equal(seen.at(-1).env.NoDefaultCurrentDirectoryInExePath, '1');
      assert.equal(seen.at(-1).env.KEEP, 'yes');
      assert.equal(env.NoDefaultCurrentDirectoryInExePath, '0', 'caller environment is preserved');
      wrapper('C:\\tools\\node.exe', []);
      assert.equal(seen.at(-1).env.NoDefaultCurrentDirectoryInExePath, '1');
      assert.equal(seen.at(-1).env.HOME, process.env.HOME);
    }
    execFile('C:\\tools\\node.exe', () => {});
    assert.equal(seen.at(-1).env.NoDefaultCurrentDirectoryInExePath, '1');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.assign(cp, originals);
    syncBuiltinESMExports();
  }
});

test('registering a project invalidates previously resolved commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-resolve-cache-'));
  try {
    const tool = path.join(root, 'tw-test-tool');
    fs.writeFileSync(tool, '#!/bin/sh\n'); fs.chmodSync(tool, 0o755);
    const options = { env: { PATH: root } };
    assert.equal(resolveCommand('tw-test-tool', options), tool);
    addUntrustedDir(root);
    assert.equal(resolveCommand('tw-test-tool', options), 'tw-test-tool');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
