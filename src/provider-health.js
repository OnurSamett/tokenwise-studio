// An explicit, opt-in model probe; never return provider errors or credentials to the UI.
import { freeProviders, listFreeModels } from './freechat.js';
import { loadSettings } from './settings.js';

async function probeReply(provider, model) {
  const response = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 32, stream: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Object.assign(new Error('provider request failed'), { status: response.status });
  const body = await response.json();
  if (typeof body?.choices?.[0]?.message?.content !== 'string' || !body.choices[0].message.content.trim()) throw new Error('empty reply');
}

export async function checkFreeConnection({ settings = loadSettings(), providers = freeProviders, models = listFreeModels, probe = probeReply } = {}) {
  if (!settings.allowFree && !settings.freeMode) return { status: 'disabled' };
  const provider = providers().find((p) => p.name === 'nvidia');
  if (!provider) return { status: 'not_configured' };
  const available = await models();
  const chosen = available.find((m) => m.provider === provider.name);
  if (!chosen) return { status: 'no_model' };
  const start = Date.now();
  try {
    await probe(provider, chosen.model);
    return { status: 'ok', model: chosen.model, latencyMs: Date.now() - start };
  } catch (e) {
    const code = Number(e?.status) || 0;
    return { status: code === 401 || code === 403 ? 'auth_error' : code === 429 ? 'rate_limited' : 'unavailable', model: chosen.model };
  }
}
