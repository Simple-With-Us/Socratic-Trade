// Per-user conversation history. This is deliberately transcript-shaped, not memory-shaped:
// it powers UI reload and auditability, while durable preferences still go through memory/.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../../../packages/shared/types.mjs';

export const MAX_TURNS = 100;

/** @type {Map<string, object[]>} */
const byUser = new Map();

const REDACTIONS = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b(?:\d[ -]?){13,16}\b/g, // payment-card-ish
  /\bsk-ant-[A-Za-z0-9_-]+\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(bearer)\s+[A-Za-z0-9._-]+\b/gi,
  /\b(api[_ -]?key|secret|token|password)(\s*(?:is|=|:)\s*)\S+/gi,
];

function userTurns(userId) {
  if (!byUser.has(userId)) byUser.set(userId, []);
  return byUser.get(userId);
}

export function sanitizeText(text) {
  let redacted = false;
  let out = String(text ?? '');
  for (const re of REDACTIONS) {
    out = out.replace(re, (...args) => {
      redacted = true;
      if (args.length >= 3 && /api|secret|token|password/i.test(args[1] ?? '')) return `${args[1]}${args[2]}[redacted]`;
      if (/^bearer$/i.test(args[1] ?? '')) return `${args[1]} [redacted]`;
      return '[redacted]';
    });
  }
  return { text: out.slice(0, 4000), redacted };
}

export function appendTurn(userId, { role, text, citations = [], intent = null } = {}) {
  if (!['user', 'assistant'].includes(role)) throw new Error('role must be user or assistant');
  const sanitized = sanitizeText(text);
  const turn = {
    id: randomUUID(),
    user_id: userId,
    role,
    text: sanitized.text,
    citations: Array.isArray(citations) ? citations.slice(0, 8) : [],
    intent,
    redacted: sanitized.redacted,
    created_at: nowIso(),
  };
  const turns = userTurns(userId);
  turns.push(turn);
  if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
  return turn;
}

export function listTurns(userId, limit = MAX_TURNS) {
  const n = Math.max(1, Math.min(Number(limit) || MAX_TURNS, MAX_TURNS));
  return userTurns(userId).slice(-n);
}

export function dump() {
  return { byUser: [...byUser.entries()] };
}

export function restore(state) {
  byUser.clear();
  for (const [userId, turns] of state?.byUser ?? []) byUser.set(userId, turns.slice(-MAX_TURNS));
}

export function _reset() {
  byUser.clear();
}

