/**
 * Near-duplicate suppression before slice-to-limit (R14, 2026-07-01 RAG backlog).
 *
 * The retrieval pipeline never de-dups near-identical chunks — `chunk.ts`'s ~12% chunk overlap
 * plus duplicate/near-duplicate 8-K summaries mean a small final context (3 slots for
 * strategy.ts, 5 for chat) can end up being restatements of one passage rather than diverse
 * coverage. This is a greedy Jaccard-shingle filter: walk the pool in its current (already
 * ranked) order, keep a candidate unless it is >=`threshold` similar to an ALREADY-KEPT chunk,
 * and back-fill from the remaining pool so the final count still reaches `limit` when enough
 * distinct candidates exist.
 *
 * Pure, dependency-free (reuses `tokenize` from hybrid.ts) — no Pinecone/Voyage/DB imports.
 * O(k^2) shingle-set comparisons at k<=50 (the overFetchK ceiling) is trivial.
 *
 * Default OFF: `retrieveContextDetailed` only invokes this when the caller sets
 * `RetrieveOptions.dedupeSimilarity` (a 0-1 Jaccard threshold). Omitted = current behavior
 * (no dedup pass at all).
 */

import { tokenize } from "./hybrid";

const SHINGLE_SIZE = 3;

/**
 * Build a set of word-level n-gram shingles (default trigrams) for Jaccard comparison.
 * Exported (ST-4541) so the pre-embed near-duplicate gate (`near-dup-embed.ts`) measures ingest-side
 * similarity with the SAME shingling retrieval uses, instead of a second, slightly different
 * implementation that would drift from the retrieval-time threshold semantics.
 */
export function shingleSet(text: string, n: number = SHINGLE_SIZE): Set<string> {
  const tokens = tokenize(text);
  if (tokens.length === 0) return new Set();
  if (tokens.length < n) return new Set([tokens.join(" ")]);
  const shingles = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    shingles.add(tokens.slice(i, i + n).join(" "));
  }
  return shingles;
}

/** Jaccard similarity between two shingle sets: |A∩B| / |A∪B|. Returns 0 when both sets are empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Optional out-param (review fix, 2026-07-06): when passed, `dedupeSimilar` reports which INPUT
 * indices it dropped for each of the two genuinely-different reasons a candidate can be absent
 * from the return value:
 *  - `genuineDuplicateIndices` — the candidate was, AT LEAST ONCE (first pass or back-fill),
 *    compared via Jaccard similarity against the kept set and found >= `threshold` similar to an
 *    already-kept chunk. This is a real near-dup judgment — it can happen in the first pass (where
 *    the candidate is `deferred` for a possible back-fill retry) or be reconfirmed in back-fill;
 *    either way it counts once it has ever been judged similar.
 *  - `neverReachedIndices` — the candidate was NEVER compared at all, in either pass, because
 *    `kept.length >= limit` had already been hit before its turn came up. This is pure
 *    top-`limit` cap truncation, NOT a duplicate judgment — `dedupeSimilar` would have kept it (or
 *    judged it a dup) if `limit` had been higher, but it never got the chance to say which. Note
 *    this can ONLY happen on a candidate's FIRST visit: a `deferred` candidate (already judged a
 *    duplicate once in the first pass) that hits a full cap during back-fill is still a genuine
 *    duplicate — it was compared, just never re-confirmed — so it stays in
 *    `genuineDuplicateIndices`, not `neverReachedIndices`.
 *
 * Every input index ends up in exactly one of: the returned `kept` array, `genuineDuplicateIndices`,
 * or `neverReachedIndices`. Passing this param does not change `dedupeSimilar`'s return value or
 * behavior in any way — it only adds bookkeeping around the existing loops.
 */
export interface DedupeSimilarReport {
  genuineDuplicateIndices: number[];
  neverReachedIndices: number[];
}

