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

/** Build a set of word-level n-gram shingles (default trigrams) for Jaccard comparison. */
function shingleSet(text: string, n: number = SHINGLE_SIZE): Set<string> {
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
 */
export function dedupeSimilar<T extends { metadata?: { text?: unknown } }>(
  pool: T[],
  limit: number,
  threshold: number
): T[] {
  if (!Array.isArray(pool) || pool.length <= 1 || limit <= 0) return pool;

  const shingles = pool.map((m) => {
    const text = typeof m?.metadata?.text === "string" ? m.metadata.text : "";
    return shingleSet(text);
  });

  const kept: T[] = [];
  const keptShingles: Set<string>[] = [];
  const deferred: number[] = [];

  for (let i = 0; i < pool.length; i++) {
    if (kept.length >= limit) break;
    const candidateShingles = shingles[i]!;
    const isDuplicate = candidateShingles.size > 0 && keptShingles.some((k) => jaccardSimilarity(candidateShingles, k) >= threshold);
    if (isDuplicate) {
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
  for (const i of deferred) {
    if (kept.length >= limit) break;
    const candidateShingles = shingles[i]!;
    const isDuplicate = candidateShingles.size > 0 && keptShingles.some((k) => jaccardSimilarity(candidateShingles, k) >= threshold);
    if (isDuplicate) continue;
    kept.push(pool[i]!);
    keptShingles.push(candidateShingles);
  }

  return kept;
}
