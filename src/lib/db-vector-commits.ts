// Durable two-phase vector commit and transcript-version receipts.

import "server-only";
import { getDb } from "./db";

export type VectorCommitState = "pending" | "receipts_persisted" | "committed" | "aborted";

export interface BeginVectorCommitInput {
  id: string;
  tenantScope: string;
  userId: string;
  source: string;
  accession: string;
  documentKey: string;
  contentVersion: string;
  retrievalMetadataVersion: string;
  parserRevision: string;
  embedRevision: string;
  expectedVectors: number;
  /** Nonsecret physical provider/tenant authority; absent preserves legacy compatibility. */
  providerAuthority?: string;
  /** Immutable local ledger authority that owns the managed namespace and v3 id prefix. */
  ledgerAuthority?: string;
  vectorNamespace?: "managed" | "fmp-transcripts";
  attemptToken: string;
  leaseExpiresAt: string;
  now?: string;
}

export type BeginVectorCommitResult = "started" | "already_committed" | "busy";

export interface ActiveVectorCommitProof {
  commitId: string;
  attemptToken: string;
}

/** Run a source-completion write only while the exact non-reconciling commit/head remains active.
 * The callback shares this SQLite transaction, closing the invalidate-vs-source-ledger race. */
export function runWithActiveVectorCommitProof<T>(
  proof: ActiveVectorCommitProof,
  work: () => T
): T {
  const database = getDb();
  return database.transaction(() => {
    const active = database.prepare(`
      SELECT 1 AS ok
      FROM vector_ingest_commits c
      JOIN vector_document_heads h
        ON h.commit_id = c.id
        AND h.tenant_scope = c.tenant_scope
        AND h.source = c.source
        AND h.accession = c.document_key
      WHERE c.id = ? AND c.attempt_token = ? AND c.state = 'committed'
        AND c.lease_expires_at IS NULL
    `).get(proof.commitId, proof.attemptToken);
    if (!active) throw new Error("Vector commit proof is no longer active.");
    return work();
  })();
}

export interface ManagedChunkOccurrence {
  vectorId: string;
  contentHash: string;
  symbol: string;
  source: string;
  accession: string;
  sequence?: number;
  documentName?: string;
  section: string;
  ordinal: number;
  acceptedAt: string;
  tenantScope: string;
  contentVersion: string;
  commitId: string;
  receiptState: "pending" | "committed";
  createdAt: string;
}

export function insertManagedChunkOccurrences(occurrences: ManagedChunkOccurrence[]): void {
  if (occurrences.length === 0) return;
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO chunk_occurrences (
      vector_id, content_hash, symbol, source, accession, sequence, document_name, section, ordinal,
      accepted_at, tenant_scope, content_version, commit_id, receipt_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (const occurrence of occurrences) {
      insert.run(
        occurrence.vectorId,
        occurrence.contentHash,
        occurrence.symbol,
        occurrence.source,
        occurrence.accession,
        occurrence.sequence ?? null,
        occurrence.documentName ?? null,
        occurrence.section,
        occurrence.ordinal,
        occurrence.acceptedAt,
        occurrence.tenantScope,
        occurrence.contentVersion,
        occurrence.commitId,
        occurrence.receiptState,
        occurrence.createdAt
      );
    }
  })();
}

