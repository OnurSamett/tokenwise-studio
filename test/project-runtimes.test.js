import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from '../src/ui.js';
import { closeProjectRuntimes, projectRuntime } from '../src/project-runtimes.js';

test('project runtimes retain independent state while switching and deduplicate aliases', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-runtimes-'));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const alias = path.join(root, 'alias'); fs.symlinkSync(second, alias, 'dir');
  const url = await startServer({ repo: first, port: 0 });
  t.after(async () => { await closeProjectRuntimes(); await stopServer(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (base, route, body) => {
    const res = await fetch(base + '/api/' + route, { method: body ? 'POST' : 'GET', headers: { 'x-tokenwise': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); assert.equal(res.status, 200, data.error); return data;
  };
  const jobsDir = path.join(first, '.tokenwise-studio', 'jobs');
  fs.writeFileSync(path.join(jobsDir, 'running.json'), JSON.stringify({ id: 'running', created: new Date().toISOString(), status: 'running', pid: process.pid }));
  const [a,b] = await Promise.all([call(url, 'open-project-window', { path: second }), call(url, 'open-project-window', { path: alias })]);
  assert.equal(a.url, b.url);
  assert.notEqual(a.url, url);
  const [stateA, stateB] = await Promise.all([call(url, 'state'), call(a.url, 'state')]);
  assert.equal(fs.realpathSync(stateA.repo), fs.realpathSync(first));
  assert.equal(fs.realpathSync(stateB.repo), fs.realpathSync(second));
  assert.ok(stateA.jobs.some((job) => job.id === 'running'));
  assert.equal(stateB.jobs.some((job) => job.id === 'running'), false);
  assert.equal((await projectRuntime(alias)).url, a.url);
});
