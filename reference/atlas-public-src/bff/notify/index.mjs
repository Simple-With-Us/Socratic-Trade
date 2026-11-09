// apps/bff/src/notify/index.mjs
// Out-of-app delivery for triggered alerts (and any future server-originated notice). Pluggable
// channels — phone push, webhook, email, SMS — each gated by ADMIN config (server env) except
// webhook, which only needs a user-supplied URL. The user picks one or more channels in Settings
// (src/notify/prefs.mjs); the dispatcher delivers to every enabled channel that is both available
// and has a target. All network calls go through an injectable `fetchImpl` so tests stay offline.

import { config as defaultConfig } from '../config.mjs';
import { getPrefs } from './prefs.mjs';
import { audit } from '../audit.mjs';

// --- channel definitions ----------------------------------------------------
// Each channel: available(cfg) → is the admin-side prerequisite present?
//               target(prefs)  → the user's delivery address for this channel (or '' if none)
//               send(target, msg, ctx) → deliver; throw on failure.
//               describe(cfg)  → UI metadata (so the client shows only usable options).

const ABORT = (ms) => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

async function postOrThrow(fetchImpl, url, init, timeoutMs) {
  const res = await fetchImpl(url, { ...init, signal: ABORT(timeoutMs) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  return res;
}

export const CHANNELS = {
  webhook: {
    // No admin config needed — the user simply provides a URL, so it's always offerable.
    available: () => true,
    target: (p) => p.webhook_url || '',
    describe: () => ({
      id: 'webhook', label: 'Webhook', available: true,
      target_field: 'webhook_url', target_label: 'Webhook URL',
      placeholder: 'https://example.com/hooks/atlas',
      hint: 'We POST a JSON payload here when an alert fires.',
    }),
    async send(url, msg, { fetchImpl, timeoutMs }) {
      if (!/^https:\/\//i.test(url)) throw new Error('webhook URL must be https');
      await postOrThrow(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Atlas-Alerts/1' },
        body: JSON.stringify({ source: 'atlas', kind: msg.kind ?? 'alert', title: msg.title, body: msg.body, data: msg.data ?? null, sent_at: new Date().toISOString() }),
      }, timeoutMs);
    },
  },

  push: {
    // ntfy needs only opt-in (public topics, no token). Pushover needs an app token.
    available: (cfg) => cfg.notify.push.provider === 'ntfy'
      || (cfg.notify.push.provider === 'pushover' && !!cfg.notify.push.pushoverToken),
    target: (p) => p.push_target || '',
    describe: (cfg) => {
      const provider = cfg.notify.push.provider;
      const isPushover = provider === 'pushover';
      return {
        id: 'push', label: 'Phone push', available: CHANNELS.push.available(cfg),
        provider: provider || null,
        target_field: 'push_target',
        target_label: isPushover ? 'Pushover user key' : 'ntfy topic',
        placeholder: isPushover ? 'u1a2b3c4d5...' : 'atlas-yourname-7c3f',
        hint: isPushover
          ? 'Install Pushover, then paste your user key. Notices arrive on your phone.'
          : `Pick a hard-to-guess topic, then subscribe to it in the ntfy app (server: ${cfg.notify.push.ntfyServer}).`,
      };
    },
    async send(target, msg, { cfg, fetchImpl, timeoutMs }) {
      if (cfg.notify.push.provider === 'pushover') {
        const form = new URLSearchParams({ token: cfg.notify.push.pushoverToken, user: target, title: msg.title, message: msg.body });
        await postOrThrow(fetchImpl, 'https://api.pushover.net/1/messages.json', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
        }, timeoutMs);
      } else { // ntfy
        const base = cfg.notify.push.ntfyServer.replace(/\/+$/, '');
        const topic = encodeURIComponent(target.replace(/^\/+/, ''));
        await postOrThrow(fetchImpl, `${base}/${topic}`, {
          method: 'POST', headers: { 'content-type': 'text/plain', title: msg.title }, body: msg.body,
        }, timeoutMs);
      }
    },
  },

  email: {
    available: (cfg) => cfg.notify.email.provider === 'resend' && !!cfg.notify.email.resendKey && !!cfg.notify.email.from,
    target: (p) => p.email || '',
    describe: (cfg) => ({
      id: 'email', label: 'Email', available: CHANNELS.email.available(cfg),
      target_field: 'email', target_label: 'Email address', placeholder: 'you@example.com',
      hint: 'Alerts are emailed to this address.',
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs }) {
      await postOrThrow(fetchImpl, 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.notify.email.resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: cfg.notify.email.from, to: [to], subject: msg.title, text: msg.body }),
      }, timeoutMs);
    },
  },

  sms: {
    available: (cfg) => !!cfg.notify.sms.twilioSid && !!cfg.notify.sms.twilioToken && !!cfg.notify.sms.twilioFrom,
    target: (p) => p.phone || '',
    describe: (cfg) => ({
      id: 'sms', label: 'SMS (Twilio)', available: CHANNELS.sms.available(cfg),
      target_field: 'phone', target_label: 'Mobile number', placeholder: '+14155551234',
      hint: 'Standard carrier message rates may apply.',
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs }) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.notify.sms.twilioSid)}/Messages.json`;
      const auth = Buffer.from(`${cfg.notify.sms.twilioSid}:${cfg.notify.sms.twilioToken}`).toString('base64');
      const form = new URLSearchParams({ From: cfg.notify.sms.twilioFrom, To: to, Body: `${msg.title}\n${msg.body}`.slice(0, 1500) });
      await postOrThrow(fetchImpl, url, {
        method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      }, timeoutMs);
    },
  },
};

// UI metadata: which channels exist, which are usable, and what target each needs.
export function describeChannels(cfg = defaultConfig) {
  return ['push', 'webhook', 'email', 'sms'].map((id) => CHANNELS[id].describe(cfg));
}

/**
 * Deliver `msg` ({ title, body, kind?, data? }) to every channel the user enabled that is both
 * admin-available and has a target. Returns a per-channel result list. Never throws — a failing
 * channel is recorded and the others still run.
 */
export async function notify(userId, msg, deps = {}) {
  const cfg = deps.config ?? defaultConfig;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg.notify.timeoutMs;
  const prefs = deps.prefs ?? getPrefs(userId);
  const results = [];
  for (const id of prefs.channels ?? []) {
    const channel = CHANNELS[id];
    if (!channel) { results.push({ channel: id, ok: false, skipped: 'unknown' }); continue; }
    if (!channel.available(cfg)) { results.push({ channel: id, ok: false, skipped: 'not_configured' }); continue; }
    const target = channel.target(prefs);
    if (!target) { results.push({ channel: id, ok: false, skipped: 'no_target' }); continue; }
    try {
      await channel.send(target, msg, { cfg, fetchImpl, timeoutMs });
      results.push({ channel: id, ok: true });
      audit('notify.sent', { user_id: userId, channel: id, kind: msg.kind ?? 'alert' });
    } catch (e) {
      results.push({ channel: id, ok: false, error: String(e.message ?? e) });
      audit('notify.error', { user_id: userId, channel: id, error: String(e.message ?? e) });
    }
  }
  return results;
}