export function beginVectorCommit(input: BeginVectorCommitInput): BeginVectorCommitResult {
  const now = input.now ?? new Date().toISOString();
  const providerAuthority = input.providerAuthority?.trim() || null;
  const ledgerAuthority = input.ledgerAuthority?.trim() || null;
  const vectorNamespace = input.vectorNamespace ?? "managed";
  const database = getDb();
  return database.transaction((): BeginVectorCommitResult => {
    const orphanFence = database.prepare(`
      SELECT 1 AS ok FROM vector_reconcile_orphan_claims
      WHERE commit_id = ? AND lease_expires_at > ?
    `).get(input.id, now);
    if (orphanFence) return "busy";
    database.prepare(`
      DELETE FROM vector_reconcile_orphan_claims
      WHERE commit_id = ? AND lease_expires_at <= ?
    `).run(input.id, now);
    const existing = database.prepare(`
      SELECT state, tenant_scope, user_id, source, accession, document_key, content_version,
             retrieval_metadata_version, parser_revision, embed_revision,
             expected_vectors, provider_authority, ledger_authority, vector_namespace, lease_expires_at
      FROM vector_ingest_commits WHERE id = ?
    `).get(input.id) as {
      state: VectorCommitState;
      tenant_scope: string;
      user_id: string;
      source: string;
      accession: string;
      document_key: string;
      content_version: string;
      retrieval_metadata_version: string;
      parser_revision: string;
      embed_revision: string;
      expected_vectors: number;
      provider_authority: string | null;
      ledger_authority: string | null;
      vector_namespace: string;
      lease_expires_at?: string;
    } | undefined;
    if (existing) {
      const identityMatches =
        existing.tenant_scope === input.tenantScope &&
        existing.user_id === input.userId &&
        existing.source === input.source &&
        existing.accession === input.accession &&
        existing.document_key === input.documentKey &&
        existing.content_version === input.contentVersion &&
        existing.retrieval_metadata_version === input.retrievalMetadataVersion &&
        existing.parser_revision === input.parserRevision &&
        existing.embed_revision === input.embedRevision &&
        existing.expected_vectors === input.expectedVectors &&
        (existing.provider_authority?.trim() || null) === providerAuthority &&
        (existing.ledger_authority?.trim() || null) === ledgerAuthority &&
        existing.vector_namespace === vectorNamespace;
      if (!identityMatches) throw new Error("Vector commit identity mismatch.");
      // A deterministic replay must never make a proven generation disappear from retrieval. The
      // caller validates the exact committed occurrence set and reuses it without provider writes.
      if (existing.state === "committed") return "already_committed";
      if (
        existing.state !== "aborted" &&
        existing.lease_expires_at &&
        existing.lease_expires_at > now
      ) return "busy";
    }

    const claimed = database.prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, content_version,
        document_key, retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
        provider_authority, ledger_authority, vector_namespace, state,
        attempt_token, attempt_generation, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        expected_vectors = excluded.expected_vectors,
        attempt_token = excluded.attempt_token,
        attempt_generation = vector_ingest_commits.attempt_generation + 1,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at,
        committed_at = NULL,
        state = 'pending'
      WHERE vector_ingest_commits.state <> 'committed'
        AND (
          vector_ingest_commits.lease_expires_at IS NULL OR
          vector_ingest_commits.lease_expires_at <= excluded.updated_at
        )
    `).run(
      input.id,
      input.tenantScope,
      input.userId,
      input.source,
      input.accession,
      input.contentVersion,
      input.documentKey,
      input.retrievalMetadataVersion,
      input.parserRevision,
      input.embedRevision,
      input.expectedVectors,
      providerAuthority,
      ledgerAuthority,
      vectorNamespace,
      input.attemptToken,
      input.leaseExpiresAt,
      now,
      now
    );
    if (claimed.changes !== 1) return "busy";
    // A retryable pending/aborted generation returns its managed set to pending before replacing
    // provider metadata. A committed generation returned above and is never demoted here.
    database.prepare(`
      UPDATE chunk_occurrences SET receipt_state = 'pending'
      WHERE commit_id = ?
        AND EXISTS (
          SELECT 1 FROM vector_ingest_commits
          WHERE id = ? AND state <> 'committed' AND attempt_token = ?
        )
    `).run(input.id, input.id, input.attemptToken);
    return "started";
  })();
}

export function renewVectorCommitLease(
  commitId: string,
  attemptToken: string,
  leaseExpiresAt: string,
  now = new Date().toISOString()
): void {
  const result = getDb().prepare(`
    UPDATE vector_ingest_commits
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND attempt_token = ?
      AND state IN ('pending','receipts_persisted')
      AND lease_expires_at > ?
  `).run(leaseExpiresAt, now, commitId, attemptToken, now);
  if (result.changes === 1) return;
  const committed = getDb().prepare(`
    SELECT 1 AS ok FROM vector_ingest_commits
    WHERE id = ? AND attempt_token = ? AND state = 'committed'
  `).get(commitId, attemptToken);
  if (!committed) throw new Error("Vector commit attempt lease was lost.");
}

export function markVectorCommitReceiptsPersisted(
  commitId: string,
  attemptToken: string,
  now = new Date().toISOString()
): void {
  const result = getDb().prepare(`
    UPDATE vector_ingest_commits SET state = 'receipts_persisted', updated_at = ?
    WHERE id = ? AND attempt_token = ? AND state IN ('pending','receipts_persisted')
      AND lease_expires_at > ?
  `).run(now, commitId, attemptToken, now);
  if (result.changes !== 1) throw new Error("Vector commit receipt state was not persisted.");
}

function rebuildVectorDocumentTimeline(
  database: ReturnType<typeof getDb>,
  tenantScope: string,
  source: string,
  documentKey: string,
  now: string
): void {
  const versions = database.prepare(`
    SELECT v.commit_id, v.valid_from, c.committed_at
    FROM vector_document_versions v
    JOIN vector_ingest_commits c ON c.id = v.commit_id AND c.state = 'committed'
    WHERE v.tenant_scope = ? AND v.source = ? AND v.document_key = ?
    ORDER BY v.valid_from, c.committed_at, v.commit_id
  `).all(tenantScope, source, documentKey) as Array<{
    commit_id: string;
    valid_from: string;
    committed_at: string | null;
  }>;
  const update = database.prepare(`
    UPDATE vector_document_versions SET valid_to = ?, updated_at = ? WHERE commit_id = ?
  `);
  versions.forEach((version, index) => {
    update.run(versions[index + 1]?.valid_from ?? null, now, version.commit_id);
  });
  const active = versions.at(-1);
  if (!active) {
    database.prepare(`
      DELETE FROM vector_document_heads
      WHERE tenant_scope = ? AND source = ? AND accession = ?
    `).run(tenantScope, source, documentKey);
    return;
  }
  database.prepare(`
    INSERT INTO vector_document_heads (
      tenant_scope, source, accession, commit_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_scope, source, accession) DO UPDATE SET
      commit_id = excluded.commit_id,
      updated_at = excluded.updated_at
  `).run(tenantScope, source, documentKey, active.commit_id, now);
}

function finalizeVectorCommit(
  commitId: string,
  attemptToken: string,
  now: string,
  requireLiveLease: boolean
): void {
  const database = getDb();
  database.transaction(() => {
    const commit = database.prepare(`
      SELECT expected_vectors, tenant_scope, source, accession, document_key
      FROM vector_ingest_commits
      WHERE id = ? AND attempt_token = ? AND state = 'receipts_persisted'
        ${requireLiveLease
          ? "AND lease_expires_at > ?"
          : "AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"}
    `).get(commitId, attemptToken, now) as {
      expected_vectors: number;
      tenant_scope: string;
      source: string;
      accession: string;
      document_key: string;
    } | undefined;
    if (!commit) throw new Error("Vector commit has no durable receipt set.");
    const row = database.prepare(`
      SELECT COUNT(*) AS count FROM chunk_occurrences
      WHERE commit_id = ? AND receipt_state = 'pending'
    `).get(commitId) as { count: number };
    if (row.count !== commit.expected_vectors) throw new Error("Vector commit receipt cardinality mismatch.");
    database.prepare(`
      UPDATE chunk_occurrences SET receipt_state = 'committed'
      WHERE commit_id = ? AND receipt_state = 'pending'
    `).run(commitId);
    const committed = database.prepare(`
      UPDATE vector_ingest_commits
      SET state = 'committed', committed_at = COALESCE(committed_at, ?),
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND attempt_token = ? AND state = 'receipts_persisted'
    `).run(now, now, commitId, attemptToken);
    if (committed.changes !== 1) throw new Error("Vector commit finalization ownership was lost.");
    const receipt = database.prepare(`
      SELECT MIN(accepted_at) AS valid_from FROM chunk_occurrences WHERE commit_id = ?
    `).get(commitId) as { valid_from: string | null };
    const active = database.prepare(`
      SELECT v.commit_id, v.valid_from
      FROM vector_document_heads h
      JOIN vector_document_versions v ON v.commit_id = h.commit_id
      WHERE h.tenant_scope = ? AND h.source = ? AND h.accession = ?
    `).get(commit.tenant_scope, commit.source, commit.document_key) as {
      commit_id: string;
      valid_from: string;
    } | undefined;
    let validFrom = receipt.valid_from ?? now;
    // A newly proven correction must become active when it is finalized, even if its source
    // evidence predates the current head. Otherwise crash-reconciliation of an old receipt set
    // can silently roll current retrieval back to an obsolete version.
    if (active && active.commit_id !== commitId && validFrom <= active.valid_from) {
      validFrom = new Date(Math.max(
        Date.parse(now),
        Date.parse(active.valid_from) + 1
      )).toISOString();
    }
    database.prepare(`
      INSERT INTO vector_document_versions (
        commit_id, tenant_scope, source, document_key, valid_from, valid_to, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(commit_id) DO UPDATE SET
        valid_from = excluded.valid_from,
        updated_at = excluded.updated_at
    `).run(commitId, commit.tenant_scope, commit.source, commit.document_key, validFrom, now);
    rebuildVectorDocumentTimeline(
      database,
      commit.tenant_scope,
      commit.source,
      commit.document_key,
      now
    );
    database.prepare("DELETE FROM vector_reconcile_observations WHERE commit_id = ?").run(commitId);
  })();
}

export function markVectorCommitCommitted(
  commitId: string,
  attemptToken: string,
  now = new Date().toISOString()
): void {
  finalizeVectorCommit(commitId, attemptToken, now, true);
}

/** Finish an expired receipts-persisted attempt only after reconciliation proved the complete
 * provider set. The attempt token is still a CAS: a retry that already claimed the generation wins. */
export function reconcileVectorCommitCommitted(
  commitId: string,
  attemptToken: string,
  now = new Date().toISOString()
): void {
  finalizeVectorCommit(commitId, attemptToken, now, false);
}

/** Atomically fence provider reconciliation against a retry that may have claimed an expired
 * attempt after inventory began. The opaque reconciliation token becomes the only token retrieval
 * can trust before any provider metadata mutation or deletion occurs. */
export function claimVectorCommitForReconciliation(
  commitId: string,
  expectedAttemptToken: string,
  expectedState: VectorCommitState,
  expectedIsActive: boolean,
  reconciliationToken: string,
  leaseExpiresAt: string,
  now = new Date().toISOString()
): boolean {
  if (!reconciliationToken.startsWith("reconcile:")) {
    throw new Error("Invalid vector reconciliation token.");
  }
  const claimed = getDb().prepare(`
    UPDATE vector_ingest_commits
    SET attempt_token = ?, attempt_generation = attempt_generation + 1,
        lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND attempt_token = ?
      AND state = ?
      AND (
        (? = 1 AND EXISTS (
          SELECT 1 FROM vector_document_heads h
          WHERE h.commit_id = vector_ingest_commits.id
            AND h.tenant_scope = vector_ingest_commits.tenant_scope
            AND h.source = vector_ingest_commits.source
            AND h.accession = vector_ingest_commits.document_key
        )) OR
        (? = 0 AND NOT EXISTS (
          SELECT 1 FROM vector_document_heads h
          WHERE h.commit_id = vector_ingest_commits.id
            AND h.tenant_scope = vector_ingest_commits.tenant_scope
            AND h.source = vector_ingest_commits.source
            AND h.accession = vector_ingest_commits.document_key
        ))
      )
      AND (
        lease_expires_at IS NULL OR
        lease_expires_at <= ?
      )
  `).run(
    reconciliationToken,
    leaseExpiresAt,
    now,
    commitId,
    expectedAttemptToken,
    expectedState,
    expectedIsActive ? 1 : 0,
    expectedIsActive ? 1 : 0,
    now
  );
  return claimed.changes === 1;
}

/** Keep the reconciliation fence live across every external provider boundary. A caller that
 * cannot renew has lost ownership and must not perform another provider mutation. */
export function renewVectorCommitReconciliationLease(
  commitId: string,
  reconciliationToken: string,
  leaseExpiresAt: string,
  now = new Date().toISOString()
): void {
  if (!reconciliationToken.startsWith("reconcile:")) {
    throw new Error("Invalid vector reconciliation token.");
  }
  const renewed = getDb().prepare(`
    UPDATE vector_ingest_commits
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND attempt_token = ?
      AND state IN ('pending','receipts_persisted','committed','aborted')
      AND lease_expires_at > ?
  `).run(leaseExpiresAt, now, commitId, reconciliationToken, now);
  if (renewed.changes !== 1) throw new Error("Vector reconciliation lease was lost.");
}

export function completeVectorCommitReconciliation(
  commitId: string,
  reconciliationToken: string,
  now = new Date().toISOString()
): void {
  const database = getDb();
  database.transaction(() => {
    const completed = database.prepare(`
      UPDATE vector_ingest_commits
      SET lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND attempt_token = ? AND state = 'committed'
        AND attempt_token LIKE 'reconcile:%' AND lease_expires_at > ?
    `).run(now, commitId, reconciliationToken, now);
    if (completed.changes !== 1) throw new Error("Vector reconciliation completion ownership was lost.");
    database.prepare("DELETE FROM vector_reconcile_observations WHERE commit_id = ?").run(commitId);
  })();
}

export interface VectorReconcileObservation {
  fingerprint: string;
  observationCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

/** Record one complete provider-inventory anomaly. A changed anomaly resets confirmation instead
 * of accumulating unrelated partial scans toward an active-head invalidation. */
export function recordVectorReconcileObservation(
  commitId: string,
  fingerprint: string,
  now = new Date().toISOString()
): VectorReconcileObservation {
  const database = getDb();
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO vector_reconcile_observations (
        commit_id, fingerprint, observation_count, first_observed_at, last_observed_at
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(commit_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        observation_count = CASE
          WHEN vector_reconcile_observations.fingerprint = excluded.fingerprint
            THEN vector_reconcile_observations.observation_count + 1
          ELSE 1
        END,
        first_observed_at = CASE
          WHEN vector_reconcile_observations.fingerprint = excluded.fingerprint
            THEN vector_reconcile_observations.first_observed_at
          ELSE excluded.first_observed_at
        END,
        last_observed_at = excluded.last_observed_at
    `).run(commitId, fingerprint, now, now);
    const row = database.prepare(`
      SELECT fingerprint, observation_count, first_observed_at, last_observed_at
      FROM vector_reconcile_observations WHERE commit_id = ?
    `).get(commitId) as {
      fingerprint: string;
      observation_count: number;
      first_observed_at: string;
      last_observed_at: string;
    };
    return {
      fingerprint: row.fingerprint,
      observationCount: row.observation_count,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at
    };
  })();
}

