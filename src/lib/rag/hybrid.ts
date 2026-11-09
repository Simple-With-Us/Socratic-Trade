/**
 * Hybrid dense+sparse (BM25) retrieval helpers.
 *
 * Pure, dependency-free module — no Pinecone/Voyage/DB imports. Safe to import
 * in any context. All functions are deterministic given the same inputs.
 *
 * Designed for POST-RETRIEVAL hybrid fusion: the dense query over-fetches a
 * candidate pool whose chunks carry their text. BM25 scores are computed in-
 * process against that candidate pool, then fused with the dense cosine ranking
 * via Reciprocal Rank Fusion (RRF) before the cross-encoder rerank stage.
 * No new Pinecone index or admin reindex is required.
 *
 * Limitation: IDF is computed from the candidate pool itself (typically ≤50
 * docs), which is noisy for very small corpora (< 3 docs). This is acceptable
 * for the intended use case — scores within the pool are compared relatively.
 *
 * Future enhancement (out of scope for this PR): Pinecone sparse-dense index
 * with a proper inverted index for corpus-wide IDF.
 */

/** BM25 tuning constants (standard defaults). */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * Tokenize text for BM25: lowercase, split on non-alphanumeric, drop empty tokens.
 * Keeps ticker-like tokens (e.g. "AAPL" → "aapl", "10-K" → ["10","k"]).
 * Note: punctuation is stripped — this is more aggressive than whitespace-only splits
 * but consistent and ticker-safe.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Compute BM25 scores for a query against a corpus of documents.
 * Standard parameters: k1 = 1.5, b = 0.75.
 * IDF is computed from the provided corpus (the candidate pool itself, typically ≤50 docs).
 * Returns a parallel array of scores — one per doc, same index as docs[].
 */
export function bm25Scores(query: string, docs: string[]): number[] {
  if (docs.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return new Array(docs.length).fill(0);

  // Tokenize all documents and compute average document length.
  const tokenizedDocs = docs.map(tokenize);
  const avgDl = tokenizedDocs.reduce((sum, toks) => sum + toks.length, 0) / tokenizedDocs.length;

  // Build document frequency map: df[term] = number of docs containing term.
  const df = new Map<string, number>();
  for (const toks of tokenizedDocs) {
    const seen = new Set(toks);
    for (const t of seen) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const N = docs.length;

  // Score each document.
  return tokenizedDocs.map((toks) => {
    const dl = toks.length;

    // Build term frequency map for this document.
    const tf = new Map<string, number>();
    for (const t of toks) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const termTf = tf.get(term) ?? 0;
      if (termTf === 0) continue;

      const termDf = df.get(term) ?? 0;
      // IDF (with smoothing): log((N - df + 0.5) / (df + 0.5) + 1)
      // The +1 ensures IDF is always positive even when df == N (every doc contains the term).
      const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);

      // BM25 TF normalization.
      const tfNorm = (termTf * (BM25_K1 + 1)) / (termTf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (avgDl || 1))));

      score += idf * tfNorm;
    }

    return score;
  });
}

/**
 * Reciprocal Rank Fusion over multiple ranked id lists.
 *
 * RRF score for doc d = sum over lists L: 1 / (k + rank_in_L(d))
 * where rank is 1-indexed; docs absent from a list get no contribution from that list.
 *
 * k defaults to 60 (standard RRF parameter — controls the tail dampening).
 * Returns fused id ranking, highest score first.
 *
 * Pure/deterministic: ties broken by first appearance in the first list (stable sort),
 * which naturally biases toward dense ranking when BM25 is neutral.
 *
 * Accepts any number of ranked lists (not just 2) — the multi-query item will reuse this.
 */
