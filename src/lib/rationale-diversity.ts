/**
 * Rationale Diversity — improvement-program item #8.
 *
 * Detects reasoning/template collapse: flags when the per-run set of proposal rationales are
 * near-duplicate or input-agnostic boilerplate. A collapsed run likely indicates an LLM emitting
 * the same canned reasoning regardless of the actual symbol/data.
 *
 * Algorithm: character-trigram Jaccard similarity (principled, no tokenizer/stopword list needed,
 * robust to minor word substitutions). Pairwise similarity is computed over all N*(N-1)/2 pairs
 * (O(N²)) — strategy runs produce 2–10 proposals, so this is negligible.
 *
 * This module is PURE and DETERMINISTIC: no I/O, no randomness, no DB access.
 */

import type { RationaleDiversity } from "./types";

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a rationale string before similarity comparison:
 * 1. Lowercase.
 * 2. Strip punctuation (non-alphanumeric, non-whitespace characters).
 * 3. Collapse whitespace runs to a single space and trim.
 */
export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")    // strip punctuation → space
    .replace(/\s+/g, " ")        // collapse whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Character trigram helpers
// ---------------------------------------------------------------------------

/**
 * Returns the multiset of overlapping character trigrams for `text` as a
 * `Map<trigram → count>`. The empty string and strings shorter than 3 chars
 * produce an empty map (no trigrams → Jaccard = 0 vs anything).
 */
export function buildTrigramMap(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i <= text.length - 3; i++) {
    const tg = text.slice(i, i + 3);
    map.set(tg, (map.get(tg) ?? 0) + 1);
  }
  return map;
}

/**
 * Jaccard similarity between two trigram multisets: |intersection| / |union|
 * where intersection and union treat multiplicity (multiset Jaccard).
 *
 * Returns a value in [0, 1]. Two identical strings → 1. Empty strings → 0.
 */
export function trigramJaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  let unionSize = 0;

  // Sum up each key's contribution to union and intersection.
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const key of allKeys) {
    const ca = a.get(key) ?? 0;
    const cb = b.get(key) ?? 0;
    intersection += Math.min(ca, cb);
    unionSize += Math.max(ca, cb);
  }

  if (unionSize === 0) return 0;
  return intersection / unionSize;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Default collapse threshold: collapse is flagged when meanPairwiseSimilarity exceeds this. */
export const DEFAULT_COLLAPSE_THRESHOLD = 0.85;

/**
 * Computes rationale diversity across a set of rationale strings.
 *
 * Edge cases:
 * - 0 or 1 rationale → collapsed: false, both similarity values 0.
 * - All empty strings → all trigram maps empty → similarity 0 → collapsed: false.
 *
 * @param rationales  Array of raw rationale strings (not yet normalised).
 * @param threshold   Collapse threshold for meanPairwiseSimilarity (default 0.85).
 */
export function computeRationaleDiversity(
  rationales: string[],
  threshold: number = DEFAULT_COLLAPSE_THRESHOLD
): RationaleDiversity {
  const count = rationales.length;

  if (count < 2) {
    return { count, meanPairwiseSimilarity: 0, maxPairwiseSimilarity: 0, collapsed: false, threshold };
  }

  // Pre-compute normalised trigram maps once per rationale.
  const trigramMaps = rationales.map((r) => buildTrigramMap(normaliseText(r)));

  let sumSimilarity = 0;
  let maxSimilarity = 0;
  let pairCount = 0;

  for (let i = 0; i < trigramMaps.length; i++) {
    for (let j = i + 1; j < trigramMaps.length; j++) {
      const sim = trigramJaccard(trigramMaps[i], trigramMaps[j]);
      sumSimilarity += sim;
      if (sim > maxSimilarity) maxSimilarity = sim;
      pairCount++;
    }
  }

  const meanPairwiseSimilarity = pairCount > 0 ? sumSimilarity / pairCount : 0;

  return {
    count,
    meanPairwiseSimilarity,
    maxPairwiseSimilarity: maxSimilarity,
    collapsed: meanPairwiseSimilarity > threshold,
    threshold
  };
}
