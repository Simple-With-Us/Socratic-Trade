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
//
// ST-4540 (embed-stage no-data-loss): ST data is kept FOREVER. A paid vector that has not been
// durably delivered is the single most expensive row in this database, so the ONLY sanctioned way
// to remove one is deleteStagedEmbeddings() with a verified delivery receipt. Everything that used
// to throw rows away without checking delivery is now non-destructive:
//   * the 35-day age sweep deletes nothing at all — it only counts and reports;
//   * the 2 GiB size cap deletes nothing — it emits a loud audit + Sentry warning;
//   * an undecodable row is QUARANTINED (marked, kept) for re-embed from source, never deleted.
// Undelivered rows therefore survive restarts, quota exhaustion, deploys and every sweep.

import "server-only";
import { audit, getDb } from "./db";
import { logWarn } from "./sentry-metrics";
import { timeSync } from "./slow-sync-guard";

/** Age after which an undelivered row is reported as backlog by the observer. Nothing is age-deleted. */
export const EMBED_STAGE_RETENTION_DAYS = 35;
/**
 * Audited size ceiling for the table. ST-4540: this is an ALARM, not a prune trigger — an
 * over-cap table means delivery is stuck and must be paged on, and deleting undelivered rows to
 * get back under it would destroy paid vectors. The sweep warns and keeps every row.
 */
export const EMBED_STAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Estimated fixed per-row overhead (keys, context columns, b-tree) beyond the vector blob. */
const EMBED_STAGE_ROW_OVERHEAD_BYTES = 160;
/** SQL `IN (...)` chunking bound (well under SQLite's bound-parameter limit). */
const EMBED_STAGE_LOOKUP_CHUNK = 400;

/** Vector-store backends whose acknowledged upsert counts as durable delivery. */
export type EmbedStageStore = "pinecone" | "qdrant";

/**
 * Proof-of-delivery argument required by deleteStagedEmbeddings(). It is a required parameter so
 * every call site must name the backend whose acknowledged upsert made these vectors durable —
 * there is no code path that can drop a paid vector without saying why.
 */