export function rrfFuse(rankedLists: string[][], k = 60): string[] {
  if (rankedLists.length === 0) return [];

  const scores = new Map<string, number>();
  // Track first-appearance index in the first non-empty list for stable tie-breaking.
  const firstAppearance = new Map<string, number>();

  for (const list of rankedLists) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (typeof id !== "string") continue;
      const rank = i + 1; // 1-indexed
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    }
  }

  // Record first-appearance positions from the first valid list, for tie-breaking.
  const firstList = rankedLists.find((l) => Array.isArray(l) && l.length > 0);
  if (firstList) {
    for (let i = 0; i < firstList.length; i++) {
      const id = firstList[i];
      if (typeof id === "string" && !firstAppearance.has(id)) {
        firstAppearance.set(id, i);
      }
    }
  }

  const ids = Array.from(scores.keys());
  // Stable sort: descending by RRF score, ties broken by first-appearance index (ascending).
  ids.sort((a, b) => {
    const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (diff !== 0) return diff;
    // Tie-break: earlier first-appearance wins (stays closer to dense order).
    const aIdx = firstAppearance.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bIdx = firstAppearance.get(b) ?? Number.MAX_SAFE_INTEGER;
    return aIdx - bIdx;
  });

  return ids;
}

/**
 * Convenience wrapper: fuse dense + BM25 rankings for the Pinecone candidate pool.
 *
 * @param query   - The retrieval query string.
 * @param matches - Raw Pinecone match objects in dense-cosine-descending order.
 *                  Each match is expected to have m.id (string | undefined) and
 *                  m.metadata.text (string).
 * @returns The matches array reordered by RRF(dense, BM25). Matches with undefined/
 *          empty id are assigned a synthetic id "__idx_N__" for ranking purposes and
 *          returned with their original shape.
 *
 * Falls back to returning matches unchanged on any error (best-effort; never throws).
 */
export function fuseHybrid(query: string, matches: any[]): any[] {
  if (!Array.isArray(matches) || matches.length <= 1) return matches;

  try {
    // Assign synthetic ids to matches lacking one.
    const effectiveIds: string[] = matches.map((m, i) => {
      const id = m?.id;
      return typeof id === "string" && id.length > 0 ? id : `__idx_${i}__`;
    });

    // Dense ranking: already in cosine-descending order.
    const denseIds = [...effectiveIds];

    // BM25 ranking: score each match's text against the query.
    const docs = matches.map((m) => {
      const t = m?.metadata?.text;
      return typeof t === "string" ? t : "";
    });
    const scores = bm25Scores(query, docs);

    // Build bm25Ids sorted by score descending; stable tie-break by original dense index.
    // Only POSITIVE-score (actually-matching) docs go in the lexical list — otherwise every
    // non-matching candidate would still receive a sparse-list RRF boost, diluting the exact-term
    // recall this fusion is meant to add (a lexical hit at dense rank 3 could lose to an unrelated
    // dense rank-1 doc that matched zero query terms). When nothing matches lexically, the lexical
    // list is empty and rrfFuse falls back to pure dense order.
    const indexed = scores
      .map((score, i) => ({ score, i }))
      .filter(({ score }) => score > 0);
    indexed.sort((a, b) => {
      const diff = b.score - a.score;
      return diff !== 0 ? diff : a.i - b.i; // tie-break: original dense order
    });
    const bm25Ids = indexed.map(({ i }) => effectiveIds[i]!);

    // RRF fusion. With an empty bm25Ids (no lexical matches) this returns dense order unchanged.
    const fusedIds = rrfFuse([denseIds, bm25Ids]);

    // Reconstruct matches in fused order.
    const idToMatch = new Map<string, any>(effectiveIds.map((id, i) => [id, matches[i]]));
    const result: any[] = [];
    for (const id of fusedIds) {
      const match = idToMatch.get(id);
      if (match !== undefined) result.push(match);
    }

    return result.length > 0 ? result : matches;
  } catch (err) {
    console.warn("[vector-db] hybrid fusion error:", err instanceof Error ? err.message : String(err));
    return matches;
  }
}
