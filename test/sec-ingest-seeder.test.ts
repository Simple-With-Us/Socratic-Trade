import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import {
  claimSecIngestTasks,
  failSecIngestTask,
  getSecIngestJob,
  getSecIngestJobReceipt,
  reconcileSecIngestJob
} from "../src/lib/db-rag-ingest";
import { seedSecIngestJobsFromManifest, SEC_INGEST_BASELINE_CORPUS_REVISION } from "../src/lib/rag/sec-ingest-seeder";
import { SecIngestWorker, secIngestWorkerEnabled } from "../src/lib/rag/sec-ingest-worker";
import { fetchRecentFilings, type FilingRef } from "../src/lib/web-sources/sec-filings";
import { politeFetch, politeFetchText } from "../src/lib/web-sources/http";
import { hashSecUniverseIssuers, type FrozenSecUniverseManifest, type SecUniverseIssuer } from "../src/lib/rag/universe-manifest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-seeder-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-sec-seeder-data-${runId}`);
  const db = getDb();
  applyVersionedMigrations(db);
});

afterEach(() => {
  vi.clearAllMocks();
});

// The seeder discovers accessions via fetchRecentFilings (EDGAR submissions API); the worker's
// 'discovered' checkpoint fetches document bodies via politeFetchText. Mock both network layers —
// artifact IO (readLocalArtifact/writeLocalArtifact) runs for real against the tmpdir DATA_DIR,
// matching test/sec-ingest-worker.test.ts.
vi.mock("../src/lib/web-sources/sec-filings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/web-sources/sec-filings")>();
  return { ...original, fetchRecentFilings: vi.fn() };
});
vi.mock("../src/lib/web-sources/http", () => ({
  politeFetchText: vi.fn(),
  politeFetch: vi.fn(),
  secUserAgent: vi.fn(() => "test-agent"),
  runRateLimited: vi.fn(),
  sleep: vi.fn(),
  BROWSER_UA: "Mozilla/5.0 test"
}));

function issuer(rank: number, cik: string, ticker: string): SecUniverseIssuer {
  return {
    rank,
    cik,
    ticker,
    aliases: [],
    aliasesVerifiedAt: "2026-07-18T00:00:00.000Z",
    title: `${ticker} Corp`,
    exchange: "NASDAQ",
    securityType: "operating-company",
    sector: null,
    industry: null,
    marketCapUsd: 1_000_000_000,
    dollarVolumeUsd: 10_000_000,
    inclusionReason: "market-cap-liquidity",
    sourceRefs: ["sec-tickers"]
  };
}

function manifest(issuers: SecUniverseIssuer[], snapshotId = "sec-rag-test-snapshot"): FrozenSecUniverseManifest {
  return {
    schemaVersion: 2,
    snapshotId,
    effectiveAt: "2026-07-18T00:00:00.000Z",
    generatedAt: "2026-07-18T00:00:00.000Z",
    issuerSha256: hashSecUniverseIssuers(issuers),
    selectionMethod: "test",
    sources: [{ name: "sec-tickers", asOf: "2026-07-18T00:00:00.000Z", sha256: "a".repeat(64) }],
    issuers,
    quarantined: []
  };
}

