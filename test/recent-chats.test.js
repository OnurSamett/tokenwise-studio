import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentProjectChats } from '../src/recent-chats.js';

test('indexes other projects without moving their chats or leaking conversation contents', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-recent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  for (const p of [first, second]) fs.mkdirSync(path.join(p, '.tokenwise-studio', 'chats'), { recursive: true });
  const put = (p, name, data) => fs.writeFileSync(path.join(p, '.tokenwise-studio', 'chats', name), JSON.stringify(data));
  put(first, 'own.json', { id: 'own', title: 'Own', turns: [{ started: '2026-01-01' }] });
  put(second, 'older.json', { id: 'older', title: 'Older', turns: [{ started: '2026-01-01', user: 'secret body' }] });
  put(second, 'newer.json', { id: 'newer', title: 'Newer', turns: [{ started: '2026-02-01', user: 'other secret' }] });
  put(second, 'empty.json', { id: 'empty', title: 'Empty', turns: [] });
  put(second, 'bad.json', { id: '../bad', title: 'Bad', turns: [{}] });
  put(second, 'ignore.mcp.json', { id: 'ignore.mcp', title: 'Ignore', turns: [{}] });
  const alias = path.join(root, 'alias'); fs.symlinkSync(second, alias, 'dir');
  const result = recentProjectChats([first, second, alias, path.join(root, 'absent')], first);
  assert.deepEqual(result.map((c) => c.id), ['newer', 'older']);
  assert.equal(result[0].project, fs.realpathSync(second));
  assert.deepEqual(Object.keys(result[0]).sort(), ['id', 'project', 'projectName', 'status', 'title', 'updated']);
  assert.ok(fs.existsSync(path.join(second, '.tokenwise-studio', 'chats', 'newer.json')));
  assert.equal(recentProjectChats([second], first, 1).length, 1);
});

test('project switching preserves active work and permits reopening the same folder', async (t) => {
  const { PassThrough } = await import('node:stream');
  const { initServer, handler } = await import('../src/ui.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  initServer({ repo: first });
  const jobFile = path.join(first, '.tokenwise-studio', 'jobs', 'running.json');
  fs.writeFileSync(jobFile, JSON.stringify({ id: 'running', created: '2026-01-01', status: 'running', pid: process.pid }));
  const post = async (project) => {
    const req = new PassThrough();
    req.method = 'POST'; req.url = '/api/project';
    req.headers = { host: '127.0.0.1:4777', 'x-tokenwise': '1' };
    let status = 200, body = '';
    const res = { writeHead(code) { status = code; }, end(value) { body = String(value || ''); } };
    const result = handler(req, res); req.end(JSON.stringify({ path: project })); await result;
    return { status, body: JSON.parse(body) };
  };
  const blocked = await post(second);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.busy, true);
  const same = await post(first);
  assert.equal(same.status, 200);
  assert.equal(same.body.repo, first);
  fs.unlinkSync(jobFile);
  const opened = await post(second);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.repo, second);
});
