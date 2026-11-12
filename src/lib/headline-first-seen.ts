// headline-first-seen.ts — durable first-observation timestamps for news headlines.
//
// Issue #837: the evidence-age receipt path (prompt-safety collectEvidenceAgeAnomalies)
// previously skipped headlines because providers store bare titles with no timestamp.
// We record the first time a (user, normalized-headline) pair enters a strategy run and
// reuse that ISO timestamp on later runs so same-day news can be receipted like learned
// facts / RAG chunks. Leaf-ish: only depends on getDb; pure fingerprinting is exportable.

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
  const fingerprint = headlineFingerprint(opts.text);
  if (!fingerprint) return undefined;
  const nowIso = (opts.now ?? new Date()).toISOString();
  const symbol = (opts.symbol || "?").toUpperCase().slice(0, 32);
  const userId = opts.userId || "local";
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT first_seen FROM headline_first_seen WHERE user_id = ? AND fingerprint = ?`
    )
    .get(userId, fingerprint) as { first_seen: string } | undefined;
  if (existing?.first_seen) {
    db.prepare(
      `UPDATE headline_first_seen SET last_seen = ?, symbol = ? WHERE user_id = ? AND fingerprint = ?`
    ).run(nowIso, symbol, userId, fingerprint);
    return existing.first_seen;
  }
  db.prepare(
    `INSERT INTO headline_first_seen (user_id, fingerprint, symbol, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, fingerprint, symbol, nowIso, nowIso);
  return nowIso;
}

/** Jay policy (2026-10-15): headline novelty rows are kept forever. */
export function pruneHeadlineFirstSeen(_maxAgeMs = 30 * 24 * 60 * 60 * 1000, _now = Date.now()): number {
  return 0;
}
