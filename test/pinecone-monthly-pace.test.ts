// Monthly Pinecone write-unit PACE guard — counter month-roll, projection math, budget-off
// no-op, lane scoping (bulk backfill only), and the one-advisory-per-month dedup.
//
// Hermetic: real module graph against a temp SQLite DB; only the notification egress
// (alertStorageWarning) is spied so the dedup is directly assertable.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-wu-pace-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-wu-pace-data-${runId}`);
});

const mocks = vi.hoisted(() => ({
  alertStorageWarning: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../src/lib/db-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-health")>();
  return { ...actual, alertStorageWarning: mocks.alertStorageWarning };
});

async function loadPace() {
  return import("../src/lib/pinecone-monthly-pace");
}

// 2026-08-07T00:00Z — ~19.4% of a 31-day month elapsed, i.e. just under the 0.2 pace floor, so
// the projection multiplier is the floored 5x in these cases (deliberate: the floor is the
// behavior under test in the month-start case).
const AUG_07 = Date.UTC(2026, 7, 7, 0, 0, 0);
// 2026-08-16T12:00Z — exactly half the month elapsed (multiplier 2x).
const AUG_16_NOON = Date.UTC(2026, 7, 16, 12, 0, 0);
const SEP_02 = Date.UTC(2026, 8, 2, 0, 0, 0);

async function auditCount(kind: string): Promise<number> {
  const { getDb } = await import("../src/lib/db");
  const row = getDb().prepare("SELECT COUNT(*) AS cnt FROM audit_events WHERE kind = ?").get(kind) as {
    cnt: number;
  };
  return row.cnt;
}

describe("pinecone monthly write-unit pace guard", () => {
  beforeEach(async () => {
    const { getDb, deleteInternalSetting, applyVersionedMigrations } = await import("../src/lib/db");
    applyVersionedMigrations(getDb());
    const { PINECONE_MONTH_WU_KEY, PINECONE_MONTH_PACE_ADVISED_KEY } = await loadPace();
    deleteInternalSetting(PINECONE_MONTH_WU_KEY);
    deleteInternalSetting(PINECONE_MONTH_PACE_ADVISED_KEY);
    getDb().prepare("DELETE FROM audit_events").run();
    delete process.env.PINECONE_MONTHLY_WU_BUDGET;
    mocks.alertStorageWarning.mockClear();
  });

  // ── counter ────────────────────────────────────────────────────────────────

  it("accumulates write units within a month and RESETS on the calendar-month roll", async () => {
    const { recordPineconeWriteUnits, pineconeMonthToDateWriteUnits, pineconeMonthKey } = await loadPace();

    expect(pineconeMonthKey(AUG_07)).toBe("2026-08");
    expect(recordPineconeWriteUnits(1_000, AUG_07)).toBe(1_000);
    expect(recordPineconeWriteUnits(500, AUG_16_NOON)).toBe(1_500);
    expect(pineconeMonthToDateWriteUnits(AUG_16_NOON)).toBe(1_500);

    // September reads zero WITHOUT any explicit reset step — a stale row simply stops counting.
    expect(pineconeMonthToDateWriteUnits(SEP_02)).toBe(0);
    // ...and the next September write starts a fresh total rather than adding to August's.
    expect(recordPineconeWriteUnits(42, SEP_02)).toBe(42);
    expect(pineconeMonthToDateWriteUnits(SEP_02)).toBe(42);
  });

  it("ignores non-positive / non-finite unit counts", async () => {
    const { recordPineconeWriteUnits, pineconeMonthToDateWriteUnits } = await loadPace();
    recordPineconeWriteUnits(100, AUG_07);
    expect(recordPineconeWriteUnits(0, AUG_07)).toBe(100);
    expect(recordPineconeWriteUnits(-5, AUG_07)).toBe(100);
    expect(recordPineconeWriteUnits(Number.NaN, AUG_07)).toBe(100);
    expect(pineconeMonthToDateWriteUnits(AUG_07)).toBe(100);
  });

  // ── projection math ────────────────────────────────────────────────────────

  it("projects month-end linearly, with the elapsed-fraction floor taming month-start bursts", async () => {
    const { assessPineconeWuPace, PINECONE_PACE_ELAPSED_FLOOR } = await loadPace();

    // Half the month gone, 400k used against a 1M budget -> projected 800k, under budget.
    const half = assessPineconeWuPace({ mtd: 400_000, budget: 1_000_000, now: AUG_16_NOON });
    expect(half.elapsedFraction).toBeCloseTo(0.5, 3);
    expect(Math.round(half.projected)).toBe(800_000);
    expect(half.projectedPct).toBeCloseTo(80, 1);
    expect(half.exceeded).toBe(false);

    // Same date, 600k used -> projected 1.2M, over budget.
    const hot = assessPineconeWuPace({ mtd: 600_000, budget: 1_000_000, now: AUG_16_NOON });
    expect(Math.round(hot.projected)).toBe(1_200_000);
    expect(hot.exceeded).toBe(true);

    // Day 7 of a 31-day month is under the 0.2 floor: the multiplier is capped at 5x, NOT the
    // ~5.2x the raw elapsed fraction would give.
    const early = assessPineconeWuPace({ mtd: 100_000, budget: 1_000_000, now: AUG_07 });
    expect(early.elapsedFraction).toBeLessThan(PINECONE_PACE_ELAPSED_FLOOR);
    expect(Math.round(early.projected)).toBe(500_000);
    expect(early.exceeded).toBe(false);
  });

  it("flags an already-spent budget even when the late-month projection dips back under", async () => {
    const { assessPineconeWuPace } = await loadPace();
    // 96.8% of the month elapsed; 1.0M used against a 1M budget projects to ~1.033M but the
    // decisive fact is that the budget is already gone.
    const late = assessPineconeWuPace({ mtd: 1_000_000, budget: 1_000_000, now: Date.UTC(2026, 7, 31, 0, 0, 0) });
    expect(late.pctUsed).toBeCloseTo(100, 5);
    expect(late.exceeded).toBe(true);
  });

  // ── budget off = complete no-op ────────────────────────────────────────────

  it("Standard trial keeps the monthly pace OFF even when env still holds the Starter 2M cap", async () => {
    const { pineconeMonthlyWuBudget, pineconeBackfillPaceGate, recordPineconeWriteUnits } = await loadPace();
    process.env.PINECONE_TRIAL_ENDS_AT = "2026-08-30T00:00:00.000Z";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    process.env.PINECONE_MONTHLY_WU_BUDGET = "2000000";
    recordPineconeWriteUnits(15_000_000, AUG_16_NOON);
    expect(pineconeMonthlyWuBudget(AUG_16_NOON)).toBe(0);
    const gate = await pineconeBackfillPaceGate("backfill", AUG_16_NOON);
    expect(gate.throttled).toBe(false);
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
  });

  it("budget unset/0/garbage = OFF: never enabled, never exceeded, never throttles", async () => {
    const { assessPineconeWuPace, pineconeMonthlyWuBudget, pineconeBackfillPaceGate, recordPineconeWriteUnits } =
      await loadPace();

    expect(pineconeMonthlyWuBudget()).toBe(0);
    process.env.PINECONE_MONTHLY_WU_BUDGET = "0";
    expect(pineconeMonthlyWuBudget()).toBe(0);
    process.env.PINECONE_MONTHLY_WU_BUDGET = "not-a-number";
    expect(pineconeMonthlyWuBudget()).toBe(0);
    process.env.PINECONE_MONTHLY_WU_BUDGET = "-500";
    expect(pineconeMonthlyWuBudget()).toBe(0);

    // Wildly over any plausible plan, but with no budget there is nothing to exceed.
    recordPineconeWriteUnits(50_000_000, AUG_07);
    const off = assessPineconeWuPace({ mtd: 50_000_000, budget: 0, now: AUG_07 });
    expect(off.enabled).toBe(false);
    expect(off.exceeded).toBe(false);
    expect(off.pctUsed).toBe(0);
    expect(off.projectedPct).toBe(0);

    const gate = await pineconeBackfillPaceGate("backfill", AUG_07);
    expect(gate.throttled).toBe(false);
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
  });

  it("keeps counting month-to-date units while the budget is off (the trial-sizing number)", async () => {
    const { recordPineconeWriteUnits, pineconeWuPaceState } = await loadPace();
    recordPineconeWriteUnits(123_456, AUG_16_NOON);
    const state = pineconeWuPaceState(AUG_16_NOON);
    expect(state.enabled).toBe(false);
    expect(state.mtd).toBe(123_456);
  });

  // ── lane scoping ───────────────────────────────────────────────────────────

  it("throttles the BACKFILL lane only — incremental ingest and retrieval are never paced off", async () => {
    const { recordPineconeWriteUnits, pineconeBackfillPaceGate } = await loadPace();
    process.env.PINECONE_MONTHLY_WU_BUDGET = "1000000";
    recordPineconeWriteUnits(900_000, AUG_16_NOON); // projects to 1.8M

    const incremental = await pineconeBackfillPaceGate("incremental", AUG_16_NOON);
    const retrieval = await pineconeBackfillPaceGate("retrieval", AUG_16_NOON);
    expect(incremental.throttled).toBe(false);
    expect(retrieval.throttled).toBe(false);
    // Non-backfill lanes must not even emit the advisory — they are not the thing being paused.
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();

    const backfill = await pineconeBackfillPaceGate("backfill", AUG_16_NOON);
    expect(backfill.throttled).toBe(true);
    expect(backfill.pace.exceeded).toBe(true);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);
  });

  it("does not throttle backfill while the month-end projection is inside the budget", async () => {
    const { recordPineconeWriteUnits, pineconeBackfillPaceGate } = await loadPace();
    process.env.PINECONE_MONTHLY_WU_BUDGET = "1000000";
    recordPineconeWriteUnits(400_000, AUG_16_NOON); // projects to 800k
    const gate = await pineconeBackfillPaceGate("backfill", AUG_16_NOON);
    expect(gate.throttled).toBe(false);
    expect(mocks.alertStorageWarning).not.toHaveBeenCalled();
  });

  // ── one-advisory dedup ─────────────────────────────────────────────────────

  it("emits ONE advisory + ONE audit row per calendar month, and re-arms after the month rolls", async () => {
    const { recordPineconeWriteUnits, pineconeBackfillPaceGate } = await loadPace();
    process.env.PINECONE_MONTHLY_WU_BUDGET = "1000000";
    recordPineconeWriteUnits(900_000, AUG_16_NOON);

    for (let i = 0; i < 5; i++) {
      const gate = await pineconeBackfillPaceGate("backfill", AUG_16_NOON + i * 5_000);
      expect(gate.throttled).toBe(true);
    }
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);
    expect(mocks.alertStorageWarning.mock.calls[0]![0]).toBe("pinecone_monthly_wu_pace");
    expect(String(mocks.alertStorageWarning.mock.calls[0]![1])).toContain("Bulk RAG backfill is paused");
    expect(String(mocks.alertStorageWarning.mock.calls[0]![1])).toContain("retrieval are unaffected");
    expect(await auditCount("pinecone_wu_pace_throttle")).toBe(1);

    // New month: counter reset means the throttle lifts on its own...
    const septFresh = await pineconeBackfillPaceGate("backfill", SEP_02);
    expect(septFresh.throttled).toBe(false);
    // ...and if September also runs hot, that month gets its own single advisory.
    recordPineconeWriteUnits(900_000, SEP_02 + 14 * 24 * 3_600_000);
    const septHot = await pineconeBackfillPaceGate("backfill", SEP_02 + 14 * 24 * 3_600_000);
    expect(septHot.throttled).toBe(true);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(2);
    expect(await auditCount("pinecone_wu_pace_throttle")).toBe(2);
  });
});

