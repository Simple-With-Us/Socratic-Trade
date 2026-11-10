// Monthly Pinecone write-unit (WU) exhaustion breaker — detection, marker lifecycle, the
// pre-embed write gate in storeContexts/storeDocument, notification dedup, and the SEC ingest
// queue's clean deferral (park until marker expiry, attempt refunded — no retry storm).
//
// Hermetic: no network (global.fetch is stubbed to prove NO embed call happens while gated),
// no Pinecone, storeDocument mocked for the worker tests; everything else is the real module
// graph against a temp SQLite DB.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-wu-breaker-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-wu-breaker-data-${runId}`);
  // The auto-resume test must reach the "missing keys" skip AFTER the gate, not a real client.
  delete process.env.PINECONE_API_KEY;
});

const mocks = vi.hoisted(() => ({
  alertStorageWarning: vi.fn().mockResolvedValue(undefined),
  storeDocument: vi.fn()
}));

// Keep the real health store (logApiHealth etc.); spy only the notification egress so the
// once-per-episode dedup is directly assertable without exercising email/push plumbing.
vi.mock("../src/lib/db-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-health")>();
  return { ...actual, alertStorageWarning: mocks.alertStorageWarning };
});

// Real storeContexts (the gate under test lives inside it); mocked storeDocument so the SEC
// worker tests can prove the embed stage was never entered / simulate a mid-call trip.
vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return { ...actual, storeDocument: mocks.storeDocument };
});

// Sample of the real production failure (2026-08).
const PROD_WU_ERROR =
  "An unexpected error occured while calling the https://api.pinecone.io/vectors/upsert endpoint.  " +
  "Request failed. You've reached your write unit limit for the current month (2000000). " +
  "To continue writing data, upgrade your plan. Status: 429.";

async function loadBreaker() {
  return import("../src/lib/pinecone-wu-breaker");
}

async function auditCount(kind: string): Promise<number> {
  const { getDb } = await import("../src/lib/db");
  const row = getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM audit_events WHERE kind = ?")
    .get(kind) as { cnt: number };
  return row.cnt;
}