function filingRef(cik: string, docType: "10-K" | "10-Q", serial: number): FilingRef {
  const accession = `${cik}-26-${String(serial).padStart(6, "0")}`;
  return {
    accession,
    docType,
    filedAt: "2026-07-01",
    acceptanceDateTime: "2026-07-01T21:15:00.000Z",
    primaryDoc: `${cik.toLowerCase()}-20260701-${serial}.htm`,
    url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${cik.toLowerCase()}-20260701-${serial}.htm`
  };
}

function mockFilingsFor(byCik: Record<string, { tenKs: FilingRef[]; tenQs: FilingRef[] }>) {
  // The seeder now makes ONE fetchRecentFilings call per issuer covering both docTypes (see
  // sec-ingest-seeder.ts), so this mock combines tenKs/tenQs based on the requested docTypes
  // rather than branching to a single list per call.
  vi.mocked(fetchRecentFilings).mockImplementation(async (cik, docTypes) => {
    const entry = byCik[cik];
    if (!entry) return [];
    const requested = docTypes ?? ["10-K", "10-Q"];
    return [
      ...(requested.includes("10-K") ? entry.tenKs : []),
      ...(requested.includes("10-Q") ? entry.tenQs : [])
    ];
  });
}

describe("seedSecIngestJobsFromManifest", () => {
  it("seeds one job per issuer with one task per target document, then a re-seed is a complete no-op", async () => {
    const cikA = "0000900001";
    const cikB = "0000900002";
    const m = manifest([issuer(1, cikA, "AAA"), issuer(2, cikB, "BBB")], "snap-idempotency");
    mockFilingsFor({
      [cikA]: { tenKs: [filingRef(cikA, "10-K", 1)], tenQs: [2, 3, 4, 5].map((n) => filingRef(cikA, "10-Q", n)) },
      [cikB]: { tenKs: [filingRef(cikB, "10-K", 1)], tenQs: [2, 3].map((n) => filingRef(cikB, "10-Q", n)) }
    });

    const first = await seedSecIngestJobsFromManifest({ manifest: m });
    expect(first.newlySeeded).toBe(2);
    expect(first.alreadySeeded).toBe(0);
    expect(first.totalTasksEnqueued).toBe(5 + 3); // A: 1x10-K + 4x10-Q; B: 1x10-K + 2x10-Q (only 2 exist)
    expect(first.corpusRevision).toBe(SEC_INGEST_BASELINE_CORPUS_REVISION);

    const jobA = getSecIngestJob(first.issuers[0]!.jobId)!;
    expect(jobA.status).toBe("running");
    expect(jobA.intakeClosedAt).toBeTruthy();
    expect(jobA.expectedTasks).toBe(5);
    expect(jobA.universeSnapshotId).toBe("snap-idempotency");

    // Re-seed: same manifest, same corpus revision — must not duplicate jobs or tasks, and must not
    // hit EDGAR again for sealed jobs.
    vi.mocked(fetchRecentFilings).mockClear();
    const second = await seedSecIngestJobsFromManifest({ manifest: m });
    expect(second.newlySeeded).toBe(0);
    expect(second.alreadySeeded).toBe(2);
    expect(second.totalTasksEnqueued).toBe(0);
    expect(vi.mocked(fetchRecentFilings)).not.toHaveBeenCalled();

    const db = getDb();
    const jobCount = (db.prepare("SELECT COUNT(*) AS n FROM sec_ingest_jobs WHERE universe_snapshot_id = ?").get("snap-idempotency") as { n: number }).n;
    const taskCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM sec_ingest_tasks WHERE job_id IN (SELECT id FROM sec_ingest_jobs WHERE universe_snapshot_id = ?)"
    ).get("snap-idempotency") as { n: number }).n;
    expect(jobCount).toBe(2);
    expect(taskCount).toBe(8);
  });

  it("seeds tasks the worker's first checkpoint can actually consume (contract test)", async () => {
    const cik = "0000900010";
    const m = manifest([issuer(1, cik, "CCC")], "snap-contract");
    const ref = filingRef(cik, "10-K", 1);
    mockFilingsFor({ [cik]: { tenKs: [ref], tenQs: [] } });

    const seeded = await seedSecIngestJobsFromManifest({ manifest: m });
    expect(seeded.totalTasksEnqueued).toBe(1);
    const jobId = seeded.issuers[0]!.jobId;

    // The seeder must have left the job 'running' so claimSecIngestTasks can lease from it without
    // any extra operator step.
    const claimed = claimSecIngestTasks(jobId, { owner: "contract-worker", leaseMs: 60_000, limit: 1 });
    expect(claimed).toHaveLength(1);
    const task = claimed[0]!;

    // Granularity contract: one task per document, starting at 'discovered', carrying the payload
    // fields the worker reads (url/docType/filedAt/acceptanceDateTime — sec-ingest-worker.ts
    // reads payload.url at the discovered checkpoint and docType/filedAt/acceptanceDateTime at the
    // facts_extracted/embed_queued stages).
    expect(task.checkpoint).toBe("discovered");
    expect(task.accession).toBe(ref.accession);
    expect(task.cik).toBe(cik);
    expect(task.symbol).toBe("CCC");
    expect(task.sequence).toBe(1);
    expect(task.documentName).toBe(ref.primaryDoc);
    expect(task.payload).toMatchObject({
      url: ref.url,
      docType: "10-K",
      filedAt: ref.filedAt,
      acceptanceDateTime: ref.acceptanceDateTime
    });

    // Drive the task through the worker's first checkpoint with a mocked fetch: discovered ->
    // fetched must fetch payload.url, persist the raw artifact, and advance. 2026-09-27 P0-2: the
    // worker now DRAINS the state machine in one call, so this single processTask carries the task
    // all the way to complete; companyfacts 404 is the facts_extracted stage's documented no-op.
    vi.mocked(politeFetchText).mockResolvedValue(
      "<html><body>Item 1. Business<p>CCC Corp makes widgets and files its reports on time.</p></body></html>"
    );
    vi.mocked(politeFetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found"
    } as any);
    const worker = new SecIngestWorker();
    await worker.processTask(task);

    expect(vi.mocked(politeFetchText)).toHaveBeenCalledWith(ref.url);
    // The drain then carries it through fetched -> validated -> parsed -> facts_extracted ->
    // chunked -> embed_queued, where it parks: this test file has no embed provider, so the real
    // storeDocument returns an incomplete result and the worker defers with a retry instead of
    // dead-lettering. That is the budget-gate contract, and it is the furthest durable state the
    // seeder's payload can drive in a unit-test environment.
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("embed-transient-error");
    const receipt = getSecIngestJobReceipt(jobId)!;
    expect(receipt.byStatus.retry_wait).toBe(1);
    expect(receipt.byStatus.pending).toBe(0);
  });

  it("never re-seeds or revives a dead-lettered document (dead-letter discipline)", async () => {
    const cik = "0000900020";
    const m = manifest([issuer(1, cik, "DDD")], "snap-deadletter");
    const ref = filingRef(cik, "10-K", 1);
    mockFilingsFor({ [cik]: { tenKs: [ref], tenQs: [] } });

    const seeded = await seedSecIngestJobsFromManifest({ manifest: m });
    const jobId = seeded.issuers[0]!.jobId;

    // Permanently fail the single task (retryable:false -> dead_letter immediately).
    const claimed = claimSecIngestTasks(jobId, { owner: "dl-worker", leaseMs: 60_000, limit: 1 });
    const failure = failSecIngestTask({
      taskId: claimed[0]!.id,
      owner: "dl-worker",
      leaseToken: claimed[0]!.leaseToken!,
      retryable: false,
      errorType: "document-unfetchable",
      error: "HTTP 404 permanent"
    });
    expect(failure.status).toBe("dead_letter");

    // Completion criteria is "all tasks terminal (complete OR dead_letter)", never "zero pending":
    // reconcile closes the job as complete_with_errors even though nothing completed successfully.
    expect(reconcileSecIngestJob(jobId)).toBe("complete_with_errors");

    // Re-seeding must not touch the job: no new tasks, no revived dead letters, no EDGAR calls.
    vi.mocked(fetchRecentFilings).mockClear();
    const reseed = await seedSecIngestJobsFromManifest({ manifest: m });
    expect(reseed.newlySeeded).toBe(0);
    expect(reseed.alreadySeeded).toBe(1);
    expect(vi.mocked(fetchRecentFilings)).not.toHaveBeenCalled();

    const receipt = getSecIngestJobReceipt(jobId)!;
    expect(receipt.job.status).toBe("complete_with_errors");
    expect(receipt.totalTasks).toBe(1);
    expect(receipt.byStatus.dead_letter).toBe(1);
    expect(receipt.byStatus.pending).toBe(0);

    // And nothing about the dead-lettered task is claimable again.
    expect(claimSecIngestTasks(jobId, { owner: "dl-worker-2", leaseMs: 60_000, limit: 5 })).toHaveLength(0);
  });

  it("supports offset/limit/issuerCiks scoping ordered by manifest rank", async () => {
    const ciks = ["0000900031", "0000900032", "0000900033", "0000900034"];
    const m = manifest(ciks.map((cik, i) => issuer(i + 1, cik, `SC${i + 1}`)), "snap-scope");
    mockFilingsFor(Object.fromEntries(ciks.map((cik) => [cik, { tenKs: [filingRef(cik, "10-K", 1)], tenQs: [] }])));

    const windowed = await seedSecIngestJobsFromManifest({ manifest: m, offset: 1, limit: 2 });
    expect(windowed.considered).toBe(2);
    expect(windowed.issuers.map((i) => i.cik)).toEqual([ciks[1], ciks[2]]);

    const byCik = await seedSecIngestJobsFromManifest({ manifest: m, issuerCiks: [ciks[3]!] });
    expect(byCik.considered).toBe(1);
    expect(byCik.issuers[0]!.cik).toBe(ciks[3]);
  });

  it("leaves intake open when discovery finds nothing, so a later seed can retry a transient EDGAR miss", async () => {
    const cik = "0000900040";
    const m = manifest([issuer(1, cik, "EEE")], "snap-nofilings");
    mockFilingsFor({}); // fetchRecentFilings returns [] for every CIK

    const first = await seedSecIngestJobsFromManifest({ manifest: m });
    expect(first.issuersWithNoFilings).toEqual([cik]);
    expect(first.newlySeeded).toBe(0);
    const job = getSecIngestJob(first.issuers[0]!.jobId)!;
    expect(job.intakeClosedAt).toBeUndefined();

    // Discovery recovers on the next run: the same job (same idempotency key) gets its tasks.
    mockFilingsFor({ [cik]: { tenKs: [filingRef(cik, "10-K", 1)], tenQs: [] } });
    const second = await seedSecIngestJobsFromManifest({ manifest: m });
    expect(second.newlySeeded).toBe(1);
    expect(second.issuers[0]!.jobId).toBe(first.issuers[0]!.jobId);
  });

  it("refuses an invalid manifest instead of seeding from unvalidated data", async () => {
    const bad = manifest([issuer(1, "0000900050", "FFF")], "snap-invalid");
    (bad as unknown as { issuerSha256: string }).issuerSha256 = "c".repeat(64);
    // Write to disk so the loader path (read -> validate) is exercised.
    const fs = await import("node:fs");
    const badPath = join(tmpdir(), `agentic-sec-seeder-bad-${randomUUID()}.json`);
    fs.writeFileSync(badPath, JSON.stringify(bad), "utf8");

    await expect(seedSecIngestJobsFromManifest({ manifestPath: badPath })).rejects.toThrow(/invalid SEC universe manifest/);
    fs.rmSync(badPath, { force: true });
  });
});

describe("SEC ingest worker startup gate", () => {
  it("is off by default and honors the SEC_INGEST_WORKER_ENABLED convention values", () => {
    const prior = process.env.SEC_INGEST_WORKER_ENABLED;
    try {
      delete process.env.SEC_INGEST_WORKER_ENABLED;
      expect(secIngestWorkerEnabled()).toBe(false);
      process.env.SEC_INGEST_WORKER_ENABLED = "off";
      expect(secIngestWorkerEnabled()).toBe(false);
      for (const value of ["1", "true", "on", "yes", " ON "]) {
        process.env.SEC_INGEST_WORKER_ENABLED = value;
        expect(secIngestWorkerEnabled()).toBe(true);
      }
    } finally {
      if (prior === undefined) delete process.env.SEC_INGEST_WORKER_ENABLED;
      else process.env.SEC_INGEST_WORKER_ENABLED = prior;
    }
  });
});
