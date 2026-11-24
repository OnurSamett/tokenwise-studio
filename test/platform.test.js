import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathsFor, samePath, withinPath, gitCommonDir, systemProjectPath, platformFeatures } from '../src/platform.js';
import { rel } from '../src/events.js';
import { normalizeChatFilePath } from '../src/workspace.js';
import { notify, pendingBrowserNotices, resetNotifyState, flushNotifications } from '../src/notify.js';
import { decideAutoUpdate } from '../src/autoupdate.js';
import { installSource } from '../src/version.js';

test('Windows paths preserve drive, UNC, spaces and Unicode with injected platform', () => {
  assert.equal(pathsFor('win32'), path.win32);
  assert.equal(pathsFor('darwin'), path.posix);
  assert.equal(gitCommonDir('C:\\Projects\\Örnek app', '.git\n', 'win32'), 'C:\\Projects\\Örnek app\\.git');
  assert.equal(gitCommonDir('C:\\Projects\\app', 'D:/shared/repo.git\n', 'win32'), 'D:\\shared\\repo.git');
  assert.equal(gitCommonDir('C:\\Projects\\app', '//server/share/repo.git\n', 'win32'), '\\\\server\\share\\repo.git');
  assert.equal(gitCommonDir('/projects/app', '../shared.git\n', 'darwin'), '/projects/shared.git');
});

test('Windows containment and equality handle case, separator and drive boundaries', () => {
  assert.ok(samePath('C:/Projects/APP/', 'c:\\projects\\app', 'win32'));
  assert.ok(withinPath('C:/Projects/app/src/a.js', 'c:\\projects\\APP', 'win32'));
  assert.ok(withinPath('C:/Projects/app', 'c:/projects/app/', 'win32'));
  for (const file of ['C:/Projects/apple/a', 'C:/Projects/app/../secret', 'D:/Projects/app/a']) assert.equal(withinPath(file, 'C:/Projects/app', 'win32'), false);
  assert.equal(samePath('/Projects/App', '/projects/app', 'darwin'), false);
  assert.equal(withinPath('/projects/apple', '/projects/app', 'linux'), false);
});

test('Windows project guards reject system directories and volume roots, allow user projects', () => {
  const opts = { platform: 'win32', env: { SystemRoot: 'D:\\Windows', ProgramFiles: 'D:\\Program Files', ProgramData: 'D:\\ProgramData' } };
  for (const file of ['C:\\', 'D:/windows/System32', 'D:/Program Files/App', 'D:/ProgramData/app', '\\\\server\\share\\']) assert.ok(systemProjectPath(file, opts), file);
  for (const file of ['D:/Windows-project', 'C:/Users/Onur/Örnek app', '\\\\server\\share\\project']) assert.equal(systemProjectPath(file, opts), false, file);
  assert.ok(systemProjectPath('/System/Library', { platform: 'darwin' }));
});

test('Windows disables Mac-only capabilities; Linux also uses browser notifications', () => {
  assert.deepEqual(platformFeatures('win32'), { nativeDictation: false, playtest: false, sparkle: false, browserNotifications: true });
  assert.ok(platformFeatures('darwin').sparkle);
  assert.ok(platformFeatures('linux').browserNotifications);
});

test('worker paths render relative Windows worktrees and repository paths', () => {
  assert.equal(rel('C:\\repo\\.tokenwise-studio\\worktrees\\123\\src\\a.js', 'C:\\repo'), 'src/a.js');
  assert.equal(rel('C:\\repo\\src\\a.js', 'C:\\repo'), 'src/a.js');
  assert.equal(normalizeChatFilePath('C:\\repo\\src\\a.js', { repo: 'C:/repo' }), 'src/a.js');
  assert.equal(normalizeChatFilePath('c:\\REPO\\Src\\a.js', { repo: 'C:/repo' }), 'Src/a.js');
  assert.equal(normalizeChatFilePath('D:\\other\\a.js', { repo: 'C:/repo' }), null);
  assert.equal(normalizeChatFilePath('C:\\repo-extra\\a.js', { repo: 'C:/repo' }), null);
});

test('non-Mac notifications queue by project, honor settings, and deduplicate', () => {
  resetNotifyState();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-browser-notices-'));
  let now = 1_700_000_000_000;
  const deps = { platform: 'win32', home, now: () => now, schedule: false, settings: { notifications: true, notifyFocusDnd: false }, exec: () => { throw new Error('must not invoke macOS'); } };
  assert.equal(notify({ title: 'Done', message: 'Ready', repo: 'C:\\repo', key: 'job:1' }, deps), true);
  assert.equal(notify({ title: 'Again', repo: 'C:\\repo', key: 'job:1' }, deps), false);
  assert.equal(pendingBrowserNotices('C:\\repo', { home }).length, 0, 'batched, not instant');
  now += 30_000; flushNotifications(deps);
  assert.equal(pendingBrowserNotices('C:\\repo', { home }).length, 1);
  assert.equal(pendingBrowserNotices('C:\\other', { home }).length, 0);
  assert.equal(notify({ title: 'Off' }, { ...deps, settings: { notifications: false } }), false);
  assert.equal(notify({ title: 'Linux' }, { ...deps, platform: 'linux' }), true);
  now += 30_000; flushNotifications({ ...deps, platform: 'linux' });
  assert.equal(pendingBrowserNotices('C:\\repo', { home }).length, 2);
  resetNotifyState();
  fs.rmSync(home, { recursive: true, force: true });
});

test('Windows bundle is recognized and never attempts an npm self-update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-win-bundle-'));
  try {
    fs.writeFileSync(path.join(dir, '.bundled'), 'windows\n');
    assert.equal(installSource(dir), 'windows');
    assert.equal(decideAutoUpdate({ source: 'windows', mode: 'auto', current: '1.0.0', latest: { version: '2.0.0' }, busy: false }).action, 'skip');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
