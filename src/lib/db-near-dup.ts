// db-near-dup.ts — pre-embed near-duplicate signature index + provenance links (ST-4541, RAG (8)).
//
// Companion to `near-dup-embed.ts` (pure detection logic) and `db-learning.ts` (exact-hash dedup).
// Two additive tables, both INSERT-only:
//
//  * `chunk_dedup_signatures` — one row per chunk we actually paid to embed, holding its normalized
//    content hash and MinHash signature. This is what lets a LATER ingest compare against recent
//    same-source chunks WITHOUT re-reading or storing the full text: the signature is ~256 bytes
//    (64 x uint32) versus a multi-KB chunk body, and the source record itself stays where it
//    already lives (Pinecone metadata + the producer's own store).
//
//  * `chunk_dedup_links` — the provenance row written when a chunk's embed was SKIPPED. It points
//    at the canonical chunk that answers for it (content_hash + chunk_id + vector_id), records
//    whether the match was `exact` (normalized hash) or `near` (Jaccard), and the similarity and
//    threshold in force at decision time. This is the audit trail proving no data was discarded:
//    the incoming chunk keeps its own identity and record; only the paid embed call is skipped.
//
// RETENTION — NONE, BY DESIGN. These tables are deliberately NOT registered in
// `sqlite-storage-hygiene.ts`'s CATEGORY_BY_TABLE/PRUNABLE_TABLES maps, so `audit-prune.ts` and the
// hygiene reaper never touch them. Same posture as the ST directive that stored data is kept
// forever: links are evidence, and a pruned link would silently erase the record of a skipped embed.
// Nothing in this module deletes, prunes, caps or updates a stored row — writes are INSERT OR IGNORE
// keyed on a content-derived primary key, so re-running an ingest is idempotent, not destructive.

import "server-only";
import { getDb } from "./db";
import { timeSync } from "./slow-sync-guard";
import { decodeSignature, type NearDupReference, DEFAULT_NEAR_DUP_WINDOW } from "./rag/near-dup-embed";

/**
 * ISOLATION KEY for every lookup and every write (review 17915833/1).
 *
 * A skipped embed is only safe if the canonical vector it inherits is actually RETRIEVABLE for the
 * skipping caller. That requires two things, so both are part of the signature's identity:
 *
 *  * `tenantScope` — `vectorTenantScope(userId, scope)`, i.e. the exact retrieval-isolation key
 *    ("shared:operator" or "private:<sha256>"). Without it, tenant A's chunk could be judged a
 *    duplicate of tenant B's signature and skipped, and since the skip means "never write a vector",
 *    that chunk would never exist in A's isolated namespace — silently unretrievable for A.
 *  * `embedModel`/`embedRevision` — the vector space that produced the canonical vector. A vector
 *    embedded in another space is not a valid substitute for the skipping caller's space.
 *
 * Every lookup filters on all three. An empty value can therefore never match a scoped lookup, which
 * makes legacy/unscoped rows fail OPEN (an extra paid embed) instead of causing a wrong skip.
 */
export interface DedupScope {
  tenantScope: string;
  embedModel: string;
  embedRevision: string;
}

export interface ChunkDedupSignatureInput {
  /** Raw-text SHA-256 (128-bit) — joins to `document_chunks.content_hash`. */
  contentHash: string;
  /** Normalized-text SHA-256 (128-bit) — the exact-duplicate key. */
  normalizedHash: string;
  /** Serialized MinHash signature (see `encodeSignature`). */
  signature: Buffer;
  numPerm: number;
  symbol: string;
  source: string;
  chunkId: string;
  /** Record id actually upserted for this chunk; becomes a later link's `canonical_vector_id`. */
  vectorId?: string;
  tenantScope: string;
  embedModel: string;
  embedRevision: string;
}

export interface ChunkDedupLinkInput {
  contentHash: string;
  canonicalHash: string;
  canonicalChunkId: string;
  canonicalVectorId?: string;
  symbol: string;
  source: string;
  kind: "exact" | "near";
  similarity: number;
  threshold: number;
  tenantScope: string;
  embedModel: string;
  embedRevision: string;
}

/**
 * Record the signature of chunks we actually embedded, so future ingests can compare against them.
 * INSERT OR IGNORE: a signature is a pure function of the chunk text AND its isolation scope, so a
 * repeat write is a no-op and an existing row is never overwritten (no update, no delete).
 */
