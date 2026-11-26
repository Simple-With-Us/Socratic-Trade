// ST-4682 (OD-6) — embedding representation revision bump + bounded backfill planner/driver.
// NO network: the driver's embed path is a mocked slice runner; the planner reads only a temp
// SQLite ledger. Covers:
//   1. Pure revision logic — managed class gets rev 4, non-managed stays 1/2, clean-text flag
//      semantics preserved; parse rules for stamped/missing/garbage revisions.
//   2. Reuse semantics — rows stamped BELOW the managed target count stale-to-re-embed (trigger);
//      rows AT the target count fresh (the commit-id short-circuit reuses them). Rev 3 (reserved)
//      and pre-tag rows count stale. Older stamps stay readable, never read failures.
//   3. Planner counts + budget math — per-(collection, source) grouping, coverable vs live-touch,
//      estimated embed inputs/tokens.
//   4. Driver — dry-run touches nothing; bounded execute stops on row budget; resume accumulates
//      the settings-table watermark across runs; a watermark under a different target revision is
//      discarded; embed-error cap and lease-busy stop reasons.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-embed-rev-backfill-${randomUUID()}.db`)}`;
process.env.ENCRYPTION_KEY = "0".repeat(64);

beforeAll(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 180_000);

async function freshTargetRevision(): Promise<string> {
  const { activeEmbeddingModel, currentManagedEmbedRevisionForModel } = await import("../src/lib/vector-db");
  return currentManagedEmbedRevisionForModel(activeEmbeddingModel("local"));
}


let commitSeq = 0;
async function seedCommit(input: {
  source: string;
  embedRevision: string;
  expectedVectors: number;
  state?: string;
  vectorNamespace?: string;
}): Promise<string> {
  const { getDb } = await import("../src/lib/db");
  const id = `vcommit:test:${input.source}:${(commitSeq += 1)}`;
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO vector_ingest_commits (
      id, tenant_scope, user_id, source, accession, document_key, content_version,
      retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
      vector_namespace, state, created_at, updated_at, committed_at
    ) VALUES (?, 'shared:operator', 'local', ?, ?, ?, 'cv-1',
      'rmv-1', 'parser-v1', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.source, `acc-${commitSeq}`, `key-${commitSeq}`, input.embedRevision,
    input.expectedVectors, input.vectorNamespace ?? "managed", input.state ?? "committed",
    now, now, now
  );
  return id;
}

afterEach(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb().prepare("DELETE FROM vector_ingest_commits").run();
  getDb().prepare("DELETE FROM chunk_occurrences").run();
  const { clearEmbedRevBackfillWatermark } = await import("../src/lib/rag/embed-rev-backfill");
  clearEmbedRevBackfillWatermark();
  delete process.env.VECTOR_EMBED_CLEAN_TEXT;
});

describe("managed embedding revision (ST-4682 OD-6)", () => {
  it("non-managed currentEmbedRev keeps 1/2 clean-text semantics; managed class resolves to 4", async () => {
    const { currentEmbedRev, managedContextEmbedRev, embeddingSpaceRevisionForModel, currentManagedEmbedRevisionForModel } =
      await import("../src/lib/vector-db");
    expect(currentEmbedRev()).toBe(1);
    expect(currentEmbedRev(true)).toBe(4);
    expect(managedContextEmbedRev()).toBe(4);
    // Bge-m3 space: non-managed keeps the historical v1 suffix; managed jumps to v4.
    expect(embeddingSpaceRevisionForModel("baai/bge-m3")).toBe("v1-baai-bge-m3");
    expect(currentManagedEmbedRevisionForModel("baai/bge-m3")).toBe("v4-baai-bge-m3");
    // Voyage keeps the bare `v{rev}` tag form.
    expect(embeddingSpaceRevisionForModel("voyage-finance-2")).toBe("v1");
    expect(currentManagedEmbedRevisionForModel("voyage-finance-2")).toBe("v4");
  });

  it("clean-text flag still moves the non-managed revision to 2; managed stays 4 (rev 3 skipped)", async () => {
    process.env.VECTOR_EMBED_CLEAN_TEXT = "on";
    const { currentEmbedRev, managedContextEmbedRev } = await import("../src/lib/vector-db");
    expect(currentEmbedRev()).toBe(2);
    expect(currentEmbedRev(true)).toBe(4);
    expect(managedContextEmbedRev()).toBe(4);
  });

  it("parseEmbedRevisionNumber: vN prefix parses, missing/garbage parses to 0 (maximally stale, never throws)", async () => {
    const { parseEmbedRevisionNumber } = await import("../src/lib/rag/embed-rev-backfill");
    expect(parseEmbedRevisionNumber("v4-baai-bge-m3")).toBe(4);
    expect(parseEmbedRevisionNumber("v1")).toBe(1);
    expect(parseEmbedRevisionNumber("v2-baai-bge-m3")).toBe(2);
    expect(parseEmbedRevisionNumber("v3")).toBe(3);
    expect(parseEmbedRevisionNumber(undefined)).toBe(0);
    expect(parseEmbedRevisionNumber(null)).toBe(0);
    expect(parseEmbedRevisionNumber("")).toBe(0);
    expect(parseEmbedRevisionNumber("1")).toBe(0);
    expect(parseEmbedRevisionNumber("revision-2")).toBe(0);
    expect(parseEmbedRevisionNumber(4)).toBe(0);
  });
});

