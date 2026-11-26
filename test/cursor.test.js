import test from 'node:test';
import assert from 'node:assert/strict';
import { command, resolve } from '../src/workers.js';
import { normalizeTeamOverride } from '../src/team.js';
import { prepareDelegateArgs } from '../src/mcp.js';

test('Cursor workers use read-only ask mode or an isolated workspace with sandboxing', () => {
  const spec = resolve({ agent: 'cursor' });
  assert.equal(spec.model, 'auto');
  const read = command(spec, { task: 'Summarize this project', cwd: '/tmp/project', write: false });
  assert.ok(read.cmd.endsWith('cursor-agent'));
  assert.deepEqual(read.args.slice(-2), ['--mode', 'ask']);
  assert.ok(read.args.includes('--sandbox'));
  assert.ok(!read.args.includes('--force'));
  const write = command(spec, { task: 'Update the fixture', cwd: '/tmp/worktree', write: true });
  assert.equal(write.args[write.args.indexOf('--workspace') + 1], '/tmp/worktree');
  assert.ok(!write.args.includes('--mode'));
  assert.ok(!write.args.includes('--force'));
  assert.ok(!write.args.includes('--model'));
});

test('Cursor is selectable as a team worker and blocked in free mode', () => {
  const team = normalizeTeamOverride({ code: { agent: 'cursor', model: 'auto' } });
  assert.equal(team.code.agent, 'cursor');
  assert.throws(() => prepareDelegateArgs({ agent: 'cursor', task: 'Example task' }, { freeMode: true }), /paid worker/);
});

test('Cursor worker preserves a multi-line response from its CLI', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Jobs } = await import('../src/jobs.js');
  const { clearDoctorCache } = await import('../src/doctor.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cursor-'));
  const previousHome = process.env.HOME;
  const previousNotify = process.env.TOKENWISE_NOTIFY;
  process.env.HOME = home;
  process.env.TOKENWISE_NOTIFY = '0';
  const bin = path.join(home, '.local', 'bin', 'cursor-agent');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = status ]; then echo "Logged in"; else printf "first line\\nsecond line\\n"; fi\n', { mode: 0o755 });
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  clearDoctorCache();
  try {
    const jobs = new Jobs(repo);
    const job = jobs.start({ agent: 'cursor', task: 'Summarize this test project', write: false, noFallback: true });
    const done = await jobs.wait(job.id, 10);
    assert.equal(done.status, 'done');
    assert.equal(done.final, 'first line\nsecond line');
  } finally {
    clearDoctorCache();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousNotify === undefined) delete process.env.TOKENWISE_NOTIFY; else process.env.TOKENWISE_NOTIFY = previousNotify;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('single hosted model disables provider and model fallback', () => {
  const spec = resolve({ agent: 'free', model: 'groq:openai/gpt-oss-120b' });
  const strict = command(spec, { task: 'Review a small change', cwd: '/tmp/project', write: false, strictModel: true });
  assert.equal(strict.env.TOKENWISE_FREE_PROVIDERS, 'groq');
  assert.equal(strict.env.TOKENWISE_GROQ_MODEL, 'openai/gpt-oss-120b');
  assert.equal(strict.env.TOKENWISE_FREE_STRICT_MODEL, '1');
});

test('Cursor model discovery keeps every Grok variant and passes exact IDs to the CLI', async () => {
  const { parseCursorModels } = await import('../src/cursor.js');
  const output = ['Available models', 'auto - Auto', 'cursor-grok-4.5-high - Grok 4.5', 'grok-4.7-low - Grok 4.7 Low', 'grok-4.7-medium-fast - Grok 4.7 Medium Fast', 'grok-4.7-low - duplicate', 'bad output'].join('\n');
  const models = parseCursorModels(output);
  assert.deepEqual(models, ['auto', 'cursor-grok-4.5-high', 'grok-4.7-low', 'grok-4.7-medium-fast']);
  for (const model of models.slice(1)) {
    const spec = resolve({ agent: 'cursor', model });
    const run = command(spec, { task: 'Review', cwd: '/tmp/project', write: false });
    assert.equal(run.args[run.args.indexOf('--model') + 1], model);
  }
  const many = Array.from({ length: 150 }, (_, i) => `model-${i} - Model ${i}`).join('\n');
  assert.equal(parseCursorModels(many).length, 150);
});