export function insertChunkDedupSignatures(rows: ChunkDedupSignatureInput[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO chunk_dedup_signatures
      (content_hash, normalized_hash, signature, num_perm, symbol, source, chunk_id, vector_id,
       tenant_scope, embed_model, embed_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const insertMany = db.transaction((batch: ChunkDedupSignatureInput[]) => {
    for (const row of batch) {
      stmt.run(
        row.contentHash,
        row.normalizedHash,
        row.signature,
        row.numPerm,
        row.symbol,
        row.source,
        row.chunkId,
        row.vectorId ?? "",
        row.tenantScope,
        row.embedModel,
        row.embedRevision,
        now
      );
    }
  });
  timeSyncGuard(() => insertMany(rows));
}

/**
 * Recent stored chunks for one (tenant, symbol, source, embedding-space) scope, newest first, as
 * near-duplicate references. Bounded by `limit` (a comparison budget, not a retention window —
 * nothing is removed by it).
 */
export function findRecentDedupReferences(
  scope: DedupScope,
  symbol: string,
  source: string,
  limit: number = DEFAULT_NEAR_DUP_WINDOW
): NearDupReference[] {
  const bounded = Math.max(1, Math.floor(limit));
  const rows = getDb()
    .prepare(`
      SELECT content_hash, normalized_hash, chunk_id, vector_id, signature, num_perm
      FROM chunk_dedup_signatures
      WHERE tenant_scope = ? AND embed_model = ? AND embed_revision = ? AND symbol = ? AND source = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(scope.tenantScope, scope.embedModel, scope.embedRevision, symbol, source, bounded) as Array<{
    content_hash: string;
    normalized_hash: string;
    chunk_id: string;
    vector_id: string | null;
    signature: Buffer | null;
    num_perm: number;
  }>;
  return rows.map(toReference);
}

/**
 * Scope-matched lookup of every chunk sharing a normalized hash within the SAME tenant and embedding
 * space, across that tenant's symbol/source labels. Catches a repeat that arrives under a different
 * label (a re-ingest of the same text by a producer that stamps a fresh accession), which the
 * per-label window above would miss. Still filtered to the caller's own isolation scope: a matching
 * text held by ANOTHER tenant is never a usable canonical for this caller.
 */
export function findDedupReferencesByNormalizedHash(
  scope: DedupScope,
  normalizedHash: string
): NearDupReference[] {
  const rows = getDb()
    .prepare(`
      SELECT content_hash, normalized_hash, chunk_id, vector_id, signature, num_perm
      FROM chunk_dedup_signatures
      WHERE tenant_scope = ? AND embed_model = ? AND embed_revision = ? AND normalized_hash = ?
    `)
    .all(scope.tenantScope, scope.embedModel, scope.embedRevision, normalizedHash) as Array<{
    content_hash: string;
    normalized_hash: string;
    chunk_id: string;
    vector_id: string | null;
    signature: Buffer | null;
    num_perm: number;
  }>;
  return rows.map(toReference);
}

/**
 * Record the provenance link for every chunk whose embed we skipped. INSERT OR IGNORE on
 * (content_hash, canonical_hash, tenant_scope) — a duplicate is linked to every canonical it
 * matched, forever, and two tenants linking the same text never collide into one row.
 */
export function insertChunkDedupLinks(rows: ChunkDedupLinkInput[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO chunk_dedup_links
      (content_hash, canonical_hash, canonical_chunk_id, canonical_vector_id,
       symbol, source, match_kind, similarity, threshold,
       tenant_scope, embed_model, embed_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const insertMany = db.transaction((batch: ChunkDedupLinkInput[]) => {
    for (const row of batch) {
      stmt.run(
        row.contentHash,
        row.canonicalHash,
        row.canonicalChunkId,
        row.canonicalVectorId ?? "",
        row.symbol,
        row.source,
        row.kind,
        row.similarity,
        row.threshold,
        row.tenantScope,
        row.embedModel,
        row.embedRevision,
        now
      );
    }
  });
  timeSyncGuard(() => insertMany(rows));
}

function toReference(row: {
  content_hash: string;
  normalized_hash: string;
  chunk_id: string;
  vector_id: string | null;
  signature: Buffer | null;
  num_perm: number;
}): NearDupReference {
  return {
    contentHash: row.content_hash,
    chunkId: row.chunk_id,
    normalizedHash: row.normalized_hash,
    signature: row.signature ? decodeSignature(row.signature, row.num_perm || undefined) : null,
    // '' on rows written before the column existed: the link then records a blank vector id, which
    // is an incomplete audit field, never a wrong skip.
    vectorId: row.vector_id || null
  };
}

function timeSyncGuard<T>(fn: () => T): T {
  return timeSync("db-near-dup", "persist dedup rows", fn);
}

/** Total recorded link rows (observability / tests): how many paid embeds we avoided. */
export function countChunkDedupLinks(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS cnt FROM chunk_dedup_links").get() as { cnt: number };
  return row.cnt;
}

/** Total recorded signature rows (observability / tests). */
export function countChunkDedupSignatures(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS cnt FROM chunk_dedup_signatures").get() as { cnt: number };
  return row.cnt;
}