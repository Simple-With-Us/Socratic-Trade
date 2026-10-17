// db-embed-stage.ts — durable "paid but not yet delivered" document-embedding stage.
//
// Owner directive (2026-08-09): "if we spent on openrouter then we should spend on putting it
// into the database so we aren't wasteful" — a paid document embedding must NEVER be paid for
// twice. The bounded process-local cache in vector-db.ts (L1) evaporates on restart and on
// TTL/entry-cap eviction, so any Pinecone upsert failure (monthly WU exhaustion, per-second
// 429s, network blips, deploy restarts) used to discard computed vectors, and the retry
// re-embedded the same text through paid OpenRouter.
//
// This table is the durable L2. Rows exist ONLY in the window between a successful (paid)
// embed batch and the successful Pinecone delivery of those vectors: storeContextsImpl
// persists one row per unique embed input immediately after provider-response validation and
// deletes the rows once the vectors are durably delivered (per upsert batch for plain calls;
// after the committed re-upsert + markCommitted for managed two-phase commits). A retry
// therefore finds the exact vector by (content_hash of the exact embed-input text, model,
// embed revision) and upserts WITHOUT a second paid embed call. Steady state is ~zero rows.
//
// What a row deliberately does NOT store: the full Pinecone record (id + metadata). Replay is
// always a re-run of storeContexts/storeDocument from the same source document (the SEC
// ingest retry queue and the hourly cycles re-drive the same producers), which rebuilds
// ids/metadata through the SAME code path — managed-commit receipts, lease fencing, tenant
// scoping, and retrieval-metadata versioning included. Persisting record metadata here would
// only create a second, driftable copy of that logic's output, and a replayed stale
// attempt_token/commit_id would actively violate the two-phase commit ledger. The vector is
// the only artifact that costs money; the symbol/source/chunk_id/user_scope columns are
// observability context, not replay inputs.
//
// WEBPACK TRAP: reachable from scheduler.ts (via vector-db.ts and audit-prune.ts) — no "os"
// import, no "node:" import specifiers in this module.

import "server-only";
import { getDb } from "./db";
import { timeSync } from "./slow-sync-guard";

/** Retention for orphaned rows (their source document was superseded before any retry ran). */
export const EMBED_STAGE_RETENTION_DAYS = 35;
/** Defensive size cap so a stuck month cannot balloon the DB (1024-dim f32 ~ 4 KB/chunk). */
export const EMBED_STAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Estimated fixed per-row overhead (keys, context columns, b-tree) beyond the vector blob. */
const EMBED_STAGE_ROW_OVERHEAD_BYTES = 160;
/** SQL `IN (...)` chunking bound (well under SQLite's bound-parameter limit). */
const EMBED_STAGE_LOOKUP_CHUNK = 400;
/** Oldest-first delete batch size while draining an over-cap table. */
const EMBED_STAGE_CAP_PRUNE_BATCH = 500;

export interface EmbedStageRowInput {
  /** hashContent() of the EXACT provider embed-input text (post-clean), NOT of the stored text. */
  contentHash: string;
  model: string;
  revision: string;
  vector: ReadonlyArray<number>;
  /** Observability context only — never used to rebuild an upsert. */
  symbol?: string;
  source?: string;
  chunkId?: string;
  userScope?: string;
}

/** Encode an embedding as Float32Array little-endian bytes (4 bytes per dimension). */
export function encodeEmbeddingF32(vector: ReadonlyArray<number>): Buffer {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Decode a staged vector blob back to number[]. Returns undefined (never throws) on any shape
 * mismatch or non-finite value so a corrupt row degrades to a cache miss, not a bad upsert.
 * Copies into a fresh ArrayBuffer first — SQLite driver Buffers are pool-allocated and their
 * byteOffset is not guaranteed 4-byte aligned for a direct Float32Array view.
 */
export function decodeEmbeddingF32(blob: unknown, dims: number): number[] | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  if (!Number.isInteger(dims) || dims <= 0 || blob.byteLength !== dims * 4) return undefined;
  const aligned = new ArrayBuffer(blob.byteLength);
  new Uint8Array(aligned).set(blob);
  const f32 = new Float32Array(aligned);
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    const value = f32[i]!;
    if (!Number.isFinite(value)) return undefined;
    out[i] = value;
  }
  return out;
}

/**
 * Persist paid vectors durably BEFORE any Pinecone upsert attempt. INSERT OR REPLACE: a
 * re-embed of the same (hash, model, revision) key simply refreshes the row and its clock.
 * Returns the number of rows written.
 */
export function stageEmbeddedVectors(rows: EmbedStageRowInput[]): number {
  if (rows.length === 0) return 0;
  return timeSync("stageEmbeddedVectors", `${rows.length} rows`, () => stageEmbeddedVectorsImpl(rows));
}

