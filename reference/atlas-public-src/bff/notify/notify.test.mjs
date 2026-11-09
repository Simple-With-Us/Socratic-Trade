// tests/notify.test.mjs — notification delivery: prefs store, admin-gated channel availability,
// per-channel dispatch with an injected fetch, and graceful per-channel failure isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPrefs, setPrefs, _reset } from '../apps/bff/src/notify/prefs.mjs';
import { notify, describeChannels, CHANNELS } from '../apps/bff/src/notify/index.mjs';

// A minimal config clone so tests never depend on real env.
function cfg(overrides = {}) {
  return {
    notify: {
      push: { provider: '', ntfyServer: 'https://ntfy.sh', pushoverToken: null },
      email: { provider: '', resendKey: null, from: null },
      sms: { twilioSid: null, twilioToken: null, twilioFrom: null },
      timeoutMs: 1000,
      ...overrides,
    },
  };
}
// Recording fake fetch that always succeeds.
function fakeFetch() {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '' }; };
  impl.calls = calls;
  return impl;
}

test('prefs: defaults blank, set merges, channels filtered to known set', () => {
  _reset();
  assert.deepEqual(getPrefs('u').channels, []);
  const p = setPrefs('u', { channels: ['push', 'webhook', 'bogus'], webhook_url: ' https://x.test/h ', push_target: 'topic-1' });
  assert.deepEqual(p.channels, ['push', 'webhook']);
  assert.equal(p.webhook_url, 'https://x.test/h'); // trimmed
  assert.equal(getPrefs('u').push_target, 'topic-1');
});

test('describeChannels: webhook always available; others gated by admin config', () => {
  const off = Object.fromEntries(describeChannels(cfg()).map((c) => [c.id, c.available]));
  assert.equal(off.webhook, true);
  assert.equal(off.push, false);
  assert.equal(off.email, false);
  assert.equal(off.sms, false);

  const on = Object.fromEntries(describeChannels(cfg({
    push: { provider: 'pushover', ntfyServer: 'https://ntfy.sh', pushoverToken: 'tok' },
    email: { provider: 'resend', resendKey: 'k', from: 'a@b.c' },
    sms: { twilioSid: 's', twilioToken: 't', twilioFrom: '+1' },
  })).map((c) => [c.id, c.available]));
  assert.equal(on.push && on.email && on.sms, true);
});

test('ntfy push is available with provider alone (no token needed)', () => {
  assert.equal(CHANNELS.push.available(cfg({ push: { provider: 'ntfy', ntfyServer: 'https://ntfy.sh', pushoverToken: null } })), true);
});

test('notify: delivers only to enabled channels that have a target', async () => {
  _reset();
  setPrefs('u', { channels: ['webhook', 'push'], webhook_url: 'https://x.test/hook' }); // push enabled but no target
  const f = fakeFetch();
  const results = await notify('u', { title: 'T', body: 'B' }, { config: cfg({ push: { provider: 'ntfy', ntfyServer: 'https://ntfy.sh', pushoverToken: null } }), fetchImpl: f });
  const byId = Object.fromEntries(results.map((r) => [r.channel, r]));
  assert.equal(byId.webhook.ok, true);
  assert.equal(byId.push.ok, false);
  assert.equal(byId.push.skipped, 'no_target');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://x.test/hook');
  const payload = JSON.parse(f.calls[0].init.body);
  assert.equal(payload.source, 'atlas');
  assert.equal(payload.title, 'T');
});

test('notify: skips a channel the admin has not configured', async () => {
  _reset();
  setPrefs('u', { channels: ['sms'], phone: '+14155551234' });
  const f = fakeFetch();
  const results = await notify('u', { title: 'T', body: 'B' }, { config: cfg(), fetchImpl: f });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].skipped, 'not_configured');
  assert.equal(f.calls.length, 0);
});

test('notify: ntfy push posts to server/topic with a Title header', async () => {
  _reset();
  setPrefs('u', { channels: ['push'], push_target: 'atlas-test-7c3f' });
  const f = fakeFetch();
  await notify('u', { title: 'Hi', body: 'Body' }, { config: cfg({ push: { provider: 'ntfy', ntfyServer: 'https://ntfy.sh/', pushoverToken: null } }), fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://ntfy.sh/atlas-test-7c3f');
  assert.equal(f.calls[0].init.headers.title, 'Hi');
});

test('notify: a failing channel is isolated and others still deliver', async () => {
  _reset();
  setPrefs('u', { channels: ['webhook', 'push'], webhook_url: 'https://x.test/hook', push_target: 'topic' });
  const f = async (url) => {
    if (url.includes('x.test')) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => '' };
  };
  const results = await notify('u', { title: 'T', body: 'B' }, { config: cfg({ push: { provider: 'ntfy', ntfyServer: 'https://ntfy.sh', pushoverToken: null } }), fetchImpl: f });
  const byId = Object.fromEntries(results.map((r) => [r.channel, r]));
  assert.equal(byId.webhook.ok, false);
  assert.match(byId.webhook.error, /HTTP 500/);
  assert.equal(byId.push.ok, true);
});

test('webhook requires https', async () => {
  _reset();
  setPrefs('u', { channels: ['webhook'], webhook_url: 'http://insecure.test/h' });
  const f = fakeFetch();
  const results = await notify('u', { title: 'T', body: 'B' }, { config: cfg(), fetchImpl: f });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /https/);
  assert.equal(f.calls.length, 0);
});
