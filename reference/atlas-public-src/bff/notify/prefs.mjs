// apps/bff/src/notify/prefs.mjs
// Per-user notification preferences: which channels the user opted into, and the per-channel
// delivery target they supplied (push topic/key, webhook URL, email, phone). These are stored
// server-side and participate in STORE=file snapshots. Admin-side secrets (Pushover app token,
// Twilio creds, Resend key) live in config/env — NEVER here.

import { nowIso } from '../../../../packages/shared/types.mjs';
import { audit } from '../audit.mjs';

export const CHANNEL_IDS = ['push', 'webhook', 'email', 'sms'];

/** @type {Map<string, object>} */
const byUser = new Map();

function blank(userId) {
  return {
    user_id: userId,
    channels: [], // subset of CHANNEL_IDS the user enabled
    push_target: '', // ntfy topic OR Pushover user key (provider decided by admin config)
    webhook_url: '', // user-supplied HTTPS endpoint
    email: '',
    phone: '', // E.164, e.g. +14155551234
    updated_at: null,
  };
}

export function getPrefs(userId) {
  return byUser.get(userId) ?? blank(userId);
}

// Merge a partial update. Unknown keys are ignored; channels are filtered to the known set.
export function setPrefs(userId, partial = {}) {
  const cur = { ...blank(userId), ...(byUser.get(userId) ?? {}) };
  if (Array.isArray(partial.channels)) {
    cur.channels = [...new Set(partial.channels.filter((c) => CHANNEL_IDS.includes(c)))];
  }
  for (const k of ['push_target', 'webhook_url', 'email', 'phone']) {
    if (typeof partial[k] === 'string') cur[k] = partial[k].trim();
  }
  cur.user_id = userId;
  cur.updated_at = nowIso();
  byUser.set(userId, cur);
  audit('notify.prefs.set', { user_id: userId, channels: cur.channels });
  return cur;
}

export function dump() { return { prefs: [...byUser.values()] }; }
export function restore(state) {
  byUser.clear();
  for (const p of state?.prefs ?? []) byUser.set(p.user_id, p);
}
export function _reset() { byUser.clear(); }