describe("pinecone monthly write-unit breaker", () => {
  beforeEach(async () => {
    const { getDb, deleteInternalSetting, applyVersionedMigrations } = await import("../src/lib/db");
    applyVersionedMigrations(getDb());
    const { PINECONE_WU_EXHAUSTED_UNTIL_KEY } = await loadBreaker();
    deleteInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
    deleteInternalSetting("pinecone:wuGateLastAuditDay");
    getDb().prepare("DELETE FROM audit_events").run();
    getDb().prepare("DELETE FROM api_health_log").run();
    mocks.alertStorageWarning.mockClear();
    mocks.storeDocument.mockReset();
    // Breaker only parks when an app monthly budget is configured.  0 = pay-as-you-go.
    process.env.PINECONE_MONTHLY_WU_BUDGET = "2000000";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
    delete process.env.PINECONE_MONTHLY_WU_BUDGET;
  });

  it("detects ONLY the monthly WU exhaustion error shape", async () => {
    const { isPineconeWuExhaustedError } = await loadBreaker();
    expect(isPineconeWuExhaustedError(PROD_WU_ERROR)).toBe(true);
    expect(isPineconeWuExhaustedError("you've reached your WRITE UNIT LIMIT FOR THE CURRENT MONTH — rate limited")).toBe(true);
    // Official Pinecone body often omits "Status: 429" — HTTP status is 429, text is the quota phrase.
    expect(isPineconeWuExhaustedError("You've reached your write unit limit for the current month (2000000).")).toBe(true);
    expect(isPineconeWuExhaustedError(
      "Request failed. You've reached your write unit limit for the current month. To continue writing data, upgrade your plan."
    )).toBe(true);
    // Ordinary 429s (per-second rate limits, embed providers) must keep normal retry behavior.
    expect(isPineconeWuExhaustedError("HTTP 429 Too Many Requests")).toBe(false);
    expect(isPineconeWuExhaustedError("")).toBe(false);
    expect(isPineconeWuExhaustedError(null)).toBe(false);
  });

  it("trip persists a marker equal to the first day of NEXT month UTC (computed from error time)", async () => {
    const { tripPineconeWuBreaker, pineconeWuExhaustedUntil, firstDayOfNextMonthUtc } = await loadBreaker();
    const augNow = Date.UTC(2026, 7, 8, 15, 30, 0); // 2026-08-08T15:30Z
    const res = await tripPineconeWuBreaker({ message: PROD_WU_ERROR, operation: "upsert" }, augNow);
    expect(res.tripped).toBe(true);
    expect(res.until).toBe("2026-09-01T00:00:00.000Z");
    expect(pineconeWuExhaustedUntil(augNow)).toBe("2026-09-01T00:00:00.000Z");
    // Year rollover.
    expect(firstDayOfNextMonthUtc(Date.UTC(2026, 11, 15))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("emits ONE notification and ONE audit row per episode (re-detections dedup)", async () => {
    const { tripPineconeWuBreaker } = await loadBreaker();
    const now = Date.UTC(2026, 7, 8, 12, 0, 0);
    const first = await tripPineconeWuBreaker({ message: PROD_WU_ERROR, operation: "upsert" }, now);
    const second = await tripPineconeWuBreaker({ message: PROD_WU_ERROR, operation: "upsert" }, now + 3_600_000);
    expect(first.tripped).toBe(true);
    expect(second.tripped).toBe(false);
    expect(second.until).toBe(first.until);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);
    expect(mocks.alertStorageWarning.mock.calls[0]![0]).toBe("pinecone_write_units_exhausted");
    expect(String(mocks.alertStorageWarning.mock.calls[0]![1])).toContain("paused until 2026-09-01");
    expect(String(mocks.alertStorageWarning.mock.calls[0]![1])).toContain("Reads/RAG retrieval unaffected");
    expect(await auditCount("pinecone_wu_breaker_tripped")).toBe(1);
  });

  it("gates storeContexts BEFORE any embed: no fetch, typed skipped result, once-daily audit", async () => {
    const { tripPineconeWuBreaker } = await loadBreaker();
    const { until } = await tripPineconeWuBreaker({ message: PROD_WU_ERROR }, Date.now());
    const fetchSpy = vi.fn(async () => {
      throw new Error("embed fetch must not run while the WU breaker is active");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { storeContexts } = await import("../src/lib/vector-db");
    const doc = {
      text: "Hello breaker — this document must never be embedded while gated.",
      metadata: { symbol: "AAPL", source: "unit-test", timestamp: "2026-08-08T00:00:00.000Z" }
    };
    const result = await storeContexts([doc], "local");
    expect(result).toMatchObject({
      attempted: 1,
      indexed: 0,
      skipped: true,
      wuExhausted: true,
      wuExhaustedUntil: until
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Second gated call the same day: still skipped, but the gate audit stays at ONE row.
    const again = await storeContexts([doc], "local");
    expect(again.wuExhausted).toBe(true);
    expect(await auditCount("pinecone_wu_gate_skip")).toBe(1);
  });

  it("does not latch a Starter 2M monthly-WU 429 while the Standard trial is active", async () => {
    process.env.PINECONE_TRIAL_ENDS_AT = "2026-08-30T00:00:00.000Z";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { tripPineconeWuBreaker, pineconeWuExhaustedUntil, PINECONE_WU_EXHAUSTED_UNTIL_KEY } =
      await loadBreaker();
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY, "2026-09-01T00:00:00.000Z");
    const augNow = Date.UTC(2026, 7, 17, 16, 0, 0);
    expect(pineconeWuExhaustedUntil(augNow)).toBeNull();
    const res = await tripPineconeWuBreaker({ message: PROD_WU_ERROR, operation: "upsert" }, augNow);
    expect(res.tripped).toBe(false);
    expect(pineconeWuExhaustedUntil(augNow)).toBeNull();
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
  });

  it("does not trip a leftover 2M 429 while a 5M Builder budget is configured", async () => {
    process.env.PINECONE_TRIAL_ENDS_AT = "2026-08-27T00:00:00.000Z";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "5000000";
    process.env.PINECONE_MONTHLY_WU_BUDGET = "5000000";
    const { tripPineconeWuBreaker, pineconeWuExhaustedUntil } = await loadBreaker();
    const now = Date.UTC(2026, 7, 22, 12, 0, 0);
    const twoM = await tripPineconeWuBreaker({ message: PROD_WU_ERROR, operation: "upsert" }, now);
    expect(twoM.tripped).toBe(false);
    expect(pineconeWuExhaustedUntil(now)).toBeNull();
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
    const fiveM = await tripPineconeWuBreaker({
      message: "You've reached your write unit limit for the current month (5000000). Status: 429.",
      operation: "upsert"
    }, now);
    expect(fiveM.tripped).toBe(true);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
  });

  it("does not trip numberless official monthly-quota text during the 5M Builder week", async () => {
    process.env.PINECONE_TRIAL_ENDS_AT = "2026-08-27T00:00:00.000Z";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "5000000";
    process.env.PINECONE_MONTHLY_WU_BUDGET = "5000000";
    const { tripPineconeWuBreaker, pineconeWuExhaustedUntil, isPineconeWuExhaustedError } =
      await loadBreaker();
    const now = Date.UTC(2026, 7, 22, 12, 0, 0);
    // Same official body the matcher already accepts — no "(2000000)" count to compare.
    const numberless =
      "Request failed. You've reached your write unit limit for the current month. To continue writing data, upgrade your plan.";
    expect(isPineconeWuExhaustedError(numberless)).toBe(true);
    const res = await tripPineconeWuBreaker({ message: numberless, operation: "upsert" }, now);
    expect(res.tripped).toBe(false);
    expect(pineconeWuExhaustedUntil(now)).toBeNull();
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
  });

  it("does not trip or page when the app monthly budget is off (pay-as-you-go)", async () => {
    process.env.PINECONE_MONTHLY_WU_BUDGET = "0";
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
    const { tripPineconeWuBreaker, pineconeWuExhaustedUntil } = await loadBreaker();
    const res = await tripPineconeWuBreaker({ message: PROD_WU_ERROR, operation: "upsert" }, Date.UTC(2026, 8, 1));
    expect(res.tripped).toBe(false);
    expect(pineconeWuExhaustedUntil(Date.UTC(2026, 8, 1))).toBeNull();
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
  });

  it("clears the marker eagerly on a successful Pinecone WRITE, but never on reads", async () => {
    const { tripPineconeWuBreaker, notePineconeWriteSuccess, pineconeWuExhaustedUntil } = await loadBreaker();
    await tripPineconeWuBreaker({ message: PROD_WU_ERROR }, Date.now());
    notePineconeWriteSuccess("query");
    notePineconeWriteSuccess("describeIndexStats");
    expect(pineconeWuExhaustedUntil()).not.toBeNull();
    notePineconeWriteSuccess("upsert");
    expect(pineconeWuExhaustedUntil()).toBeNull();
    expect(await auditCount("pinecone_wu_breaker_cleared")).toBe(1);
  });

  it("auto-resumes writes once the marker expires (expired marker gates nothing)", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const { PINECONE_WU_EXHAUSTED_UNTIL_KEY, pineconeWuExhaustedUntil } = await loadBreaker();
    setInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY, "2026-08-01T00:00:00.000Z");
    expect(pineconeWuExhaustedUntil(Date.UTC(2026, 7, 8))).toBeNull();

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts(
      [{ text: "post-expiry document", metadata: { symbol: "MSFT", source: "unit-test", timestamp: "2026-08-08T00:00:00.000Z" } }],
      "local"
    );
    // The gate let the call through: no wuExhausted flag. (With no Pinecone key configured in
    // the test env the store then skips as unconfigured — which is fine: the assertion is that
    // the breaker no longer refuses the write path.)
    expect(result.wuExhausted).toBeUndefined();
    expect(result.skipped).toBe(true);
  });
});

describe("sec-ingest clean deferral under the WU breaker", () => {
  beforeEach(async () => {
    const { getDb, deleteInternalSetting, applyVersionedMigrations } = await import("../src/lib/db");
    applyVersionedMigrations(getDb());
    const { PINECONE_WU_EXHAUSTED_UNTIL_KEY } = await loadBreaker();
    deleteInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
    deleteInternalSetting("pinecone:wuGateLastAuditDay");
    mocks.storeDocument.mockReset();
    mocks.alertStorageWarning.mockClear();
    process.env.PINECONE_MONTHLY_WU_BUDGET = "2000000";
  });

  async function makeRunningJobWithTask() {
    const { createSecIngestJob, transitionSecIngestJob, enqueueSecIngestTask } = await import(
      "../src/lib/db-rag-ingest"
    );
    const job = createSecIngestJob({
      idempotencyKey: `wu-${randomUUID()}`,
      corpusRevision: "corp-v1"
    });
    transitionSecIngestJob(job.id, "running");
    const { task } = enqueueSecIngestTask({
      jobId: job.id,
      accession: `0000320193-26-${randomUUID().slice(0, 6)}`,
      cik: "0000320193",
      symbol: "AAPL",
      payload: { url: "https://www.sec.gov/Archives/x.htm", docType: "10-K", filedAt: "2026-07-15" }
    });
    return { jobId: job.id, taskId: task.id };
  }

  it("deferSecIngestTask parks a leased task until the instant and REFUNDS the stage attempt", async () => {
    const { claimSecIngestTasks, deferSecIngestTask, getSecIngestTask } = await import(
      "../src/lib/db-rag-ingest"
    );
    const { jobId } = await makeRunningJobWithTask();
    const [claimed] = claimSecIngestTasks(jobId, { owner: "wu-test", leaseMs: 60_000, limit: 1 });
    expect(claimed).toBeDefined();
    expect(getSecIngestTask(claimed!.id)!.stageAttempts).toBe(1);

    const deferUntil = new Date(Date.now() + 3_600_000).toISOString();
    const res = deferSecIngestTask({
      taskId: claimed!.id,
      owner: "wu-test",
      leaseToken: claimed!.leaseToken!,
      deferUntil,
      reasonType: "wu_exhausted_deferred",
      reason: "Pinecone monthly write units exhausted"
    });
    expect(res).toMatchObject({ applied: true, status: "retry_wait", nextRetryAt: deferUntil });

    const after = getSecIngestTask(claimed!.id)!;
    expect(after.status).toBe("retry_wait");
    expect(after.nextRetryAt).toBe(deferUntil);
    // Deferral is a park, not a failure — the claim's attempt increment is refunded so waiting
    // out the quota can never march the task toward dead_letter.
    expect(after.stageAttempts).toBe(0);

    // Not claimable before the instant; claimable after it.
    expect(claimSecIngestTasks(jobId, { owner: "wu-test", limit: 5 })).toHaveLength(0);
    const later = new Date(Date.parse(deferUntil) + 1_000);
    expect(claimSecIngestTasks(jobId, { owner: "wu-test", limit: 5, now: later })).toHaveLength(1);
  });

  async function advanceTo(jobId: string, taskId: string, checkpoints: Array<[string, string]>) {
    const { claimSecIngestTasks, advanceSecIngestTask } = await import("../src/lib/db-rag-ingest");
    for (const [from, to] of checkpoints) {
      const claimed = claimSecIngestTasks(jobId, { owner: "wu-test", limit: 5 }).find((t) => t.id === taskId);
      expect(claimed, `claim at checkpoint ${from}`).toBeDefined();
      const ok = advanceSecIngestTask({
        taskId,
        owner: "wu-test",
        leaseToken: claimed!.leaseToken!,
        expectedCheckpoint: from as never,
        nextCheckpoint: to as never,
        receipt: {}
      });
      expect(ok, `advance ${from} -> ${to}`).toBe(true);
    }
  }

  const TO_EMBED_QUEUED: Array<[string, string]> = [
    ["discovered", "fetched"],
    ["fetched", "validated"],
    ["validated", "parsed"],
    ["parsed", "facts_extracted"],
    ["facts_extracted", "chunked"],
    ["chunked", "embed_queued"]
  ];

  it("worker parks embed_queued tasks while the breaker is active — storeDocument never called", async () => {
    const { claimSecIngestTasks, getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { SecIngestWorker } = await import("../src/lib/rag/sec-ingest-worker");
    const { tripPineconeWuBreaker } = await loadBreaker();
    const { jobId, taskId } = await makeRunningJobWithTask();
    await advanceTo(jobId, taskId, TO_EMBED_QUEUED);

    const claimed = claimSecIngestTasks(jobId, { owner: "wu-test", limit: 5 }).find((t) => t.id === taskId);
    expect(claimed?.checkpoint).toBe("embed_queued");
    const { until } = await tripPineconeWuBreaker({ message: PROD_WU_ERROR }, Date.now());

    const worker = new SecIngestWorker();
    await worker.processTask(claimed!);

    expect(mocks.storeDocument).not.toHaveBeenCalled();
    const after = getSecIngestTask(taskId)!;
    expect(after.status).toBe("retry_wait");
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.nextRetryAt).toBe(until);
    expect(after.lastErrorType).toBe("wu_exhausted_deferred");
  });

  it("worker defers (not retry-storms) when storeDocument reports wuExhausted mid-call", async () => {
    const { claimSecIngestTasks, getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { SecIngestWorker } = await import("../src/lib/rag/sec-ingest-worker");
    const { writeLocalArtifact } = await import("../src/lib/web-sources/sec-filings");
    const { jobId, taskId } = await makeRunningJobWithTask();
    await advanceTo(jobId, taskId, TO_EMBED_QUEUED);

    const claimed = claimSecIngestTasks(jobId, { owner: "wu-test", limit: 5 }).find((t) => t.id === taskId);
    expect(claimed?.checkpoint).toBe("embed_queued");
    // Artifacts the embed stage reads before storeDocument (marker is NOT active — the trip
    // happens inside the store call in this scenario).
    await writeLocalArtifact(
      claimed!.cik!,
      claimed!.accession,
      1,
      "raw-document.html",
      `<html><body>${"Item 1. Business — enough real content to pass validation. ".repeat(4)}</body></html>`
    );
    await writeLocalArtifact(
      claimed!.cik!,
      claimed!.accession,
      1,
      "sections.json",
      JSON.stringify([{ itemCode: "1", itemTitle: "Business", text: "AAPL makes devices." }])
    );

    const wuUntil = new Date(Date.now() + 24 * 3_600_000).toISOString();
    mocks.storeDocument.mockResolvedValueOnce({
      attempted: 2,
      indexed: 0,
      skipped: true,
      wuExhausted: true,
      wuExhaustedUntil: wuUntil,
      documentComplete: false
    });

    const worker = new SecIngestWorker();
    await worker.processTask(claimed!);

    expect(mocks.storeDocument).toHaveBeenCalledTimes(1);
    const after = getSecIngestTask(taskId)!;
    expect(after.status).toBe("retry_wait");
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.nextRetryAt).toBe(wuUntil);
    expect(after.lastErrorType).toBe("wu_exhausted_deferred");
    // Refunded: still zero consumed stage attempts despite claim + defer.
    expect(after.stageAttempts).toBe(0);
  });
});