describe("planEmbedRevBackfill", () => {
  it("groups committed rows per (namespace, source); stale = stamp below the managed target (4)", async () => {
    const target = await freshTargetRevision();
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 3 });
    await seedCommit({ source: "sec-edgar", embedRevision: "v2-baai-bge-m3", expectedVectors: 2 });
    await seedCommit({ source: "sec-edgar", embedRevision: target, expectedVectors: 10 }); // fresh → reuse
    await seedCommit({ source: "sec-edgar", embedRevision: "v3-baai-bge-m3", expectedVectors: 1 }); // reserved slot → stale
    await seedCommit({ source: "earningscalls-dev", embedRevision: "v1-baai-bge-m3", expectedVectors: 4 });
    await seedCommit({ source: "roic-transcripts", embedRevision: "v2-baai-bge-m3", expectedVectors: 5 });
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 1, state: "aborted" });
    await seedCommit({ source: "notes-private", embedRevision: "v1-baai-bge-m3", expectedVectors: 1, vectorNamespace: "private:t1" });

    const { planEmbedRevBackfill } = await import("../src/lib/rag/embed-rev-backfill");
    const plan = planEmbedRevBackfill({ tokensPerRow: 600 });

    expect(plan.targetEmbedRevision).toBe(target);
    expect(plan.targetRev).toBe(4);
    // Committed rows only: 3+2+1+4+5+1 = 16 stale across the seeds (fresh v4 row and aborted excluded).
    expect(plan.staleRows).toBe(16);
    // Coverable (sources the live-scan runner can reconstruct): sec-edgar 3+2+1 + earningscalls-dev 4.
    expect(plan.coverableStaleRows).toBe(10);
    expect(plan.uncoverableStaleRows).toBe(6); // roic-transcripts(5) + notes-private(1)
    expect(plan.estimatedEmbedCalls).toBe(10);
    expect(plan.estimatedTokens).toBe(6000);
    expect(plan.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vectorNamespace: "managed", source: "sec-edgar", totalCommits: 4, staleCommits: 3, staleRows: 6, runnerCovers: true }),
        expect.objectContaining({ vectorNamespace: "managed", source: "roic-transcripts", staleRows: 5, runnerCovers: false }),
        expect.objectContaining({ vectorNamespace: "private:t1", source: "notes-private", staleRows: 1, runnerCovers: false })
      ])
    );
  });

  it("coveredSources option extends coverage; a fully-v4 ledger plans zero work", async () => {
    const target = await freshTargetRevision();
    await seedCommit({ source: "insider-filing", embedRevision: "v1-baai-bge-m3", expectedVectors: 2 });
    await seedCommit({ source: "sec-edgar", embedRevision: target, expectedVectors: 4 });
    const { planEmbedRevBackfill } = await import("../src/lib/rag/embed-rev-backfill");

    const base = planEmbedRevBackfill();
    expect(base.staleRows).toBe(2);
    expect(base.coverableStaleRows).toBe(0); // insider-filing only covered when selected explicitly

    const extended = planEmbedRevBackfill({ coveredSources: ["insider-filing"] });
    expect(extended.coverableStaleRows).toBe(2);

    // Simulate the re-embed having landed: every committed row now carries the target stamp.
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("UPDATE vector_ingest_commits SET embed_revision = ?").run(target);
    const done = planEmbedRevBackfill({ coveredSources: ["insider-filing"] });
    expect(done.staleRows).toBe(0);
    expect(done.coverableStaleRows).toBe(0);
    expect(done.estimatedEmbedCalls).toBe(0);
    expect(done.estimatedTokens).toBe(0);
  });
});