export function clearVectorReconcileObservation(commitId: string): void {
  getDb().prepare("DELETE FROM vector_reconcile_observations WHERE commit_id = ?").run(commitId);
}

/** Fence deletion of a provider row whose claimed commit does not exist locally. `beginVectorCommit`
 * checks the same table transactionally, so an ingest cannot begin between inventory and delete. */
export function claimVectorReconcileOrphan(
  commitId: string,
  claimToken: string,
  leaseExpiresAt: string,
  now = new Date().toISOString()
): boolean {
  if (!commitId || !claimToken.startsWith("orphan-reconcile:")) return false;
  const database = getDb();
  return database.transaction(() => {
    const commitExists = database.prepare(
      "SELECT 1 AS ok FROM vector_ingest_commits WHERE id = ?"
    ).get(commitId);
    if (commitExists) return false;
    const claimed = database.prepare(`
      INSERT INTO vector_reconcile_orphan_claims (
        commit_id, claim_token, lease_expires_at, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(commit_id) DO UPDATE SET
        claim_token = excluded.claim_token,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE vector_reconcile_orphan_claims.lease_expires_at <= excluded.updated_at
    `).run(commitId, claimToken, leaseExpiresAt, now);
    return claimed.changes === 1;
  })();
}

export function renewVectorReconcileOrphanLease(
  commitId: string,
  claimToken: string,
  leaseExpiresAt: string,
  now = new Date().toISOString()
): void {
  const renewed = getDb().prepare(`
    UPDATE vector_reconcile_orphan_claims
    SET lease_expires_at = ?, updated_at = ?
    WHERE commit_id = ? AND claim_token = ? AND lease_expires_at > ?
  `).run(leaseExpiresAt, now, commitId, claimToken, now);
  if (renewed.changes !== 1) throw new Error("Vector orphan reconciliation lease was lost.");
}

