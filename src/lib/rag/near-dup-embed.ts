/**
 * Pre-embed near-duplicate detection for the RAG ingest path (ST-4541, RAG improvement 8).
 *
 * WHY THIS EXISTS: the ingest/embed path already skips EXACT repeats before paying for a vector —
 * `storeContexts`'s opt-in `dedupKeyPrefix` checks `hashContent(trimmedText)` against
 * `document_chunks`, and `db-embed-stage.ts` replays durable vectors by exact embed-input hash.
 * Both are byte-exact. They do nothing for the far more common case: the SAME filing text re-ingested
 * behind a whitespace/case/reflow difference, or an 8-K summary whose boilerplate header changed
 * by one line. Those are different byte strings with the same meaning, so they miss the hash, miss
 * the stage, and pay for a fresh Voyage/OpenRouter embed plus a Pinecone upsert for content the
 * corpus already answers from.
 *
 * This module is the pre-embed half of that gap: it classifies an incoming chunk as `new`, `exact`
 * (normalized-text hash hit) or `near` (MinHash-estimated shingle Jaccard >= threshold against
 * already-stored chunks for the SAME source/symbol), so the caller can skip the paid embed and
 * record a provenance link to the canonical chunk instead.
 *
 * BINDING CONSTRAINT — nothing is ever deleted here or by its callers. The source record is still
 * ingested and still retrievable; only the EMBED CALL is skipped, and a `chunk_dedup_links` row
 * records which canonical chunk answers for it. This module is pure and has no DB or provider
 * imports precisely so that rule is auditable at a glance.
 *
 * Pure/dependency-free: reuses `tokenize` via the shingling helpers already exported from
 * `dedupe-similar.ts` (retrieval-time near-dup suppression) rather than re-implementing word
 * n-grams, so ingest and retrieval agree on what "the same text" means.
 */

import { createHash } from "crypto";
import { jaccardSimilarity, shingleSet } from "./dedupe-similar";

/**
 * Default Jaccard threshold for "near duplicate". Deliberately high (0.9): this gate SKIPS a paid
 * embed, so a false positive means a genuinely different chunk never gets its own vector. Only
 * boilerplate churn (headers, whitespace, a trailing line) should land here. Operators who want a
 * looser net can pass `RAG_NEAR_DUP_THRESHOLD` explicitly; a much lower value (e.g. 0.6) starts
 * collapsing legitimately related sections and should not be the default.
 */
export const DEFAULT_NEAR_DUP_THRESHOLD = 0.9;

/** MinHash permutation count. 64 gives a standard error of ~1/8 = 0.125 on the estimate. */
export const DEFAULT_NEAR_DUP_NUM_PERM = 64;

/**
 * How many recent stored chunks to compare against per (symbol, source) scope. Bounded so the
 * per-chunk comparison cost stays flat and the newest (most likely to be a re-ingest of the same
 * document) chunks are preferred. This bounds COMPARISON work, never stored data.
 */
export const DEFAULT_NEAR_DUP_WINDOW = 200;

/**
 * Deterministic 32-bit FNV-1a over a shingle string. Must stay stable across processes and
 * releases: signatures are PERSISTED, so a change here silently invalidates stored signatures
 * (they degrade to "no near-duplicate found", i.e. extra paid embeds, never to a wrong skip).
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic (a, b) MinHash permutation coefficients for permutation `index`. Derived from a
 * fixed-seed integer mix rather than `Math.random()` so a signature computed today is byte-identical
 * to one computed by a different worker process tomorrow — required because signatures are stored.
 * `a` is forced odd so the permutation is a full-period affine map over the 32-bit ring.
 */
function permutationCoefficients(index: number): [number, number] {
  let x = (0x9e3779b9 ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0;
  x = (Math.imul(x, 0x2545f491) ^ 0x9e3779b9) >>> 0;
  let a = (x % 2147483647) + 1;
  if (a % 2 === 0) a += 1;
  const b = Math.imul(x, 0x27d4eb2f) >>> 0;
  return [a, b];
}

/**
 * MinHash signature over a shingle set: for each of `numPerm` permutations, the minimum of
 * `(a*h + b) mod 2^32` across all shingle hashes `h`. Two sets' estimated Jaccard is then just
 * the fraction of signature positions that agree.
 *
 * `Math.imul` keeps the multiply exact in 32 bits; `>>> 0` normalizes the result to unsigned. A
 * plain `a * h` would exceed 2^53 and silently lose precision.
 */
export function minhashSignature(shingles: Set<string>, numPerm: number = DEFAULT_NEAR_DUP_NUM_PERM): Uint32Array {
  const signature = new Uint32Array(numPerm);
  if (shingles.size === 0) return signature;
  const shingleHashes: number[] = [];
  for (const shingle of shingles) shingleHashes.push(fnv1a32(shingle));
  for (let p = 0; p < numPerm; p++) {
    const [a, b] = permutationCoefficients(p);
    let min = 0xffffffff;
    for (const h of shingleHashes) {
      const v = (Math.imul(a, h) + b) >>> 0;
      if (v < min) min = v;
    }
    signature[p] = min;
  }
  return signature;
}

/**
 * Estimated Jaccard similarity between two MinHash signatures: fraction of positions that agree.
 * Returns 0 for signatures of differing length (should never happen; treated as "not comparable"
 * so a mismatch degrades to an extra embed rather than a wrong skip).
 */
export function signatureSimilarity(a: Uint32Array, b: Uint32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) matches++;
  return matches / a.length;
}