export interface EmbedStageDeliveryReceipt {
  /** Backend that acknowledged the upsert (plain batch) or the committed re-upsert + finalize. */
  store: EmbedStageStore;
  /** Delivery timestamp; defaults to now. */
  deliveredAt?: string;
}

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
  // delivered_at / delivered_store / quarantined_* are written as NULL: a fresh (re)embed is
  // by definition NOT yet delivered, and it supersedes any earlier quarantine marker (that is
  // exactly how a quarantined row is healed — re-embedded from source).
  const insert = db.prepare(`
    INSERT OR REPLACE INTO embed_stage
      (content_hash, model, revision, dims, vector, symbol, source, chunk_id, user_scope, created_at,
       delivered_at, delivered_store, quarantined_at, quarantine_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
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
 *
 * ST-4540: an undecodable row is QUARANTINED and KEPT — never deleted. Deleting it here destroyed
 * the evidence that a vector had been paid for and was un-recoverable, which silently converted a
 * recoverable corruption into a guaranteed re-embed. Instead the row is marked
 * (quarantined_at/quarantine_reason), reported as a miss so the caller re-embeds from source, and
 * that re-embed replaces the row via stageEmbeddedVectors' INSERT OR REPLACE, clearing the marker.
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
  const quarantine = db.prepare(
    `UPDATE embed_stage SET quarantined_at = COALESCE(quarantined_at, ?), quarantine_reason = ?
     WHERE content_hash = ? AND model = ? AND revision = ?`
  );
  const quarantinedAt = new Date().toISOString();
  const quarantinedKeys: string[] = [];
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
      else {
        quarantinedKeys.push(row.content_hash);
        quarantine.run(
          quarantinedAt,
          `undecodable_vector:dims=${row.dims}:bytes=${byteLengthOf(row.vector)}`,
          row.content_hash,
          model,
          revision
        );
      }
    }
  }
  if (quarantinedKeys.length > 0) {
    // One audit row per lookup, never one per corrupt row: a systematically corrupt table must
    // not flood audit_events. The keys stay in embed_stage for re-embed from source.
    audit(
      "embed_stage_quarantine",
      {
        quarantined: quarantinedKeys.length,
        attempted: unique.length,
        model,
        revision,
        note: "rows kept for re-embed from source; never deleted"
      },
      "local"
    );
    logWarn("embed_stage: undecodable staged vectors quarantined (kept for re-embed)", {
      quarantined: quarantinedKeys.length,
      attempted: unique.length,
      model,
      revision
    });
  }
  return found;
}

/** Byte length of a stored vector blob, for the quarantine reason. Never throws. */
function byteLengthOf(blob: unknown): number {
  return blob instanceof Uint8Array ? blob.byteLength : -1;
}

/**
 * The ONLY sanctioned remover of embed_stage rows, and it requires a delivery receipt.
 *
 * ST-4540: deletion is gated on durable delivery. Each key is first stamped with the backend that
 * acknowledged it and a delivery timestamp, then the delete removes only rows carrying that exact
 * receipt. This makes the ordering auditable and makes an accidental undelivered delete impossible
 * to express: there is no overload that deletes without naming the store that took the vector.
 *
 * The stamp and the delete are SEPARATE transactions on purpose, so the receipt is durable rather
 * than transient:
 *   * crash (or a throw) between the two leaves the row stamped delivered and KEPT. No sweep
 *     removes it (sweepEmbedStage is read-only); only a later by-key call to this function for the
 *     same content hash can. It is not counted in `undelivered`, so it shows up only as
 *     `rows - undelivered` and in the byte total behind the over-cap alarm;
 *   * a key re-staged between the two (a fresh embed clears delivered_at to NULL) does not match
 *     the receipt, so the older delivery can never remove the newer undelivered vector.
 *
 * Call this only after the vector store has acknowledged the upsert (plain calls, per upsert batch)
 * or after the managed two-phase commit's committed re-upsert + markCommitted.
 *
 * Returns rows removed.
 */
export function deleteStagedEmbeddings(
  contentHashes: string[],
  model: string,
  revision: string,
  receipt: EmbedStageDeliveryReceipt
): number {
  const unique = [...new Set(contentHashes.filter(Boolean))];
  if (unique.length === 0) return 0;
  if (!receipt?.store) {
    // Fail closed: an unnamed backend is not proof of delivery.
    throw new Error("embed_stage_delete_requires_delivery_receipt");
  }
  const db = getDb();
  const deliveredAt = receipt.deliveredAt ?? new Date().toISOString();
  const markDelivered = db.prepare(
    `UPDATE embed_stage SET delivered_at = ?, delivered_store = ?
     WHERE model = ? AND revision = ? AND content_hash = ?`
  );
  // Delete is constrained to the receipt just written, so a key that was concurrently re-staged
  // (delivered_at cleared to NULL by a fresh embed) can never be removed by an older delivery.
  const deleteDelivered = db.prepare(
    `DELETE FROM embed_stage
     WHERE model = ? AND revision = ? AND content_hash = ?
       AND delivered_at = ? AND delivered_store = ?`
  );
  let deleted = 0;
  // Two transactions, deliberately. The stamp commits first so a crash between the two leaves an
  // auditable "delivered but stranded" row (kept; see the note above) instead of silently rolling
  // the evidence of delivery back — and so a re-stage landing between them (which clears
  // delivered_at) makes the constrained delete match nothing.
  const stampDelivered = db.transaction((keys: string[]) => {
    for (const key of keys) markDelivered.run(deliveredAt, receipt.store, model, revision, key);
  });
  const drain = db.transaction((keys: string[]) => {
    for (const key of keys) {
      deleted += deleteDelivered.run(model, revision, key, deliveredAt, receipt.store).changes;
    }
  });
  for (let offset = 0; offset < unique.length; offset += EMBED_STAGE_LOOKUP_CHUNK) {
    const slice = unique.slice(offset, offset + EMBED_STAGE_LOOKUP_CHUNK);
    stampDelivered(slice);
    drain(slice);
  }
  return deleted;
}

export interface EmbedStageStats {
  rows: number;
  /** Estimated stored bytes (vector blobs + fixed per-row overhead estimate). */
  bytes: number;
  oldestCreatedAt: string | null;
  /** Rows with NO delivery receipt — paid vectors still owed to the vector store. */
  undelivered: number;
  /** Rows quarantined as undecodable, kept for re-embed from source. */
  quarantined: number;
  /** Oldest undelivered created_at — the age of the longest-undelivered paid vector. */
  oldestUndeliveredCreatedAt: string | null;
  /**
   * Undelivered rows older than the retention cutoff. Only computed when a cutoff is supplied;
   * 0 otherwise. Used by the observer's backlog alarm.
   */
  pastWindowUndelivered: number;
}

/**
 * Single-scan table summary. Pass `cutoffIso` to also get the past-window undelivered count in
 * the SAME pass — the sweep needs both, and `SUM(LENGTH(vector))` reads every BLOB, so scanning
 * twice on a multi-GiB table is the expensive part, not the counting.
 */
export function embedStageStats(cutoffIso?: string): EmbedStageStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(vector)), 0) AS vec_bytes,
              MIN(created_at) AS oldest,
              SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS undelivered,
              SUM(CASE WHEN quarantined_at IS NOT NULL THEN 1 ELSE 0 END) AS quarantined,
              MIN(CASE WHEN delivered_at IS NULL THEN created_at END) AS oldest_undelivered,
              SUM(CASE WHEN ? IS NOT NULL AND created_at < ? AND delivered_at IS NULL
                       THEN 1 ELSE 0 END) AS past_window_undelivered
       FROM embed_stage`
    )
    .get(cutoffIso ?? null, cutoffIso ?? null) as {
    rows: number;
    vec_bytes: number;
    oldest: string | null;
    undelivered: number | null;
    quarantined: number | null;
    oldest_undelivered: string | null;
    past_window_undelivered: number | null;
  };
  return {
    rows: row.rows,
    bytes: row.vec_bytes + row.rows * EMBED_STAGE_ROW_OVERHEAD_BYTES,
    oldestCreatedAt: row.oldest ?? null,
    undelivered: row.undelivered ?? 0,
    quarantined: row.quarantined ?? 0,
    oldestUndeliveredCreatedAt: row.oldest_undelivered ?? null,
    pastWindowUndelivered: row.past_window_undelivered ?? 0
  };
}