export function releaseVectorReconcileOrphan(commitId: string, claimToken: string): void {
  const released = getDb().prepare(`
    DELETE FROM vector_reconcile_orphan_claims
    WHERE commit_id = ? AND claim_token = ?
  `).run(commitId, claimToken);
  if (released.changes !== 1) throw new Error("Vector orphan reconciliation ownership was lost.");
}

/** Provider inventory disproved a locally active generation. Remove the active head and return the
 * deterministic commit to a retryable state only if the inspected attempt is still current. */
export function invalidateVectorCommitForReconciliation(
  commitId: string,
  attemptToken: string,
  now = new Date().toISOString()
): void {
  const database = getDb();
  database.transaction(() => {
    const commit = database.prepare(`
      SELECT tenant_scope, source, accession, document_key FROM vector_ingest_commits
      WHERE id = ? AND attempt_token = ?
    `).get(commitId, attemptToken) as {
      tenant_scope: string;
      source: string;
      accession: string;
      document_key: string;
    } | undefined;
    if (!commit) throw new Error("Vector commit reconciliation target was not found.");
    const invalidated = database.prepare(`
      UPDATE vector_ingest_commits
      SET state = 'aborted', lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND attempt_token = ?
        AND state IN ('pending','receipts_persisted','committed','aborted')
        AND attempt_token LIKE 'reconcile:%'
        AND lease_expires_at > ?
    `).run(now, commitId, attemptToken, now);
    if (invalidated.changes !== 1) throw new Error("Vector commit reconciliation ownership was lost.");
    database.prepare(`
      UPDATE chunk_occurrences SET receipt_state = 'pending'
      WHERE commit_id = ?
    `).run(commitId);
    const deletedHead = database.prepare(`
      DELETE FROM vector_document_heads WHERE commit_id = ?
    `).run(commitId);
    database.prepare("DELETE FROM vector_document_versions WHERE commit_id = ?").run(commitId);
    rebuildVectorDocumentTimeline(
      database,
      commit.tenant_scope,
      commit.source,
      commit.document_key,
      now
    );
    database.prepare("DELETE FROM vector_reconcile_observations WHERE commit_id = ?").run(commitId);

    // Reopen the owning source ledger in the same transaction as head invalidation. Otherwise a
    // crash between those writes could leave a permanently suppressed document with no queryable
    // vector generation.
    if (commit.source === "fmp-earnings-transcript") {
      database.prepare(`
        UPDATE fmp_transcript_versions
        SET state = 'failed', vector_commit_id = NULL, updated_at = ?
        WHERE version_id = ?
          AND (vector_commit_id = ? OR vector_commit_id IS NULL)
      `).run(now, commit.accession, commitId);
      const marker = commit.accession.indexOf(":VERSION:");
      if (deletedHead.changes === 1 && marker > 0) {
        database.prepare(`
          DELETE FROM ingested_accessions
          WHERE accession = ? AND doc_type = 'earnings-transcript'
        `).run(commit.accession.slice(0, marker));
      }
    } else if (deletedHead.changes === 1 && commit.source === "sec-8k") {
      database.prepare(`
        DELETE FROM ingested_accessions WHERE accession = ? AND doc_type = '8-K-body'
      `).run(commit.accession);
      database.prepare(`
        UPDATE sec_filings
        SET status = 'discovered', chunk_count = 0, updated_at = ?
        WHERE accession = ? AND form IN ('8-K','8-K-body')
      `).run(now, commit.accession);
    } else if (deletedHead.changes === 1 && commit.source === "sec-edgar") {
      const match = /^[^:]+:(\d{10}-\d{2}-\d{6}):(10-K|10-Q)$/.exec(commit.accession);
      if (match) {
        database.prepare(`
          DELETE FROM ingested_accessions WHERE accession = ? AND doc_type = ?
        `).run(match[1], match[2]);
        database.prepare(`
          UPDATE sec_filings
          SET status = 'discovered', chunk_count = 0, updated_at = ?
          WHERE accession = ? AND form = ?
        `).run(now, match[1], match[2]);
      }
    }
  })();
}