/** Serialize a signature for a SQLite BLOB column (little-endian uint32s). */
export function encodeSignature(signature: Uint32Array): Buffer {
  return Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength);
}

/** Inverse of `encodeSignature`. Tolerates a short/oversized blob by returning what fits. */
export function decodeSignature(blob: Buffer | Uint8Array | null | undefined, numPerm: number = DEFAULT_NEAR_DUP_NUM_PERM): Uint32Array {
  const out = new Uint32Array(numPerm);
  if (!blob) return out;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const usable = Math.min(buf.length, numPerm * 4);
  for (let i = 0; i * 4 < usable; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

/**
 * Normalize chunk text before hashing so a re-ingest that differs only in whitespace, casing or
 * punctuation still hashes identically. Deliberately lossier than the embed input (it is only ever
 * used to detect "same content"), and deliberately NOT used for vector ids.
 */
export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Content hash over NORMALIZED text. Mirrors `chunk.ts`'s `hashContent` (SHA-256, 128 bits) so the
 * two hashing conventions stay recognizably the same, but over normalized text — which is what makes
 * it catch reflow/case-only repeats that the raw-text hash misses.
 */
export function normalizedContentHash(text: string): string {
  return createHash("sha256").update(normalizeForDedup(text), "utf8").digest("hex").slice(0, 32);
}

export interface NearDupCandidate {
  /** Raw-text SHA-256 (128-bit) — matches `document_chunks.content_hash`, so links join to it. */
  contentHash: string;
  /** Normalized-text SHA-256 (128-bit) — the exact-duplicate key. */
  normalizedHash: string;
  chunkId: string;
  symbol: string;
  source: string;
  signature: Uint32Array;
  /** Kept for exact in-batch Jaccard, which is strictly more accurate than the estimate. */
  shingles: Set<string>;
  /**
   * Record id this chunk will be upserted under, when the caller knows it before embedding. Carried
   * onto in-batch references so a later duplicate's link names the canonical vector.
   */
  vectorId?: string | null;
}

export interface NearDupReference {
  contentHash: string;
  chunkId: string;
  /** Normalized hash of the stored chunk; enables an exact (similarity 1.0) match. */
  normalizedHash?: string | null;
  /** Stored MinHash signature, when the reference came from `chunk_dedup_signatures`. */
  signature?: Uint32Array | null;
  /** Stored shingle set, when the caller still has the text (e.g. same-batch comparisons). */
  shingles?: Set<string> | null;
  vectorId?: string | null;
}

export type NearDupKind = "new" | "exact" | "near";

export interface NearDupVerdict {
  kind: NearDupKind;
  /** Similarity to the canonical chunk (1 for exact, else the measured Jaccard estimate). */
  similarity: number;
  threshold: number;
  canonicalHash?: string;
  canonicalChunkId?: string;
  canonicalVectorId?: string;
}

/**
 * Compare one candidate against stored/in-batch references. Exact normalized-hash match wins over
 * any near match; otherwise the best (highest-similarity) reference at/above `threshold` wins.
 * Returns `{kind: "new"}` when nothing clears the bar.
 */
export function classifyNearDuplicate(
  candidate: NearDupCandidate,
  references: readonly NearDupReference[],
  options: { threshold: number },
  /**
   * Optional `normalizedHash -> first reference holding it` index over `references`, so the exact
   * path is a map lookup instead of a scan. Must hold the FIRST reference per hash in list order,
   * which keeps the result identical to the `find` fallback.
   */
  exactIndex?: ReadonlyMap<string, NearDupReference>
): NearDupVerdict {
  const threshold = options.threshold;
  const exact = exactIndex
    ? candidate.normalizedHash
      ? exactIndex.get(candidate.normalizedHash)
      : undefined
    : references.find((ref) => ref.normalizedHash && ref.normalizedHash === candidate.normalizedHash);
  if (exact) {
    return {
      kind: "exact",
      similarity: 1,
      threshold,
      canonicalHash: exact.contentHash,
      canonicalChunkId: exact.chunkId,
      canonicalVectorId: exact.vectorId ?? undefined
    };
  }

  let best: NearDupReference | undefined;
  let bestSimilarity = 0;
  for (const ref of references) {
    let similarity = 0;
    // Prefer exact Jaccard whenever the shingle set is in hand (same-batch comparisons, where we
    // still hold the text); fall back to the stored MinHash estimate otherwise.
    if (ref.shingles && ref.shingles.size > 0 && candidate.shingles.size > 0) {
      similarity = jaccardSimilarity(candidate.shingles, ref.shingles);
    } else if (ref.signature && ref.signature.length > 0) {
      similarity = signatureSimilarity(candidate.signature, ref.signature);
    }
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = ref;
    }
  }

  if (best && bestSimilarity >= threshold) {
    return {
      kind: "near",
      similarity: bestSimilarity,
      threshold,
      canonicalHash: best.contentHash,
      canonicalChunkId: best.chunkId,
      canonicalVectorId: best.vectorId ?? undefined
    };
  }
  return { kind: "new", similarity: bestSimilarity, threshold };
}

export interface NearDupLinkDraft {
  /** Hash of the incoming (duplicate) chunk — its own record is still stored and still retrievable. */
  contentHash: string;
  canonicalHash: string;
  canonicalChunkId: string;
  canonicalVectorId?: string;
  symbol: string;
  source: string;
  kind: "exact" | "near";
  similarity: number;
  threshold: number;
}

export interface NearDupPartition<T> {
  /** Documents that still need an embed call. */
  toEmbed: T[];
  /** Documents skipped as duplicates — their text is still ingested, only the embed is skipped. */
  skipped: T[];
  /** Provenance rows pointing each skipped document at the canonical chunk that answers for it. */
  links: NearDupLinkDraft[];
  /** `(chunkId -> nearest canonical)` map so a duplicate of a duplicate links to the ORIGINAL. */
  canonicalByContentHash: Map<string, { contentHash: string; chunkId: string; vectorId?: string }>;
}

/**
 * Partition a batch into embed / skip, classifying each document against (a) the already-stored
 * chunks supplied by the caller and (b) earlier documents in THIS batch.
 *
 * In-batch chaining matters: if B is a near-dup of A and A is itself a dup of a stored chunk C,
 * B links directly to C. Every record still gets embedded-or-linked; nothing is dropped from the
 * corpus, and the link rows make the skip auditable after the fact.
 */
export function partitionNearDuplicates<T extends NearDupCandidate>(
  documents: T[],
  storedReferences: NearDupReference[],
  options: { threshold: number }
): NearDupPartition<T> {
  const toEmbed: T[] = [];
  const skipped: T[] = [];
  const links: NearDupLinkDraft[] = [];
  const canonicalByContentHash = new Map<string, { contentHash: string; chunkId: string; vectorId?: string }>();

  // ONE running reference list, built once and appended to as documents are embedded — not rebuilt
  // and re-spread for every document (Kody review: quadratic rebuild). Order is the stored references
  // first, then this batch's embeds in arrival order, which is the order the per-document rebuild
  // produced, so exact-match precedence and near-match tie-breaking are unchanged.
  //
  // A SKIPPED document never becomes a reference itself, and needs no extra entry: its canonical is
  // either a stored reference or an earlier in-batch embed, and both are already in this list with
  // their real comparators. That is what makes a duplicate-of-a-duplicate link to the ORIGINAL.
  const references: NearDupReference[] = storedReferences.slice();
  const exactIndex = new Map<string, NearDupReference>();
  const indexExact = (ref: NearDupReference) => {
    if (ref.normalizedHash && !exactIndex.has(ref.normalizedHash)) exactIndex.set(ref.normalizedHash, ref);
  };
  for (const ref of references) indexExact(ref);

  for (const doc of documents) {
    const verdict = classifyNearDuplicate(doc, references, options, exactIndex);
    if (verdict.kind === "new") {
      toEmbed.push(doc);
      const ref: NearDupReference = {
        contentHash: doc.contentHash,
        chunkId: doc.chunkId,
        normalizedHash: doc.normalizedHash,
        signature: doc.signature,
        shingles: doc.shingles,
        vectorId: doc.vectorId ?? null
      };
      references.push(ref);
      indexExact(ref);
      continue;
    }

    skipped.push(doc);
    links.push({
      contentHash: doc.contentHash,
      canonicalHash: verdict.canonicalHash!,
      canonicalChunkId: verdict.canonicalChunkId!,
      canonicalVectorId: verdict.canonicalVectorId,
      symbol: doc.symbol,
      source: doc.source,
      kind: verdict.kind,
      similarity: verdict.similarity,
      threshold: verdict.threshold
    });
    canonicalByContentHash.set(doc.contentHash, {
      contentHash: verdict.canonicalHash!,
      chunkId: verdict.canonicalChunkId!,
      vectorId: verdict.canonicalVectorId
    });
  }

  return { toEmbed, skipped, links, canonicalByContentHash };
}

/** Build the candidate fields (hashes + shingle signature) for one chunk of text. */
export function toNearDupCandidate(input: {
  text: string;
  contentHash: string;
  chunkId: string;
  symbol: string;
  source: string;
  numPerm?: number;
  vectorId?: string | null;
}): NearDupCandidate {
  const shingles = shingleSet(input.text);
  return {
    contentHash: input.contentHash,
    normalizedHash: normalizedContentHash(input.text),
    chunkId: input.chunkId,
    symbol: input.symbol,
    source: input.source,
    signature: minhashSignature(shingles, input.numPerm ?? DEFAULT_NEAR_DUP_NUM_PERM),
    shingles,
    vectorId: input.vectorId ?? null
  };
}