function stageEmbeddedVectorsImpl(rows: EmbedStageRowInput[]): number {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO embed_stage
      (content_hash, model, revision, dims, vector, symbol, source, chunk_id, user_scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  let staged = 0;
  const writeAll = db.transaction((batch: EmbedStageRowInput[]) => {
    for (const row of batch) {
      if (!row.contentHash || !row.model || !row.revision || row.vector.length === 0) continue;
      insert.run(
        row.contentHash,
        row.model,
        row.revision,
        row.vector.length,
        encodeEmbeddingF32(row.vector),
        row.symbol ?? "",
        row.source ?? "",
        row.chunkId ?? "",
        row.userScope ?? "local",
        now
      );
      staged += 1;
    }
  });
  writeAll(rows);
  return staged;
}

/**
 * Batch lookup of staged vectors for an exact (content_hash, model, revision) key set.
 * Corrupt/undecodable rows are deleted in place (self-heal) and reported as misses.
 */
export function getStagedEmbeddings(
  contentHashes: string[],
  model: string,
  revision: string
): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const unique = [...new Set(contentHashes.filter(Boolean))];
  if (unique.length === 0) return found;
  const db = getDb();
  const deleteOne = db.prepare(
    "DELETE FROM embed_stage WHERE content_hash = ? AND model = ? AND revision = ?"
  );
  for (let offset = 0; offset < unique.length; offset += EMBED_STAGE_LOOKUP_CHUNK) {
    const slice = unique.slice(offset, offset + EMBED_STAGE_LOOKUP_CHUNK);
    const placeholders = slice.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT content_hash, dims, vector FROM embed_stage
         WHERE model = ? AND revision = ? AND content_hash IN (${placeholders})`
      )
      .all(model, revision, ...slice) as Array<{ content_hash: string; dims: number; vector: unknown }>;
    for (const row of rows) {
      const decoded = decodeEmbeddingF32(row.vector, row.dims);
      if (decoded) found.set(row.content_hash, decoded);
      else deleteOne.run(row.content_hash, model, revision);
    }
  }
  return found;
}

/** Delete delivered rows once their vectors are durably in Pinecone. Returns rows removed. */
export function deleteStagedEmbeddings(
  contentHashes: string[],
  model: string,
  revision: string
): number {
  const unique = [...new Set(contentHashes.filter(Boolean))];
  if (unique.length === 0) return 0;
  const db = getDb();
  let deleted = 0;
  for (let offset = 0; offset < unique.length; offset += EMBED_STAGE_LOOKUP_CHUNK) {
    const slice = unique.slice(offset, offset + EMBED_STAGE_LOOKUP_CHUNK);
    const placeholders = slice.map(() => "?").join(", ");
    deleted += db
      .prepare(
        `DELETE FROM embed_stage WHERE model = ? AND revision = ? AND content_hash IN (${placeholders})`
      )
      .run(model, revision, ...slice).changes;
  }
  return deleted;
}

export interface EmbedStageStats {
  rows: number;
  /** Estimated stored bytes (vector blobs + fixed per-row overhead estimate). */
  bytes: number;
  oldestCreatedAt: string | null;
}

export function embedStageStats(): EmbedStageStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(vector)), 0) AS vec_bytes,
              MIN(created_at) AS oldest
       FROM embed_stage`
    )
    .get() as { rows: number; vec_bytes: number; oldest: string | null };
  return {
    rows: row.rows,
    bytes: row.vec_bytes + row.rows * EMBED_STAGE_ROW_OVERHEAD_BYTES,
    oldestCreatedAt: row.oldest ?? null
  };
}

export interface EmbedStageSweepResult {
  /** Rows removed by the 35-day retention window (orphans whose document was superseded). */
  expired: number;
  /** Rows removed oldest-first by the defensive size cap. */
  capPruned: number;
  /** Estimated table bytes after the sweep. */
  bytesAfter: number;
}

/**
 * Retention + size-cap sweep, invoked from the daily audit-prune housekeeping lane. Expected
 * steady state deletes nothing (rows normally live seconds-to-days). The size cap emits ONE
 * audit row per over-cap event, not one per pruned row.
 */
/** No age or cap deletes (2026-10-15).  Rows clear only via `deleteStagedEmbeddings` after delivery. */
export function sweepEmbedStage(
  _now: Date = new Date(),
  _maxBytes: number = EMBED_STAGE_MAX_BYTES
): EmbedStageSweepResult {
  const stats = embedStageStats();
  return { expired: 0, capPruned: 0, bytesAfter: stats.bytes };
}
