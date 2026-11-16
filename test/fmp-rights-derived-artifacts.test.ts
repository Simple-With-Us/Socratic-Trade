import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const vectorMocks = vi.hoisted(() => ({
  getCurrentVectorProviderAuthority: vi.fn(async () => "provider:test"),
  managedVectorLedgerAuthority: vi.fn(() => "ledger:test"),
  vectorTenantScope: vi.fn(() => "shared:operator"),
  managedOccurrenceVectorPrefix: vi.fn(() => "occ:v3:test:"),
  managedOccurrenceVectorIdMatches: vi.fn(() => false),
  managedVectorReceiptEvidence: vi.fn(() => []),
  inventoryVectorRecordsByMetadata: vi.fn(async () => []),
  fetchExistingVectorRecordIds: vi.fn(async (_options?: unknown): Promise<string[]> => []),
  purgeVectorRecordsByMetadata: vi.fn(async () => ({ ids: [], deleted: 0 })),
  purgeVectorRecordIds: vi.fn(async ({ ids }: { ids: string[] }) => ({ ids, deleted: ids.length })),
  purgeVectorNamespaceAll: vi.fn(async () => undefined)
}));

vi.mock("../src/lib/vector-db", () => ({
  ...vectorMocks
}));

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-fmp-rights-derived-${randomUUID()}.db`)}`;
  process.env.WEB_SOURCE_FMP_TRANSCRIPTS = "off";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 120_000);

beforeEach(async () => {
  vi.clearAllMocks();
  vectorMocks.getCurrentVectorProviderAuthority.mockResolvedValue("provider:test");
  vectorMocks.managedVectorLedgerAuthority.mockReturnValue("ledger:test");
  vectorMocks.fetchExistingVectorRecordIds.mockResolvedValue([]);
  vectorMocks.purgeVectorRecordIds.mockImplementation(async ({ ids }: { ids: string[] }) => ({
    ids,
    deleted: ids.length
  }));
  vectorMocks.purgeVectorNamespaceAll.mockResolvedValue(undefined);
  process.env.WEB_SOURCE_FMP_TRANSCRIPTS = "off";
  process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "on";
  process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS = "1";
  process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN = "1";
  process.env.VECTOR_ERASURE_VERIFY_DELAY_MS = "0";
  const {
    activateFmpTranscriptRightsGeneration,
    captureFmpTranscriptRightsGeneration
  } = await import("../src/lib/web-sources/fmp-transcripts");
  const { getDb } = await import("../src/lib/db");
  const database = getDb();
  activateFmpTranscriptRightsGeneration();
  expect(captureFmpTranscriptRightsGeneration()).toBeDefined();
  database.prepare("DELETE FROM fmp_transcript_derived_provider_work").run();
  database.prepare("DELETE FROM fmp_transcript_derived_artifacts").run();
  database.prepare("DELETE FROM chat_turns WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM audit_events WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM socratic_decisions WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM socratic_framework_proposals WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM trade_proposals WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM provider_usage_outbox WHERE attempt_id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM provider_dispatch_attempts WHERE id LIKE 'fmp-rights-test:%'").run();
  database.prepare("DELETE FROM settings WHERE key = 'operation_lease:rag-reindex'").run();
});

