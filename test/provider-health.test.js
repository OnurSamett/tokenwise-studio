import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFreeConnection } from '../src/provider-health.js';

const p = { name: 'nvidia', key: 'test-secret' };
const m = { provider: 'nvidia', model: 'test-model' };
test('explicit provider check requires opt-in and a configured provider', async () => {
  let called = false;
  const providers = () => { called = true; return [p]; };
  assert.deepEqual(await checkFreeConnection({ settings: {}, providers }), { status: 'disabled' });
  assert.equal(called, false);
  assert.deepEqual(await checkFreeConnection({ settings: { allowFree: true }, providers: () => [] }), { status: 'not_configured' });
});
test('provider check probes a listed model and never returns provider error text', async () => {
  const base = { settings: { allowFree: true }, providers: () => [p], models: async () => [m] };
  const ok = await checkFreeConnection({ ...base, probe: async (provider, model) => { assert.equal(provider, p); assert.equal(model, 'test-model'); } });
  assert.equal(ok.status, 'ok'); assert.equal(ok.model, 'test-model'); assert.ok(ok.latencyMs >= 0);
  const failed = await checkFreeConnection({ ...base, probe: async () => { throw Object.assign(new Error('test-secret'), { status: 401 }); } });
  assert.deepEqual(failed, { status: 'auth_error', model: 'test-model' });
  assert.ok(!JSON.stringify(failed).includes('test-secret'));
  assert.deepEqual(await checkFreeConnection({ ...base, models: async () => [] }), { status: 'no_model' });
});