export interface EmbedStageSweepResult {
  /**
   * Always 0. The age window no longer deletes anything (ST-4540 + the 2026-10-15 forever-retention
   * policy); the field is kept so audit-prune/scheduler accounting stays stable.
   */
  expired: number;
  /**
   * Always 0. Retained for the audit-prune/scheduler accounting shape; ST-4540 removed the
   * over-cap deletion outright, so no row is ever pruned for size.
   */
  capPruned: 0;
  /** Undelivered rows still owed to the vector store — reported, never deleted. */
  undeliveredRetained: number;
  /** True when the table is over EMBED_STAGE_MAX_BYTES — an alarm, NOT a prune trigger. */
  overCap: boolean;
  /** Estimated table bytes after the sweep. */
  bytesAfter: number;
}

/**
 * Read-only embed_stage observer, invoked from the daily audit-prune housekeeping lane.
 *
 * ST-4540 — this function is deliberately unable to lose a paid vector. It issues NO delete at
 * all (no age window, no size cap), which also keeps `test/forever-retention-no-age-delete.test.ts`
 * green: the only remover in this module is `deleteStagedEmbeddings`, by key, after a delivery
 * receipt. What remains is the loud part of the old behaviour:
 *   * undelivered rows past the retention window are counted and reported, because an undelivered
 *     vector is money already spent and must not be mistaken for garbage;
 *   * an over-cap table raises ONE audit row + ONE Sentry warning. Over-cap means delivery is
 *     stuck and a human should look — the old code instead deleted oldest-first paid vectors;
 *   * quarantined rows are simply counted — they await a re-embed from source, not disposal.
 */
export function sweepEmbedStage(
  now: Date = new Date(),
  maxBytes: number = EMBED_STAGE_MAX_BYTES
): EmbedStageSweepResult {
  const cutoff = new Date(now.getTime() - EMBED_STAGE_RETENTION_DAYS * 24 * 3600_000).toISOString();
  // Observation only: nothing below this line mutates embed_stage.
  //
  // ONE table scan, not three. This table is unbounded by design (undelivered rows are never
  // deleted) and `SUM(LENGTH(vector))` reads every BLOB, so a stuck-delivery backlog turns each
  // extra pass into real latency on the daily audit-prune lane. The empty-table early exit keeps
  // the common case (everything delivered promptly) off the scan entirely.
  const stats = embedStageStats(cutoff);
  if (stats.rows === 0) {
    return { expired: 0, capPruned: 0, undeliveredRetained: 0, overCap: false, bytesAfter: 0 };
  }
  const pastWindowUndelivered = stats.pastWindowUndelivered;
  if (pastWindowUndelivered > 0) {
    audit(
      "embed_stage_undelivered_backlog",
      {
        undeliveredPastRetention: pastWindowUndelivered,
        retentionDays: EMBED_STAGE_RETENTION_DAYS,
        note: "paid vectors retained until durably delivered; never age-deleted"
      },
      "local"
    );
    logWarn("embed_stage: undelivered paid vectors past the retention window are RETAINED", {
      undeliveredPastRetention: pastWindowUndelivered,
      retention_days: EMBED_STAGE_RETENTION_DAYS
    });
  }

  const overCap = stats.bytes > maxBytes;
  if (overCap) {
    // Loud, and non-destructive. Under the old cap this deleted oldest-first, which could destroy
    // a day of undelivered paid embeddings to satisfy a byte budget.
    audit(
      "embed_stage_over_cap",
      {
        bytes: stats.bytes,
        maxBytes,
        rows: stats.rows,
        undelivered: stats.undelivered,
        oldestUndeliveredCreatedAt: stats.oldestUndeliveredCreatedAt,
        note: "ALARM ONLY - no rows deleted (ST-4540)"
      },
      "local"
    );
    logWarn("embed_stage: table is over the size ceiling; NO rows deleted (ST-4540)", {
      bytes: stats.bytes,
      max_bytes: maxBytes,
      rows: stats.rows,
      undelivered: stats.undelivered,
      oldest_undelivered_created_at: stats.oldestUndeliveredCreatedAt ?? ""
    });
  }

  // The observer mutates nothing, so "after" equals the current size, and the undelivered count
  // came from the same single scan as everything else.
  return { expired: 0, capPruned: 0, undeliveredRetained: stats.undelivered, overCap, bytesAfter: stats.bytes };
}