describe("sec ingest backfill worker under the pace guard", () => {
  beforeEach(async () => {
    const { getDb, deleteInternalSetting, applyVersionedMigrations } = await import("../src/lib/db");
    applyVersionedMigrations(getDb());
    const { PINECONE_MONTH_WU_KEY, PINECONE_MONTH_PACE_ADVISED_KEY } = await loadPace();
    deleteInternalSetting(PINECONE_MONTH_WU_KEY);
    deleteInternalSetting(PINECONE_MONTH_PACE_ADVISED_KEY);
    delete process.env.PINECONE_MONTHLY_WU_BUDGET;
    mocks.alertStorageWarning.mockClear();
  });

  async function makeRunningJobWithTask() {
    const { createSecIngestJob, transitionSecIngestJob, enqueueSecIngestTask } = await import(
      "../src/lib/db-rag-ingest"
    );
    const job = createSecIngestJob({ idempotencyKey: `pace-${randomUUID()}`, corpusRevision: "corp-v1" });
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

  it("claims NO new tasks while paced-throttled, and resumes when the budget is lifted", async () => {
    const { SecIngestWorker } = await import("../src/lib/rag/sec-ingest-worker");
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { recordPineconeWriteUnits } = await loadPace();
    const { taskId } = await makeRunningJobWithTask();

    process.env.PINECONE_MONTHLY_WU_BUDGET = "1000";
    recordPineconeWriteUnits(5_000); // whatever the day of the month, 5x the budget is over pace

    const worker = new SecIngestWorker();
    await worker.runTick();
    // Untouched: still queued at its first checkpoint with zero consumed stage attempts. A
    // throttled tick must not claim, defer, or fail anything.
    const parked = getSecIngestTask(taskId)!;
    expect(parked.status).toBe("pending");
    expect(parked.checkpoint).toBe("discovered");
    expect(parked.stageAttempts).toBe(0);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);

    // Owner raises the budget (or drops it to 0): the queue picks straight back up. Stub fetch
    // with a deterministic NON-403 failure so the claim burns a stage attempt on every host:
    // unstubbed, this reached real EDGAR — 404 on a dev Mac (fail path, attempt kept) but 403 on
    // GitHub's datacenter IPs, which the worker now DEFERS with an attempt refund, so the
    // assertion below flapped by network vantage. What matters is that the task was CLAIMED.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("hermetic: no network")));
    try {
      delete process.env.PINECONE_MONTHLY_WU_BUDGET;
      await worker.runTick();
    } finally {
      vi.unstubAllGlobals();
    }
    const resumed = getSecIngestTask(taskId)!;
    expect(resumed.stageAttempts).toBeGreaterThan(0);
  });
});