describe("FMP rights-derived artifact gate", () => {
  it("requires storage/display rights OFF even when ingestion itself is already OFF", async () => {
    const { purgeFmpTranscriptRightsArtifacts } = await import("../src/lib/web-sources/fmp-transcripts");

    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("Withdraw FMP transcript storage/display rights");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
  });

  it("atomically inventories and removes exact chat, prompt-audit, and decision provenance", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts,
      recordFmpTranscriptDerivedAudit
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    const database = getDb();
    const claim = captureFmpTranscriptRightsGeneration()!;
    const provenance = fmpTranscriptDerivedProvenance([{
      source: "fmp-earnings-transcript",
      docType: "earnings-transcript",
      chunkId: "occ:v3:fmp:test"
    }]);
    const chatId = "fmp-rights-test:chat-derived";
    const retainedChatId = "fmp-rights-test:chat-retained";
    const decisionId = "fmp-rights-test:decision";
    const frameworkId = "fmp-rights-test:framework";
    const at = new Date().toISOString();

    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "chat-turn",
      artifactId: chatId,
      userId: "local",
      provenance,
      write: () => database.prepare(`
        INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, model, client_turn_id, created_at)
        VALUES (?, 'local', 'assistant', ?, '[]', NULL, 0, 'test', NULL, ?)
      `).run(chatId, "Derived answer with no verbatim source payload in its provenance ledger.", at)
    });
    database.prepare(`
      INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, model, client_turn_id, created_at)
      VALUES (?, 'local', 'assistant', ?, '[]', NULL, 0, 'test', NULL, ?)
    `).run(retainedChatId, "Literal earnings-transcript text alone is not provenance.", at);

    const promptAuditId = recordFmpTranscriptDerivedAudit({
      claim,
      kind: "prompt_injection_suspected",
      payload: { runId: "fmp-rights-test:run", findings: [{ excerpt: "licensed raw excerpt" }] },
      userId: "local",
      provenance
    });

    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: decisionId,
      userId: "local",
      provenance,
      write: () => {
        database.prepare(`
          INSERT INTO socratic_decisions (
            id, user_id, status, authority, thesis, rationale, action,
            evidence, rag_attributions, created_at, updated_at
          ) VALUES (?, 'local', 'observed', 'system', 'test', 'test', 'hold', ?, ?, ?, ?)
        `).run(
          decisionId,
          JSON.stringify([{
            kind: "safety",
            source: "prompt-safety",
            summary: "licensed raw excerpt",
            data: { fmpProvenance: provenance }
          }, { kind: "policy", source: "policy", summary: "retain me" }]),
          JSON.stringify([...provenance, { source: "sec-edgar", docType: "10-q", chunkId: "sec:keep" }]),
          at,
          at
        );
        database.prepare(`
          INSERT INTO socratic_framework_proposals (
            id, user_id, decision_id, status, priority, subsystem, title, rationale,
            proposed_change, evidence, created_at, updated_at
          ) VALUES (?, 'local', ?, 'proposed', 'medium', 'strategy', 'derived', 'derived', 'derived', '[]', ?, ?)
        `).run(frameworkId, decisionId, at, at);
      }
    });

    const before = await inventoryFmpTranscriptRightsArtifacts();
    expect(before).toMatchObject({
      derivedChatTurnIds: [chatId],
      derivedPromptSafetyAuditIds: [promptAuditId],
      derivedDecisionIds: [decisionId],
      derivedFrameworkProposalIds: [frameworkId],
      pendingDerivedProviderWorkIds: [],
      pendingPineconeUpsertAttemptIds: []
    });

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after).toMatchObject({
      derivedAuditIds: [],
      derivedPromptSafetyAuditIds: [],
      derivedChatTurnIds: [],
      derivedDecisionIds: [],
      derivedFrameworkProposalIds: [],
      derivedArtifactIds: [],
      rightsGate: { status: "revoked" }
    });
    expect(database.prepare("SELECT 1 FROM chat_turns WHERE id = ?").get(chatId)).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM chat_turns WHERE id = ?").get(retainedChatId)).toBeDefined();
    expect(database.prepare("SELECT 1 FROM audit_events WHERE id = ?").get(promptAuditId)).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM socratic_framework_proposals WHERE id = ?").get(frameworkId)).toBeUndefined();
    const decision = database.prepare(`
      SELECT evidence, rag_attributions FROM socratic_decisions WHERE id = ?
    `).get(decisionId) as { evidence: string; rag_attributions: string };
    expect(decision.evidence).not.toContain("licensed raw excerpt");
    expect(JSON.parse(decision.evidence)).toEqual([{ kind: "policy", source: "policy", summary: "retain me" }]);
    expect(JSON.parse(decision.rag_attributions)).toEqual([{ source: "sec-edgar", docType: "10-q", chunkId: "sec:keep" }]);

    let staleWriteRan = false;
    expect(() => persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "chat-turn",
      artifactId: "fmp-rights-test:stale-chat",
      userId: "local",
      provenance,
      write: () => {
        staleWriteRan = true;
      }
    })).toThrow("rights generation is revoked or stale");
    expect(staleWriteRan).toBe(false);
    expect(captureFmpTranscriptRightsGeneration()).toBeUndefined();
  });

  it("revokes first and blocks until derived provider work has a terminal receipt", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      completeFmpTranscriptDerivedProviderWork,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const claim = captureFmpTranscriptRightsGeneration()!;
    const provenance = fmpTranscriptDerivedProvenance([{
      source: "fmp-earnings-transcript",
      docType: "earnings-transcript",
      chunkId: "occ:v3:fmp:provider-work"
    }]);
    const workId = "fmp-rights-test:provider-work";
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:provider-work-decision",
      userId: "local",
      provenance,
      providerWorkId: workId,
      providerVectorId: "fmp-derived-socratic:v1:provider-work",
      providerAuthority: "provider:test",
      ledgerAuthority: "ledger:test",
      write: () => undefined
    });

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("unresolved derived provider work");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    const blocked = await inventoryFmpTranscriptRightsArtifacts();
    expect(blocked.rightsGate.status).toBe("revoked");
    expect(blocked.pendingDerivedProviderWorkIds).toEqual([workId]);

    completeFmpTranscriptDerivedProviderWork(workId);
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.pendingDerivedProviderWorkIds).toEqual([]);
    expect(vectorMocks.purgeVectorNamespaceAll).toHaveBeenCalledTimes(1);
  });

  it("does not invent a private provider-vector obligation for a settled no-write reservation", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      completeFmpTranscriptDerivedProviderWork,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const workId = "fmp-rights-test:no-provider-write";
    const claim = captureFmpTranscriptRightsGeneration()!;
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:no-provider-write-decision",
      userId: "local",
      provenance: fmpTranscriptDerivedProvenance([{
        source: "fmp-earnings-transcript",
        docType: "earnings-transcript",
        chunkId: "occ:v3:fmp:no-provider-write"
      }]),
      providerWorkId: workId,
      providerVectorId: "fmp-derived-socratic:v1:no-provider-write",
      providerAuthority: "provider:test",
      ledgerAuthority: "ledger:test",
      write: () => undefined
    });
    completeFmpTranscriptDerivedProviderWork(workId, "no_provider_write");

    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    expect(inventory.providerPrivateVectorRefs).toEqual([]);
    expect(inventory.authorityBlockers).not.toContain("derived-private-provider-authority-unreachable");
    expect(vectorMocks.fetchExistingVectorRecordIds).not.toHaveBeenCalled();

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.derivedArtifactIds).toEqual([]);
    expect(vectorMocks.purgeVectorRecordIds).not.toHaveBeenCalledWith(expect.objectContaining({
      namespace: "private"
    }));
  });

  it("purges an exact private vector after a remote write may have succeeded before timeout", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      completeFmpTranscriptDerivedProviderWork,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    const workId = "fmp-rights-test:provider-write-unknown";
    const providerVectorId = "fmp-derived-socratic:v1:provider-write-unknown";
    const derivedContentHash = "fmp-rights-test-derived-content-hash";
    const claim = captureFmpTranscriptRightsGeneration()!;
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:provider-write-unknown-decision",
      userId: "local",
      provenance: fmpTranscriptDerivedProvenance([{
        source: "fmp-earnings-transcript",
        docType: "earnings-transcript",
        chunkId: "occ:v3:fmp:provider-write-unknown"
      }]),
      providerWorkId: workId,
      providerVectorId,
      providerAuthority: "provider:test",
      ledgerAuthority: "ledger:test",
      write: () => undefined
    });
    completeFmpTranscriptDerivedProviderWork(workId, "provider_write_unknown");
    getDb().prepare(`
      INSERT INTO document_chunks (content_hash, symbol, source, chunk_id, created_at)
      VALUES (?, 'AAPL', 'socratic-decision:socratic-memory', ?, ?)
    `).run(derivedContentHash, providerVectorId, new Date().toISOString());
    vectorMocks.fetchExistingVectorRecordIds
      .mockResolvedValueOnce([providerVectorId])
      .mockResolvedValueOnce([providerVectorId])
      .mockResolvedValueOnce([]);

    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    expect(inventory.contentHashes).toContain(derivedContentHash);
    expect(inventory.providerPrivateVectorRefs).toEqual([{
      userId: "local",
      vectorId: providerVectorId,
      providerAuthority: "provider:test",
      ledgerAuthority: "ledger:test"
    }]);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.providerPrivateVectorRefs).toEqual([]);
    expect(getDb().prepare("SELECT 1 AS ok FROM document_chunks WHERE content_hash = ?").get(derivedContentHash))
      .toBeUndefined();
    expect(vectorMocks.purgeVectorRecordIds).toHaveBeenCalledWith(expect.objectContaining({
      userId: "local",
      namespace: "private",
      ids: [providerVectorId],
      expectedProviderAuthority: "provider:test",
      ledgerAuthority: "ledger:test"
    }));
  });

  it("expires crash-abandoned derived provider work after its durable lease", async () => {
    const {
      assertFmpTranscriptDerivedProviderWorkOwnership,
      captureFmpTranscriptRightsGeneration,
      fmpTranscriptDerivedProvenance,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    const claim = captureFmpTranscriptRightsGeneration()!;
    const workId = "fmp-rights-test:abandoned-provider-work";
    const providerVectorId = "fmp-derived-socratic:v1:abandoned-provider-work";
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:abandoned-provider-work-decision",
      userId: "local",
      provenance: fmpTranscriptDerivedProvenance([{
        source: "fmp-earnings-transcript",
        docType: "earnings-transcript",
        chunkId: "occ:v3:fmp:abandoned-provider-work"
      }]),
      providerWorkId: workId,
      providerVectorId,
      providerAuthority: "provider:test",
      ledgerAuthority: "ledger:test",
      write: () => undefined
    });
    assertFmpTranscriptDerivedProviderWorkOwnership(workId, claim);
    vectorMocks.fetchExistingVectorRecordIds
      .mockResolvedValueOnce([providerVectorId])
      .mockResolvedValueOnce([]);
    getDb().prepare(`
      UPDATE fmp_transcript_derived_provider_work
      SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(workId);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.pendingDerivedProviderWorkIds).toEqual([]);
    expect(vectorMocks.purgeVectorNamespaceAll).toHaveBeenCalledTimes(1);
    expect(vectorMocks.purgeVectorRecordIds).toHaveBeenCalledWith(expect.objectContaining({
      userId: "local",
      namespace: "private",
      ids: [providerVectorId]
    }));
    expect(() => assertFmpTranscriptDerivedProviderWorkOwnership(workId, claim))
      .toThrow("rights generation is revoked or stale");
  });

  it("blocks local receipt deletion when the recorded private-vector authority is no longer reachable", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      completeFmpTranscriptDerivedProviderWork,
      fmpTranscriptDerivedProvenance,
      inventoryFmpTranscriptRightsArtifacts,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    const workId = "fmp-rights-test:rotated-private-authority";
    const claim = captureFmpTranscriptRightsGeneration()!;
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:rotated-private-authority-decision",
      userId: "local",
      provenance: fmpTranscriptDerivedProvenance([{
        source: "fmp-earnings-transcript",
        docType: "earnings-transcript",
        chunkId: "occ:v3:fmp:rotated-private-authority"
      }]),
      providerWorkId: workId,
      providerVectorId: "fmp-derived-socratic:v1:rotated-private-authority",
      providerAuthority: "provider:historical",
      ledgerAuthority: "ledger:test",
      write: () => undefined
    });
    completeFmpTranscriptDerivedProviderWork(workId);
    vectorMocks.getCurrentVectorProviderAuthority.mockResolvedValue("provider:current");
    vectorMocks.fetchExistingVectorRecordIds.mockRejectedValue(
      new Error("Exact vector verification provider authority mismatch.")
    );

    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    expect(inventory.authorityBlockers).toContain("derived-private-provider-authority-unreachable");
    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("unreachable historical authority");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    expect(getDb().prepare(`
      SELECT 1 AS ok FROM fmp_transcript_derived_provider_work WHERE id = ?
    `).get(workId)).toBeDefined();
  });

  it("requires consecutive clean provider observations before deleting durable receipts", async () => {
    const {
      captureFmpTranscriptRightsGeneration,
      completeFmpTranscriptDerivedProviderWork,
      fmpTranscriptDerivedProvenance,
      persistFmpTranscriptDerivedArtifact,
      purgeFmpTranscriptRightsArtifacts
    } = await import("../src/lib/web-sources/fmp-transcripts");
    const { getDb } = await import("../src/lib/db");
    const workId = "fmp-rights-test:eventual-consistency";
    const providerVectorId = "fmp-derived-socratic:v1:eventual-consistency";
    const claim = captureFmpTranscriptRightsGeneration()!;
    persistFmpTranscriptDerivedArtifact({
      claim,
      artifactType: "strategy-decision",
      artifactId: "fmp-rights-test:eventual-consistency-decision",
      userId: "local",
      provenance: fmpTranscriptDerivedProvenance([{
        source: "fmp-earnings-transcript",
        docType: "earnings-transcript",
        chunkId: "occ:v3:fmp:eventual-consistency"
      }]),
      providerWorkId: workId,
      providerVectorId,
      providerAuthority: "provider:test",
      ledgerAuthority: "ledger:test",
      write: () => undefined
    });
    completeFmpTranscriptDerivedProviderWork(workId);
    process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS = "3";
    process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN = "2";
    vectorMocks.fetchExistingVectorRecordIds
      .mockResolvedValueOnce([providerVectorId])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([providerVectorId])
      .mockResolvedValueOnce([]);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow(/stability verification failed.*1\/2 consecutive clean/i);
    expect(getDb().prepare(`
      SELECT 1 AS ok FROM fmp_transcript_derived_provider_work WHERE id = ?
    `).get(workId)).toBeDefined();
    expect(vectorMocks.purgeVectorRecordIds).toHaveBeenCalledWith(expect.objectContaining({
      expectedProviderAuthority: "provider:test",
      ledgerAuthority: "ledger:test",
      ids: [providerVectorId]
    }));
  });

  it("does not let unrelated Pinecone upserts block transcript rights erasure", async () => {
    const { inventoryFmpTranscriptRightsArtifacts, purgeFmpTranscriptRightsArtifacts } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");
    const database = getDb();
    const attemptId = "fmp-rights-test:pinecone-upsert";
    const at = new Date().toISOString();
    database.prepare(`
      INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, created_at, dispatched_at, updated_at
      ) VALUES (?, 'test', 'pinecone', 'upsert', 'test', 'local', 1, 0, 'dispatched', ?, ?, ?)
    `).run(attemptId, at, at, at);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.before.pendingPineconeUpsertAttemptIds).toEqual([]);
    expect(purged.after.pendingPineconeUpsertAttemptIds).toEqual([]);
    expect(vectorMocks.purgeVectorNamespaceAll).toHaveBeenCalledTimes(1);
    const inventory = await inventoryFmpTranscriptRightsArtifacts();
    expect(inventory.pendingPineconeUpsertAttemptIds).toEqual([]);

    database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?
    `).run(at, at, attemptId);
  });

  it("blocks provider deletion while a transcript-associated Pinecone upsert is unresolved", async () => {
    const { inventoryFmpTranscriptRightsArtifacts, purgeFmpTranscriptRightsArtifacts } = await import(
      "../src/lib/web-sources/fmp-transcripts"
    );
    const { getDb } = await import("../src/lib/db");
    const database = getDb();
    const attemptId = "fmp-rights-test:pinecone-transcript-upsert";
    const at = new Date().toISOString();
    database.prepare(`
      INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, created_at, dispatched_at, updated_at
      ) VALUES (?, 'test', 'pinecone', 'upsert fmp transcript vectors', 'test', 'local', 1, 0, 'dispatched', ?, ?, ?)
    `).run(attemptId, at, at, at);

    process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED = "off";
    await expect(purgeFmpTranscriptRightsArtifacts({ dryRun: false }))
      .rejects.toThrow("unresolved Pinecone upsert attempts");
    expect(vectorMocks.purgeVectorNamespaceAll).not.toHaveBeenCalled();
    const blocked = await inventoryFmpTranscriptRightsArtifacts();
    expect(blocked.pendingPineconeUpsertAttemptIds).toEqual([attemptId]);
    expect(blocked.rightsGate.status).toBe("revoked");

    database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?
    `).run(at, at, attemptId);
    const purged = await purgeFmpTranscriptRightsArtifacts({ dryRun: false });
    expect(purged.after.pendingPineconeUpsertAttemptIds).toEqual([]);
    expect(vectorMocks.purgeVectorNamespaceAll).toHaveBeenCalledTimes(1);
  });
});