export function abortVectorCommit(
  commitId: string,
  attemptToken: string,
  now = new Date().toISOString()
): void {
  getDb().prepare(`
    UPDATE vector_ingest_commits
    SET state = 'aborted', lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND attempt_token = ? AND state <> 'committed'
  `).run(now, commitId, attemptToken);
}

// Stay below SQLite's portable 999-variable ceiling, including the two optional as-of binds.
// A retrieval can legally combine six provider tiers of up to 10,000 candidates each.
const MANAGED_RECEIPT_LOOKUP_BATCH_SIZE = 900;

interface CommittedManagedVectorReceiptRow {
  vector_id: string;
  commit_id: string;
  content_version: string;
  tenant_scope: string;
  content_hash: string;
  symbol: string;
  source: string;
  accession: string;
  document_key: string;
  section: string;
  ordinal: number;
  parser_revision: string;
  embed_revision: string;
  retrieval_metadata_version: string;
  attempt_token: string;
  provider_authority: string | null;
  ledger_authority: string | null;
  vector_namespace: "managed" | "fmp-transcripts";
}

export function committedManagedVectorReceipts(vectorIds: string[], asOf?: string): Map<string, {
  commitId: string;
  contentVersion: string;
  tenantScope: string;
  contentHash: string;
  symbol: string;
  source: string;
  accession: string;
  documentKey: string;
  section: string;
  ordinal: number;
  parserRevision: string;
  embedRevision: string;
  retrievalMetadataVersion: string;
  attemptToken: string;
  providerAuthority?: string;
  ledgerAuthority?: string;
  vectorNamespace: "managed" | "fmp-transcripts";
}> {
  const unique = [...new Set(vectorIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const parsedAsOf = asOf && Number.isFinite(Date.parse(asOf))
    ? new Date(asOf).toISOString()
    : undefined;
  const database = getDb();
  const rows: CommittedManagedVectorReceiptRow[] = [];
  for (let offset = 0; offset < unique.length; offset += MANAGED_RECEIPT_LOOKUP_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + MANAGED_RECEIPT_LOOKUP_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    rows.push(...database.prepare(`
      SELECT o.vector_id, o.commit_id, o.content_version, o.tenant_scope,
             o.content_hash, o.symbol, o.source, o.accession, o.section, o.ordinal,
             c.document_key, c.parser_revision, c.embed_revision,
             c.retrieval_metadata_version, c.attempt_token, c.provider_authority,
             c.ledger_authority, c.vector_namespace
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      ${parsedAsOf
        ? `JOIN vector_document_versions v
            ON v.commit_id = c.id
            AND v.tenant_scope = c.tenant_scope
            AND v.source = c.source
            AND v.document_key = c.document_key
            AND v.valid_from <= ?
            AND (v.valid_to IS NULL OR v.valid_to > ?)`
        : `JOIN vector_document_heads h
            ON h.commit_id = c.id
            AND h.tenant_scope = c.tenant_scope
            AND h.source = c.source
            AND h.accession = c.document_key`}
      WHERE o.vector_id IN (${placeholders})
        AND o.receipt_state = 'committed' AND c.state = 'committed'
        AND c.lease_expires_at IS NULL
        AND o.tenant_scope = c.tenant_scope AND o.content_version = c.content_version
    `).all(...(parsedAsOf ? [parsedAsOf, parsedAsOf, ...batch] : batch)) as CommittedManagedVectorReceiptRow[]);
  }
  return new Map(rows.map((row) => [row.vector_id, {
    commitId: row.commit_id,
    contentVersion: row.content_version,
    tenantScope: row.tenant_scope,
    contentHash: row.content_hash,
    symbol: row.symbol,
    source: row.source,
    accession: row.accession,
    documentKey: row.document_key,
    section: row.section,
    ordinal: row.ordinal,
    parserRevision: row.parser_revision,
    embedRevision: row.embed_revision,
    retrievalMetadataVersion: row.retrieval_metadata_version,
    attemptToken: row.attempt_token,
    ...(row.provider_authority?.trim() ? { providerAuthority: row.provider_authority } : {}),
    ...(row.ledger_authority?.trim() ? { ledgerAuthority: row.ledger_authority } : {}),
    vectorNamespace: row.vector_namespace
  }]));
}

/**
 * Resolve the provider authority from durable committed vector records.
 * Used when in-memory provider authority cache is uninitialized (e.g. Qdrant read backend without Pinecone).
 */
export function durableProviderAuthority(ledgerAuthority?: string): string | undefined {
  const database = getDb();
  if (ledgerAuthority) {
    const row = database
      .prepare(
        `SELECT provider_authority FROM vector_ingest_commits
         WHERE ledger_authority = ? AND provider_authority IS NOT NULL AND TRIM(provider_authority) != '' AND state = 'committed'
         ORDER BY committed_at DESC LIMIT 1`
      )
      .get(ledgerAuthority) as { provider_authority: string } | undefined;
    if (row?.provider_authority?.trim()) return row.provider_authority.trim();
  }
  const fallback = database
    .prepare(
      `SELECT provider_authority FROM vector_ingest_commits
       WHERE provider_authority IS NOT NULL AND TRIM(provider_authority) != '' AND state = 'committed'
       ORDER BY committed_at DESC LIMIT 1`
    )
    .get() as { provider_authority: string } | undefined;
  return fallback?.provider_authority?.trim() || undefined;
}

export interface PendingVectorCommit {
  id: string;
  state: VectorCommitState;
  source: string;
  accession: string;
  contentVersion: string;
  vectorIds: string[];
}

export function listPendingVectorCommits(limit = 100): PendingVectorCommit[] {
  const rows = getDb().prepare(`
    SELECT id, state, source, accession, content_version
    FROM vector_ingest_commits
    WHERE state IN ('pending','receipts_persisted','aborted')
    ORDER BY updated_at, id LIMIT ?
  `).all(Math.max(1, Math.min(1_000, Math.floor(limit)))) as Array<{
    id: string;
    state: VectorCommitState;
    source: string;
    accession: string;
    content_version: string;
  }>;
  const vectorRows = getDb().prepare(`
    SELECT vector_id FROM chunk_occurrences WHERE commit_id = ? ORDER BY vector_id
  `);
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    source: row.source,
    accession: row.accession,
    contentVersion: row.content_version,
    vectorIds: (vectorRows.all(row.id) as Array<{ vector_id: string }>).map((item) => item.vector_id)
  }));
}