describe("runEmbedRevBackfill driver", () => {
  it("dry-run reports the plan and touches neither the runner nor the watermark", async () => {
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 3 });
    const { runEmbedRevBackfill, EMBED_REV_BACKFILL_WATERMARK_KEY } = await import("../src/lib/rag/embed-rev-backfill");
    const { getDb } = await import("../src/lib/db");
    let runnerCalls = 0;

    const outcome = await runEmbedRevBackfill({
      execute: false,
      runner: async () => { runnerCalls += 1; return null; }
    });
    expect(runnerCalls).toBe(0);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.reason).toBe("dry-run");
    expect(outcome.finalPlan.coverableStaleRows).toBe(3);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?").get(EMBED_REV_BACKFILL_WATERMARK_KEY)).toEqual({ n: 0 });
  });

  it("execute drives bounded slices through the embed path and stops 'exhausted' when the ledger is fresh", async () => {
    const target = await freshTargetRevision();
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 2 });
    await seedCommit({ source: "sec-edgar", embedRevision: "v2-baai-bge-m3", expectedVectors: 3 });
    const { runEmbedRevBackfill, readEmbedRevWatermark } = await import("../src/lib/rag/embed-rev-backfill");
    const { getDb } = await import("../src/lib/db");

    const slices = await runEmbedRevBackfill({
      execute: true,
      budget: { maxRows: 100, maxEstimatedTokens: 1_000_000, maxEmbedErrors: 5, batchDocs: 10 },
      runner: async () => {
        // Mock embed path: re-stamps every committed stale row it was handed.
        getDb().prepare("UPDATE vector_ingest_commits SET embed_revision = ? WHERE state = 'committed' AND CAST(substr(embed_revision, 2) AS INTEGER) < 4").run(target);
        return { embedded: 5, reused: 0, failed: 0, completed: true, stoppedForBudget: false };
      }
    });
    expect(slices.reason).toBe("exhausted");
    expect(slices.slices).toBe(1);
    expect(slices.embedded).toBe(5);
    expect(slices.rowsConsumed).toBe(5);
    expect(slices.finalPlan.coverableStaleRows).toBe(0);
    const watermark = readEmbedRevWatermark(target);
    expect(watermark?.slices).toBe(1);
    expect(watermark?.rowsConsumed).toBe(5);
    expect(watermark?.estimatedTokensConsumed).toBe(5 * slices.finalPlan.tokensPerRow);
    expect(watermark?.lastReason).toBe("exhausted");
  });

  it("stops on the row budget, then a second run RESUMES from the persisted watermark (cumulative totals)", async () => {
    const target = await freshTargetRevision();
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 1 });
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 1 });
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 1 });
    const { runEmbedRevBackfill, readEmbedRevWatermark } = await import("../src/lib/rag/embed-rev-backfill");
    const { getDb } = await import("../src/lib/db");

    // Each slice promotes exactly one commit (one stale row).
    const runner = async () => {
      const row = getDb().prepare(
        "SELECT id FROM vector_ingest_commits WHERE state = 'committed' AND CAST(substr(embed_revision, 2) AS INTEGER) < 4 ORDER BY rowid LIMIT 1"
      ).get() as { id: string } | undefined;
      if (!row) return { embedded: 0, reused: 0, failed: 0, completed: false, stoppedForBudget: false };
      getDb().prepare("UPDATE vector_ingest_commits SET embed_revision = ? WHERE id = ?").run(target, row.id);
      return { embedded: 1, reused: 0, failed: 0, completed: false, stoppedForBudget: false };
    };

    const run1 = await runEmbedRevBackfill({
      execute: true,
      runner,
      budget: { maxRows: 2, maxEstimatedTokens: 1_000_000, maxEmbedErrors: 5, batchDocs: 1 }
    });
    expect(run1.reason).toBe("budget-rows");
    expect(run1.slices).toBe(2);
    expect(run1.rowsConsumed).toBe(2);
    expect(run1.finalPlan.coverableStaleRows).toBe(1);

    const run2 = await runEmbedRevBackfill({
      execute: true,
      runner,
      budget: { maxRows: 2, maxEstimatedTokens: 1_000_000, maxEmbedErrors: 5, batchDocs: 1 }
    });
    expect(run2.reason).toBe("exhausted");
    expect(run2.rowsConsumed).toBe(1); // per-run accounting
    const watermark = readEmbedRevWatermark(target);
    expect(watermark?.rowsConsumed).toBe(3); // cumulative across the resume chain
    expect(watermark?.slices).toBe(3);
    expect(watermark?.embeddedTotal).toBe(3);
  });

  it("discards a watermark stamped for a different target revision", async () => {
    const target = await freshTargetRevision();
    const { getDb, setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("embedRevBackfill:progress", {
      targetEmbedRevision: "v999-legacy-space",
      slices: 7,
      rowsConsumed: 700,
      estimatedTokensConsumed: 420_000,
      embeddedTotal: 700,
      reusedTotal: 0,
      failedTotal: 0,
      lastReason: "exhausted",
      updatedAt: new Date().toISOString()
    });
    const { runEmbedRevBackfill, readEmbedRevWatermark } = await import("../src/lib/rag/embed-rev-backfill");
    expect(readEmbedRevWatermark(target)).toBeUndefined();

    // A fresh run replaces the foreign-revision chain rather than resuming it.
    await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 1 });
    const run = await runEmbedRevBackfill({
      execute: true,
      runner: async () => {
        getDb().prepare("UPDATE vector_ingest_commits SET embed_revision = ? WHERE state = 'committed'").run(target);
        return { embedded: 1, reused: 0, failed: 0, completed: true, stoppedForBudget: false };
      },
      budget: { maxRows: 10, maxEstimatedTokens: 100_000, maxEmbedErrors: 5, batchDocs: 10 }
    });
    expect(run.reason).toBe("exhausted");
    const watermark = readEmbedRevWatermark(target);
    expect(watermark?.slices).toBe(1);
    expect(watermark?.rowsConsumed).toBe(1);
    expect(readEmbedRevWatermark("v999-legacy-space")).toBeUndefined();
  });

  it("hard-stops at the embed-error cap and stops on lease-busy / no-progress", async () => {
    const target = await freshTargetRevision();
    for (let i = 0; i < 6; i += 1) {
      await seedCommit({ source: "sec-edgar", embedRevision: "v1-baai-bge-m3", expectedVectors: 1 });
    }
    const { runEmbedRevBackfill } = await import("../src/lib/rag/embed-rev-backfill");
    const { getDb } = await import("../src/lib/db");

    // Each slice embeds one row AND reports one failure → cumulative failures hit the cap of 2.
    const flaky = async () => {
      const row = getDb().prepare(
        "SELECT id FROM vector_ingest_commits WHERE state = 'committed' AND CAST(substr(embed_revision, 2) AS INTEGER) < 4 ORDER BY rowid LIMIT 1"
      ).get() as { id: string } | undefined;
      if (row) getDb().prepare("UPDATE vector_ingest_commits SET embed_revision = ? WHERE id = ?").run(target, row.id);
      return { embedded: row ? 1 : 0, reused: 0, failed: 1, completed: false, stoppedForBudget: false };
    };
    const errored = await runEmbedRevBackfill({
      execute: true,
      runner: flaky,
      budget: { maxRows: 100, maxEstimatedTokens: 1_000_000, maxEmbedErrors: 2, batchDocs: 1 }
    });
    expect(errored.reason).toBe("embed-error-limit");
    expect(errored.failed).toBe(2);

    const busy = await runEmbedRevBackfill({ execute: true, runner: async () => null });
    expect(busy.reason).toBe("lease-busy");
    expect(busy.slices).toBe(1);

    // A runner that reports nothing and changes no rows → loud no-progress stop, no spinning.
    const stuck = await runEmbedRevBackfill({
      execute: true,
      runner: async () => ({ embedded: 0, reused: 0, failed: 0, completed: false, stoppedForBudget: false }),
      budget: { maxRows: 100, maxEstimatedTokens: 1_000_000, maxEmbedErrors: 5, batchDocs: 10 }
    });
    expect(stuck.reason).toBe("no-progress");
    expect(stuck.slices).toBe(1);
  });

  it("execute with a fully-fresh ledger stops immediately without calling the runner", async () => {
    const target = await freshTargetRevision();
    await seedCommit({ source: "sec-edgar", embedRevision: target, expectedVectors: 4 });
    const { runEmbedRevBackfill } = await import("../src/lib/rag/embed-rev-backfill");
    let called = 0;
    const outcome = await runEmbedRevBackfill({
      execute: true,
      runner: async () => { called += 1; return null; }
    });
    expect(called).toBe(0);
    expect(outcome.reason).toBe("exhausted");
    expect(outcome.slices).toBe(0);
  });
});
