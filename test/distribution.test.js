import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from '../src/process.js';
import { installSource } from '../src/version.js';
import { runAutoUpdate, needsAppSetup } from '../src/autoupdate.js';
import { findAppBundle, findOwnedAppBundles } from '../src/appbundle.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('bundled distribution never runs npm updates or rebuilds its signed launcher', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-bundled-'));
  try {
    const app = path.join(tmp, 'studio.app');
    const bundleRoot = path.join(app, 'Contents', 'Resources', 'app');
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, '.bundled'), 'v24.0.0\n');
    assert.equal(installSource(bundleRoot), 'dmg');
    assert.equal(needsAppSetup({ platform: 'darwin', root: bundleRoot, app }), false);
    const unexpected = () => { throw new Error('bundled update attempted a side effect'); };
    const result = await runAutoUpdate({ source: () => 'dmg', mode: () => 'auto', updateCheck: () => true,
      current: () => '0.9.0', readState: () => ({}), latest: unexpected, lock: unexpected,
      install: unexpected, writeState: unexpected, log: unexpected });
    assert.equal(result.action, 'skip');
    assert.match(result.reason, /DMG/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Windows bundle discovery never invokes macOS commands or inspects Mac bundles', () => {
  const unexpected = () => { throw new Error('macOS operation on Windows'); };
  const deps = { platform: 'win32', fs: new Proxy({}, { get: unexpected }), exec: unexpected };
  assert.equal(findAppBundle(deps), null);
  assert.deepEqual(findOwnedAppBundles(deps), []);
});

test('CLI process adapters preserve literal shell syntax, newlines, quotes and spaced arguments', async () => {
  const args = ['a b', '"quoted"', "it's literal", '$(touch should-not-exist)', '`echo nope`', '&|<>^%PATH%', 'line\nbreak'];
  const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
  const options = { encoding: 'utf8' };
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['-e', script, ...args], options)), args);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, ['-e', script, ...args], options).stdout), args);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args]);
    let text = '';
    child.stdout.on('data', data => { text += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(text) : reject(new Error(`exit ${code}`)));
  });
  assert.deepEqual(JSON.parse(output), args);
});

test('CLI synchronous process adapter preserves failure status and stderr', () => {
  assert.throws(() => execFileSync(process.execPath, ['-e', 'process.stderr.write("expected failure"); process.exit(7)'], { encoding: 'utf8', stdio: 'pipe' }),
    error => error.status === 7 && error.stderr === 'expected failure');
});

test('release Node selection respects engines, LTS, both architectures and explicit pins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-release-node-'));
  try {
    const index = path.join(tmp, 'index.json'), pkg = path.join(tmp, 'package.json');
    const release = (version, lts = 'Test', files = ['osx-arm64-tar', 'osx-x64-tar']) => ({ version, lts, files });
    fs.writeFileSync(index, JSON.stringify([release('v30.0.0', false), release('v28.0.0', 'Test', ['osx-arm64-tar']), release('v26.2.0'), release('v26.1.0'), release('v18.0.0')]));
    fs.writeFileSync(pkg, JSON.stringify({ engines: { node: '>=20' } }));
    const select = pin => spawnSync(process.execPath, [path.join(root, 'scripts/select-node.mjs'), index, pkg, pin], { encoding: 'utf8' });
    assert.equal(select('').stdout.trim(), 'v26.2.0');
    assert.equal(select('26.1.0').stdout.trim(), 'v26.1.0');
    assert.equal(select('18.0.0').status, 1);
    assert.equal(select('28.0.0').status, 1);
    assert.equal(select('26.x').status, 1);
    fs.writeFileSync(pkg, JSON.stringify({ engines: { node: '^20' } }));
    assert.equal(select('').status, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Windows build ships no .pdb and embeds no local build path', () => {
  const s = fs.readFileSync(path.join(root, 'scripts', 'build-windows.sh'), 'utf8');
  assert.match(s, /-p:DebugType=none/);
  assert.match(s, /-p:PathMap=\$WORK\/project=\/src/);
  assert.match(s, /find "\$STAGE" -name '\*\.pdb' -delete/);
  assert.ok(s.indexOf("-name '*.pdb' -delete") < s.indexOf('zip -qr'), 'pdb removed before zipping');
});