export interface FmpTranscriptVersionRow {
  versionId: string;
  accession: string;
  contentSha256: string;
  symbol: string;
  year: number;
  quarter: number;
  callDate?: string;
  firstContentSeenAt: string;
  state: "observed" | "indexing" | "committed" | "failed";
  vectorCommitId?: string;
  chunkCount: number;
}

function mapVersion(row: Record<string, unknown>): FmpTranscriptVersionRow {
  return {
    versionId: String(row.version_id),
    accession: String(row.accession),
    contentSha256: String(row.content_sha256),
    symbol: String(row.symbol),
    year: Number(row.fiscal_year),
    quarter: Number(row.fiscal_quarter),
    ...(row.call_date ? { callDate: String(row.call_date) } : {}),
    firstContentSeenAt: String(row.first_content_seen_at),
    state: row.state as FmpTranscriptVersionRow["state"],
    ...(row.vector_commit_id ? { vectorCommitId: String(row.vector_commit_id) } : {}),
    chunkCount: Number(row.chunk_count)
  };
}

export function observeFmpTranscriptVersion(input: {
  versionId: string;
  accession: string;
  contentSha256: string;
  symbol: string;
  year: number;
  quarter: number;
  callDate?: string;
  observedAt: string;
}): FmpTranscriptVersionRow {
  const database = getDb();
  database.prepare(`
    INSERT INTO fmp_transcript_versions (
      version_id, accession, content_sha256, symbol, fiscal_year, fiscal_quarter,
      call_date, first_content_seen_at, state, observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?)
    ON CONFLICT(accession, content_sha256) DO UPDATE SET
      call_date = COALESCE(excluded.call_date, fmp_transcript_versions.call_date),
      updated_at = excluded.updated_at
  `).run(
    input.versionId,
    input.accession,
    input.contentSha256,
    input.symbol,
    input.year,
    input.quarter,
    input.callDate ?? null,
    input.observedAt,
    input.observedAt,
    input.observedAt
  );
  const row = database.prepare(`
    SELECT * FROM fmp_transcript_versions WHERE accession = ? AND content_sha256 = ?
  `).get(input.accession, input.contentSha256) as Record<string, unknown>;
  return mapVersion(row);
}

