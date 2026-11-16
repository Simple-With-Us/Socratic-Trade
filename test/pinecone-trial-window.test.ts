import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pinecone-trial-${randomUUID()}.db`)}`;
});

const mocks = vi.hoisted(() => ({
  alertStorageWarning: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../src/lib/db-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-health")>();
  return { ...actual, alertStorageWarning: mocks.alertStorageWarning };
});

async function load() {
  return import("../src/lib/pinecone-trial-window");
}

const AUG_16 = Date.UTC(2026, 7, 16, 19, 30, 0);
const AUG_30 = Date.UTC(2026, 7, 30, 0, 0, 0);
const SEP_01 = Date.UTC(2026, 8, 1, 0, 0, 0);

describe("pinecone trial window", () => {
  beforeEach(async () => {
    const { getDb, deleteInternalSetting, applyVersionedMigrations } = await import("../src/lib/db");
    applyVersionedMigrations(getDb());
    const { PINECONE_TRIAL_ROLLED_BACK_KEY } = await load();
    deleteInternalSetting(PINECONE_TRIAL_ROLLED_BACK_KEY);
    delete process.env.PINECONE_TRIAL_ENDS_AT;
    delete process.env.PINECONE_TRIAL_CREDIT_USD;
    delete process.env.PINECONE_WU_USD_PER_MILLION;
    delete process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY;
    delete process.env.RAG_INGEST_MAX_TEXTS_PER_DAY;
    delete process.env.PINECONE_MONTHLY_WU_BUDGET;
    mocks.alertStorageWarning.mockClear();
  });

  it("does not treat a normal 200k fuse as this trial", async () => {
    const { assessPineconeTrialWindow } = await load();
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: 2_500_000,
      configuredDailyWriteUnits: 200_000,
      configuredTextsPerDay: 20_000,
      configuredMonthlyWriteUnits: 0
    });
    expect(state.mode).toBe("configured");
    expect(state.active).toBe(false);
    expect(state.effectiveDailyWriteUnits).toBe(200_000);
  });

  it("defaults the implied trial calendar to 2026-08-27 (7 days from 2026-08-19)", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { pineconeTrialEndsAtMs, pineconeTrialRemainingDays, PINECONE_CURRENT_TRIAL_ENDS_AT } =
      await load();
    expect(PINECONE_CURRENT_TRIAL_ENDS_AT).toBe("2026-08-27T00:00:00.000Z");
    const now = Date.UTC(2026, 7, 20, 2, 59, 0); // 2026-08-19 21:59 CT
    expect(pineconeTrialEndsAtMs(now)).toBe(Date.parse("2026-08-27T00:00:00.000Z"));
    expect(pineconeTrialRemainingDays(now)).toBe(7);
  });

  it("paces remaining trial dollars across remaining days instead of a flat 2.5M fuse", async () => {
    process.env.PINECONE_TRIAL_ENDS_AT = "2026-08-30T00:00:00.000Z";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { assessPineconeTrialWindow } = await load();
    // $62 of write-units already delivered (~15.5M WU at $4/M) with 14 days left.
    const spentWu = Math.round((62 / 4) * 1_000_000);
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: spentWu,
      configuredDailyWriteUnits: 2_500_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 0
    });
    expect(state.active).toBe(true);
    expect(state.mode).toBe("trial");
    expect(state.remainingDays).toBe(14);
    expect(state.remainingUsd).toBeCloseTo(238, 0);
    expect(state.phase).toBe("full-steam");
    expect(state.effectiveDailyWriteUnits).toBeGreaterThan(2_500_000);
    expect(state.effectiveDailyWriteUnits).toBe(Math.floor(state.remainingWriteUnits / 14));
    expect(state.effectiveTextsPerDay).toBe(250_000);
    expect(state.effectiveMonthlyWriteUnits).toBe(0);
  });

  it("ignores a leftover Starter 2M monthly budget while the Standard trial is active", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { assessPineconeTrialWindow } = await load();
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: 5_000_000,
      configuredDailyWriteUnits: 2_500_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 2_000_000
    });
    expect(state.active).toBe(true);
    expect(state.mode).toBe("trial");
    expect(state.effectiveMonthlyWriteUnits).toBe(0);
  });

  it("stays full-steam at the configured 2.5M fuse when remaining credit is still above the $45 reserve", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { assessPineconeTrialWindow } = await load();
    // $80 remaining over 14 days would pace to ~1.4M WU/day — do not throttle yet.
    const spentWu = Math.round(((300 - 80) / 4) * 1_000_000);
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: spentWu,
      configuredDailyWriteUnits: 2_500_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 0
    });
    expect(state.remainingUsd).toBeCloseTo(80, 0);
    expect(state.phase).toBe("full-steam");
    expect(state.effectiveDailyWriteUnits).toBe(2_500_000);
  });

  it("paces the last ~$45 so the trial finishes instead of dumping the reserve in one day", async () => {
    process.env.PINECONE_TRIAL_ENDS_AT = "2026-08-30T00:00:00.000Z";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { assessPineconeTrialWindow } = await load();
    const spentWu = Math.round(((300 - 45) / 4) * 1_000_000);
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: spentWu,
      configuredDailyWriteUnits: 2_500_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 0
    });
    expect(state.remainingUsd).toBeCloseTo(45, 0);
    expect(state.phase).toBe("finish");
    expect(state.effectiveDailyWriteUnits).toBe(Math.floor(state.remainingWriteUnits / 14));
    expect(state.effectiveDailyWriteUnits).toBeLessThan(2_500_000);
  });

  it("honors a 5M Builder monthly budget while the trial is still open", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "5000000";
    const { assessPineconeTrialWindow } = await load();
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: 1_000_000,
      configuredDailyWriteUnits: 5_000_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 5_000_000
    });
    expect(state.active).toBe(true);
    expect(state.mode).toBe("trial");
    expect(state.effectiveMonthlyWriteUnits).toBe(5_000_000);
  });

  it("snaps leftover trial Infisical knobs to free-tier when the calendar ends", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "5000000";
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "250000";
    const { assessPineconeTrialWindow, PINECONE_FREE_TIER_WU_PER_DAY, PINECONE_FREE_TIER_TEXTS_PER_DAY, PINECONE_FREE_TIER_MONTHLY_WU } = await load();
    const state = assessPineconeTrialWindow({
      now: AUG_30,
      mtdWriteUnits: 20_000_000,
      configuredDailyWriteUnits: 5_000_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 5_000_000
    });
    expect(state.active).toBe(false);
    expect(state.mode).toBe("free");
    expect(state.effectiveDailyWriteUnits).toBe(PINECONE_FREE_TIER_WU_PER_DAY);
    expect(state.effectiveTextsPerDay).toBe(PINECONE_FREE_TIER_TEXTS_PER_DAY);
    expect(state.effectiveMonthlyWriteUnits).toBe(PINECONE_FREE_TIER_MONTHLY_WU);
  });

  it("honors PINECONE_TRIAL_ENDS_AT=off", async () => {
    process.env.PINECONE_TRIAL_ENDS_AT = "off";
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { assessPineconeTrialWindow, pineconeTrialEndsAtMs } = await load();
    expect(pineconeTrialEndsAtMs(SEP_01)).toBeNull();
    const state = assessPineconeTrialWindow({
      now: SEP_01,
      mtdWriteUnits: 0,
      configuredDailyWriteUnits: 2_500_000,
      configuredTextsPerDay: 250_000,
      configuredMonthlyWriteUnits: 0
    });
    expect(state.mode).toBe("configured");
    expect(state.effectiveDailyWriteUnits).toBe(2_500_000);
  });

  it("does not collapse the daily fuse to a remainder smaller than one document when local MTD says the trial is spent", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    const { assessPineconeTrialWindow, PINECONE_MIN_USABLE_DAILY_WU, PINECONE_MIN_USABLE_TEXTS_PER_DAY } = await load();
    // Local counter implying ~$300 spent (75M WU at $4/M) produced the live card
    // "used 0 of 15 estimated WUs, attempted 28, skipped 1".
    const state = assessPineconeTrialWindow({
      now: AUG_16,
      mtdWriteUnits: 75_000_000,
      configuredDailyWriteUnits: 2_500_000,
      configuredTextsPerDay: 1,
      configuredMonthlyWriteUnits: 2_000_000
    });
    expect(state.active).toBe(true);
    expect(state.mode).toBe("trial");
    expect(state.localMtdUntrusted).toBe(true);
    expect(state.phase).toBe("full-steam");
    expect(state.effectiveDailyWriteUnits).toBe(2_500_000);
    expect(state.effectiveDailyWriteUnits).toBeGreaterThan(PINECONE_MIN_USABLE_DAILY_WU);
    expect(state.effectiveTextsPerDay).toBe(PINECONE_MIN_USABLE_TEXTS_PER_DAY);
    expect(state.effectiveMonthlyWriteUnits).toBe(0);
  });

  it("advises the free-tier rollback once when the calendar ends", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "5000000";
    const { maybeAdvisePineconeTrialRollback } = await load();
    expect(await maybeAdvisePineconeTrialRollback(AUG_30, 1)).toBe(true);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);
    expect(await maybeAdvisePineconeTrialRollback(AUG_30, 1)).toBe(false);
    expect(mocks.alertStorageWarning).toHaveBeenCalledTimes(1);
  });
});
