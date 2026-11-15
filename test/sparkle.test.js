import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readPublicKey, updateAppcast } from '../scripts/update-appcast.mjs';
import { hasForbiddenModifier } from '../src/studioproxy.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sparkle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyFile = path.join(dir, 'public.txt'), dmg = path.join(dir, 'app.dmg');
  const appcast = path.join(dir, 'appcast.xml'), notes = path.join(dir, 'notes.md');
  fs.writeFileSync(publicKeyFile, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') + '\n');
  fs.writeFileSync(dmg, 'final stapled DMG bytes');
  fs.writeFileSync(appcast, '<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">\n  <channel>\n    <title>Test updates</title>\n  </channel>\n</rss>\n');
  fs.writeFileSync(notes, '## 1.2.3 (2026-11-15)\n\nRelease notes');
  const signature = sign(null, fs.readFileSync(dmg), privateKey).toString('base64');
  return { version: '1.2.3', dmg, signature, publicKeyFile, appcast, notes, now: new Date('2026-11-15T12:00:00Z'), privateKey };
}

test('Sparkle feed records verified stapled bytes, version, date and released CHANGELOG anchor', t => {
  const f = fixture(t);
  updateAppcast(f);
  const feed = fs.readFileSync(f.appcast, 'utf8');
  assert.match(feed, /<pubDate>Sun, 15 Nov 2026 12:00:00 GMT<\/pubDate>/);
  assert.match(feed, /<sparkle:minimumSystemVersion>13\.0<\/sparkle:minimumSystemVersion>/);
  assert.ok(feed.includes(`/download/v1.2.3/tokenwise-studio-1.2.3.dmg" sparkle:edSignature="${f.signature}" length="${fs.statSync(f.dmg).size}"`));
  assert.ok(feed.includes('/blob/v1.2.3/CHANGELOG.md#123-2026-11-15'));
  assert.throws(() => updateAppcast(f), /already contains/);
  assert.equal(fs.readFileSync(f.appcast, 'utf8'), feed);
  f.version = '1.2.4';
  fs.writeFileSync(f.notes, '## 1.2.4\nNew release');
  updateAppcast(f);
  const next = fs.readFileSync(f.appcast, 'utf8');
  assert.ok(next.indexOf('<title>1.2.4</title>') < next.indexOf('<title>1.2.3</title>'));
});

test('Sparkle rejects modified DMGs, wrong keys and placeholders without changing the feed', t => {
  const f = fixture(t), original = fs.readFileSync(f.appcast, 'utf8');
  fs.appendFileSync(f.dmg, 'changed after signing');
  assert.throws(() => updateAppcast(f), /signature does not match/);
  f.signature = sign(null, fs.readFileSync(f.dmg), generateKeyPairSync('ed25519').privateKey).toString('base64');
  assert.throws(() => updateAppcast(f), /signature does not match/);
  fs.writeFileSync(f.publicKeyFile, 'REPLACE_BY_RUNNING_SCRIPTS_SPARKLE_KEYS_SH\n');
  assert.throws(() => readPublicKey(f.publicKeyFile), /Invalid public key/);
  assert.equal(fs.readFileSync(f.appcast, 'utf8'), original);
});

test('Roblox modifier names are rejected in nested key arguments; ordinary play keys remain usable', () => {
  for (const modifier of ['Control', 'Ctrl', 'Alt', 'Option', 'Meta', 'Super', 'Command', 'Cmd']) {
    for (const side of ['', 'Left', 'Right']) {
      assert.equal(hasForbiddenModifier({ args: { keys: [`Enum.KeyCode.${side}${modifier}`] } }), true);
    }
  }
  for (const key of ['W', 'Space', 'LeftShift', 'RightShift', 'E', 'ArrowLeft']) {
    assert.equal(hasForbiddenModifier({ key }), false);
  }
});