export function setFmpTranscriptVersionState(
  versionId: string,
  state: FmpTranscriptVersionRow["state"],
  input: { vectorCommitId?: string; chunkCount?: number; at?: string } = {}
): void {
  const at = input.at ?? new Date().toISOString();
  getDb().prepare(`
    UPDATE fmp_transcript_versions
    SET state = CASE
          WHEN state = 'committed' AND ? != 'committed' THEN state
          ELSE ?
        END,
        vector_commit_id = COALESCE(?, vector_commit_id),
        chunk_count = COALESCE(?, chunk_count),
        indexed_at = CASE WHEN ? = 'committed' THEN COALESCE(indexed_at, ?) ELSE indexed_at END,
        updated_at = ?
    WHERE version_id = ?
  `).run(
    state,
    state,
    input.vectorCommitId ?? null,
    input.chunkCount ?? null,
    state,
    at,
    at,
    versionId
  );
}

export function getFmpTranscriptVersion(accession: string, contentSha256: string): FmpTranscriptVersionRow | undefined {
  const row = getDb().prepare(`
    SELECT * FROM fmp_transcript_versions WHERE accession = ? AND content_sha256 = ?
  `).get(accession, contentSha256) as Record<string, unknown> | undefined;
  return row ? mapVersion(row) : undefined;
}