/**
 * Greedy near-duplicate suppression with back-fill. Walks `pool` (already ranked; earlier =
 * higher priority) and keeps each candidate unless it's >= `threshold` Jaccard-similar to a chunk
 * already kept. A first pass fills up to `limit` distinct (non-duplicate) chunks; a second pass
 * re-considers the chunks deferred in the first pass so a pool with fewer than `limit` truly
 * distinct chunks still returns as many as actually exist, rather than an artificially short list.
 *
 * @param pool      Ranked candidate list (any shape with a `.metadata.text` string, matching
 *                  the Pinecone-match shape used elsewhere in this pipeline).
 * @param limit     Target result count (same `limit` the caller will `.slice(0, limit)` to).
 * @param threshold Jaccard similarity at/above which a candidate is considered a near-duplicate
 *                  of an already-kept chunk and is dropped (back-filled from later candidates).
 * @param report    Optional out-param (see `DedupeSimilarReport`) — when supplied, populated with
 *                  which input indices were dropped as genuine near-duplicates vs never reached
 *                  due to the `limit` cap. Omitted by every pre-existing caller; purely additive.
 */
export function dedupeSimilar<T extends { metadata?: { text?: unknown } }>(
  pool: T[],
  limit: number,
  threshold: number,
  report?: DedupeSimilarReport
): T[] {
  if (!Array.isArray(pool) || pool.length <= 1 || limit <= 0) {
    // Nothing is dropped in this early-return shape (pool passed through unchanged) — populate an
    // empty report for a caller that unconditionally reads it.
    if (report) {
      report.genuineDuplicateIndices = [];
      report.neverReachedIndices = [];
    }
    return pool;
  }

  const shingles = pool.map((m) => {
    const text = typeof m?.metadata?.text === "string" ? m.metadata.text : "";
    return shingleSet(text);
  });

  const kept: T[] = [];
  const keptShingles: Set<string>[] = [];
  const deferred: number[] = [];
  const genuineDuplicateIndices: number[] = [];
  const neverReachedIndices: number[] = [];

  for (let i = 0; i < pool.length; i++) {
    if (kept.length >= limit) {
      // The cap was already hit before this candidate was ever compared against the kept set —
      // pure limit-cap truncation, not a dup judgment. Matches the ORIGINAL (pre-report) loop's
      // `break`: nothing past this point in the first pass is examined either, same as before.
      neverReachedIndices.push(i);
      continue;
    }
    const candidateShingles = shingles[i]!;
    const isDuplicate = candidateShingles.size > 0 && keptShingles.some((k) => jaccardSimilarity(candidateShingles, k) >= threshold);
    if (isDuplicate) {
      // Judged a duplicate HERE, in the first pass — this candidate has now been compared at
      // least once and found similar, so it's a genuine duplicate regardless of what happens to
      // it in back-fill below (a full cap during back-fill means "never re-confirmed", not "never
      // judged" — see the `deferred` handling below, which does NOT re-add this index to
      // `neverReachedIndices`).
      genuineDuplicateIndices.push(i);
      deferred.push(i);
      continue;
    }
    kept.push(pool[i]!);
    keptShingles.push(candidateShingles);
  }

  // Back-fill: if we didn't reach `limit` because everything left was a near-duplicate of
  // something kept, allow deferred candidates back in (still checked against the final kept
  // set) rather than returning an artificially short list when the pool actually had more
  // (near-duplicate, but not identical, and still relevant) candidates available.
  //
  // Each `deferred` index (already in `genuineDuplicateIndices` from its first-pass judgment
  // above) gets a SECOND chance here: if it turns out NOT similar to the current kept set, it's
  // un-classified as a duplicate and kept instead. If the cap fills up before its turn, it stays
  // exactly as first classified — a genuine duplicate, since that first judgment is still valid
  // (never re-checked, but never contradicted either).
  for (const i of deferred) {
    if (kept.length >= limit) continue;
    const candidateShingles = shingles[i]!;
    const isDuplicate = candidateShingles.size > 0 && keptShingles.some((k) => jaccardSimilarity(candidateShingles, k) >= threshold);
    if (isDuplicate) continue; // reconfirmed duplicate — already in genuineDuplicateIndices
    // Not a duplicate against the (possibly grown) kept set after all — un-classify it and keep it.
    const idx = genuineDuplicateIndices.indexOf(i);
    if (idx !== -1) genuineDuplicateIndices.splice(idx, 1);
    kept.push(pool[i]!);
    keptShingles.push(candidateShingles);
  }

  if (report) {
    report.genuineDuplicateIndices = genuineDuplicateIndices;
    report.neverReachedIndices = neverReachedIndices;
  }

  return kept;
}
