// headline-first-seen.ts — durable first-observation timestamps for news headlines.
//
// Issue #837: the evidence-age receipt path (prompt-safety collectEvidenceAgeAnomalies)
// previously skipped headlines because providers store bare titles with no timestamp.
// We record the first time a (user, normalized-headline) pair enters a strategy run and
// reuse that ISO timestamp on later runs so same-day news can be receipted like learned
// facts / RAG chunks. Leaf-ish: only depends on getDb; pure fingerprinting is exportable.
//
// ST-4643 (audit F4): the per-headline read-then-write was an N+1 — one SELECT plus one
// UPDATE/INSERT per headline per candidate per strategy run (~150-600 autocommit statement
// pairs per run, statements recompiled per call).  `recordHeadlineFirstSeenBatch` does ONE
// `SELECT ... WHERE user_id = ? AND fingerprint IN (...)` and then ONE transaction for all
// the UPDATEs and INSERTs, with the statements prepared once.  The single-headline helper
// is now a one-item batch, so there is exactly one implementation of the semantics.
//
// Retention stays per owner policy (Jay, 2026-10-15): headline novelty rows are kept forever.

import { createHash } from "crypto";
import { getDb } from "./db";

/** Normalize + hash for stable identity across whitespace/case/punctuation drift. */
export function headlineFingerprint(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 500);
  if (!norm) return "";
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

/**
 * Record first-seen timestamps for a batch of headlines.
 *
 * Returns one entry per input item, in the same order: the first-seen ISO timestamp, or
 * undefined for an item whose text has no usable fingerprint (the caller skips the age
 * receipt for those).  An item whose headline was already known keeps its ORIGINAL
 * first-seen; `last_seen` is refreshed for every item.
 */
export function recordHeadlineFirstSeenBatch(opts: {
  userId: string;
  items: Array<{ symbol: string; text: string }>;
  now?: Date;
}): Array<string | undefined> {
  const userId = opts.userId || "local";
  const nowIso = (opts.now ?? new Date()).toISOString();
  const prepared = opts.items.map((item) => ({
    symbol: (item.symbol || "?").toUpperCase().slice(0, 32),
    fingerprint: headlineFingerprint(item.text),
  }));
  const usable = prepared.filter((item) => item.fingerprint.length > 0);
  if (usable.length === 0) return prepared.map(() => undefined);

  const db = getDb();
  // ONE read for the whole batch (chunked so a very large run cannot exceed SQLite's
  // bound-parameter limit — a run carries ~150-600 headlines).
  const fingerprints = [...new Set(usable.map((item) => item.fingerprint))];
  const existing = new Map<string, string>();
  const CHUNK = 400;
  for (let offset = 0; offset < fingerprints.length; offset += CHUNK) {
    const chunk = fingerprints.slice(offset, offset + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT fingerprint, first_seen FROM headline_first_seen
         WHERE user_id = ? AND fingerprint IN (${placeholders})`
      )
      .all(userId, ...chunk) as Array<{ fingerprint: string; first_seen: string }>;
    for (const row of rows) existing.set(row.fingerprint, row.first_seen);
  }

  const updateStmt = db.prepare(
    `UPDATE headline_first_seen SET last_seen = ?, symbol = ? WHERE user_id = ? AND fingerprint = ?`
  );
  const insertStmt = db.prepare(
    `INSERT INTO headline_first_seen (user_id, fingerprint, symbol, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)`
  );

  // ONE transaction for every write of the batch.  `firstSeenByFingerprint` also dedupes
  // repeated fingerprints inside one batch: the second occurrence must not INSERT again.
  const firstSeenByFingerprint = new Map<string, string>();
  const writeAll = db.transaction(() => {
    for (const item of usable) {
      const alreadyWritten = firstSeenByFingerprint.get(item.fingerprint);
      if (alreadyWritten !== undefined) {
        updateStmt.run(nowIso, item.symbol, userId, item.fingerprint);
        continue;
      }
      const prior = existing.get(item.fingerprint);
      if (prior) {
        updateStmt.run(nowIso, item.symbol, userId, item.fingerprint);
        firstSeenByFingerprint.set(item.fingerprint, prior);
      } else {
        insertStmt.run(userId, item.fingerprint, item.symbol, nowIso, nowIso);
        firstSeenByFingerprint.set(item.fingerprint, nowIso);
      }
    }
  });
  writeAll();

  return prepared.map((item) =>
    item.fingerprint ? firstSeenByFingerprint.get(item.fingerprint) : undefined
  );
}

/**
 * Return the first-seen ISO timestamp for this headline for `userId`.
 * Inserts a new row when unseen; refreshes last_seen on every call.
 * Empty/invalid text returns undefined (caller skips the age receipt).
 */
export function getOrRecordHeadlineFirstSeen(opts: {
  userId: string;
  symbol: string;
  text: string;
  now?: Date;
}): string | undefined {
  return recordHeadlineFirstSeenBatch({
    userId: opts.userId,
    now: opts.now,
    items: [{ symbol: opts.symbol, text: opts.text }]
  })[0];
}

/** Jay policy (2026-10-15): headline novelty rows are kept forever. */
export function pruneHeadlineFirstSeen(_maxAgeMs = 30 * 24 * 60 * 60 * 1000, _now = Date.now()): number {
  return 0;
}
