/**
 * Query-embedding LRU cache (R9, 2026-07-01 RAG backlog).
 *
 * Every `retrieveContextDetailed` call re-embeds the query fresh via Voyage, even though the
 * strategy scan fans out near-identical queries per top-candidate symbol and chat commonly
 * re-issues the same question. Under the free-tier Voyage rate limit (3 RPM, a 21s inter-batch
 * stall), repeated identical query embeds are pure waste.
 *
 * This cache stores ONLY the 1024-dim query VECTOR — never Pinecone results. That's the key
 * safety property: Pinecone results depend on symbol/asOf/docType/section/source filters and
 * per-user scoping, all of which must stay live on every call. The query embedding itself is
 * user-independent and filter-independent (a function of `${VOYAGE_MODEL}:${normalizedQuery}`),
 * so caching it introduces no cross-user or stale-filter leakage. Per-user access control lives
 * entirely in the Pinecone filter, applied AFTER a cache hit exactly as it would be after a fresh
 * embed.
 *
 * Consolidated with G8b (PR #293): the key is a content hash of the NORMALIZED query (trim +
 * lowercase + collapsed whitespace) so trivial casing/spacing variants share a hit, and the cache
 * is Default ON.  Disable with RAG_QUERY_EMBED_CACHE=off (or 0/false/no) — then
 * `getCachedQueryEmbedding` always returns `undefined` (forcing a live embed) and
 * `setCachedQueryEmbedding` is a no-op.
 */

import { hashContent } from "./chunk";
import { envFlagOn } from "./env-flag";

/**
 * Whether the query-embed cache is enabled. Default ON (consolidated G8b behavior): it stores only
 * the query VECTOR, so it is safe to run by default and it saves redundant Voyage embeds under the
 * free-tier rate limit. Disable with RAG_QUERY_EMBED_CACHE=off (or 0/false/no).
 */
export function queryEmbedCacheEnabled(): boolean {
  return envFlagOn("RAG_QUERY_EMBED_CACHE", true);
}

const DEFAULT_MAX_ENTRIES = 200;
// A strategy run is 5–12 minutes and re-asks near-identical queries per symbol.  30 minutes
// covers that run.  The cached value is only the query vector, which does not go stale when
// the index changes.
const DEFAULT_TTL_MS = 30 * 60_000;

interface CacheEntry {
  embedding: number[];
  expiresAt: number;
}

// Module-level singleton store (per-process). Deliberately NOT exported so all access goes
// through the getter/setter below, keeping the "never store anything but the vector" invariant
// enforced in one place.
const store = new Map<string, CacheEntry>();

function maxEntries(): number {
  const parsed = Number(process.env.RAG_QUERY_EMBED_CACHE_MAX ?? DEFAULT_MAX_ENTRIES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ENTRIES;
}

function ttlMs(): number {
  const parsed = Number(process.env.RAG_QUERY_EMBED_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

/**
 * Normalize query text for cache-key purposes: trim, lowercase, and collapse internal whitespace
 * (ported from G8b). Near-identical queries that differ only by casing/spacing share one entry,
 * raising the hit rate on strategy-scan fan-outs. Tradeoff: a casing/spacing variant is served the
 * cached vector of its normalized form rather than a fresh per-variant embed — acceptable for a
 * retrieval-quality cache, since the query vector (not Pinecone results) is what's reused.
 */
export function normalizeQueryCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build the cache key. Deliberately omits userId and any per-user/filter context — the key is ONLY
 * `${model}:${hash(normalized query)}`, which is the entire point: the query vector is the
 * same regardless of who's asking or what Pinecone filter will be applied afterward.
 */
export function queryEmbedCacheKey(model: string, query: string): string {
  // Content hash of the normalized query.  Casing and whitespace still share one entry, and
  // the map does not retain the query text.
  return `${model}:${hashContent(normalizeQueryCacheKey(query))}`;
}

/** Look up a cached query embedding. Returns `undefined` on a miss, expiry, or when the flag is off. */
export function getCachedQueryEmbedding(model: string, query: string): number[] | undefined {
  if (!queryEmbedCacheEnabled()) return undefined;
  const key = queryEmbedCacheKey(model, query);
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  // LRU touch: re-insert to move this key to the "most recently used" end of Map iteration order.
  store.delete(key);
  store.set(key, entry);
  return entry.embedding;
}

/** Store a query embedding. No-op when the flag is off (never grows the cache when disabled). */
export function setCachedQueryEmbedding(model: string, query: string, embedding: number[]): void {
  if (!queryEmbedCacheEnabled()) return;
  const key = queryEmbedCacheKey(model, query);
  store.delete(key); // re-insert at the end even on overwrite, for correct LRU ordering
  store.set(key, { embedding, expiresAt: Date.now() + ttlMs() });
  const limit = maxEntries();
  while (store.size > limit) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

/** Test-only: clear the cache so tests don't leak state across cases/files. */
export function clearQueryEmbedCache(): void {
  store.clear();
}

/** Test-only: current cache size. */
export function queryEmbedCacheSize(): number {
  return store.size;
}
