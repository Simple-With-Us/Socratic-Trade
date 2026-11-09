// apps/bff/src/memory/store.mjs
// In-memory, per-user memory store with upsert/supersede semantics and structured retrieval.
// Reconcile-on-write (never blind-append). Swap for Postgres + pgvector later; the interface
// (write/retrieve/forget/list) stays the same.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../../../packages/shared/types.mjs';
import { extractCandidates, score } from './salience.mjs';
import { audit } from '../audit.mjs';

/** @type {Map<string, import('../../../../packages/shared/types.mjs').MemoryItem[]>} */
const byUser = new Map();

const live = (items) => items.filter((m) => !m.superseded_by);

function userItems(userId) {
  if (!byUser.has(userId)) byUser.set(userId, []);
  return byUser.get(userId);
}

/**
 * Apply the write policy to a message: extract candidates, score, and WRITE/HOLD/SKIP.
 * Reconciliation: a candidate matching an existing (kind, subject) upserts/supersedes.
 * @returns {{written:object[], held:object[], skipped:object[]}}
 */
export function ingestMessage(userId, message) {
  const items = userItems(userId);
  const candidates = extractCandidates(message);
  const written = [], held = [], skipped = [];

  for (const c of candidates) {
    const existing = live(items).find((m) => m.kind === c.kind && m.subject === c.subject) || null;
    const { score: s, decision } = score(c, existing);

    if (decision === 'SKIP') { skipped.push({ ...c, score: s }); continue; }
    if (decision === 'HOLD') { held.push({ ...c, score: s }); continue; }

    // WRITE: upsert if identical, else supersede the prior value.
    if (existing && existing.value === c.value) {
      existing.asserted_at = nowIso();
      existing.confidence = Math.max(existing.confidence, c.confidence);
      written.push({ ...existing, op: 'upsert', score: s });
      continue;
    }
    const item = {
      id: randomUUID(), user_id: userId, kind: c.kind, subject: c.subject, value: c.value,
      source: c.source, confidence: c.confidence, hard: !!c.hard, src: null,
      asserted_at: nowIso(), superseded_by: null,
    };
    if (existing) existing.superseded_by = item.id; // reconcile, don't accumulate contradictions
    items.push(item);
    written.push({ ...item, op: existing ? 'supersede' : 'append', score: s });
    audit('memory.write', { user_id: userId, kind: item.kind, subject: item.subject, op: existing ? 'supersede' : 'append' });
  }
  return { written, held, skipped };
}

/**
 * Retrieve for prompt assembly: hard constraints ALWAYS included; then the most-recent
 * live preferences/goals up to a budget. (Vector recall is added with the pgvector backend.)
 */
export function retrieve(userId, { limit = 12 } = {}) {
  const items = live(userItems(userId));
  const constraints = items.filter((m) => m.hard);
  const rest = items
    .filter((m) => !m.hard)
    .sort((a, b) => b.asserted_at.localeCompare(a.asserted_at))
    .slice(0, Math.max(0, limit - constraints.length));
  return [...constraints, ...rest];
}

export function listMemories(userId) {
  return live(userItems(userId));
}

export function forget(userId, id) {
  const items = userItems(userId);
  const idx = items.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1); // hard-delete (DSAR / "forget this")
  audit('memory.forget', { user_id: userId, id });
  return true;
}

// --- Serialization for persistence (swap point for Postgres + pgvector) ---
export function dump() { return { byUser: [...byUser.entries()] }; }
export function restore(state) {
  byUser.clear();
  for (const [u, items] of state?.byUser ?? []) byUser.set(u, items);
}

// For tests / fresh state.
export function _reset() { byUser.clear(); }
