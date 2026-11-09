import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

const tuningMocks = vi.hoisted(() => ({
  applyAutonomousWeightTuning: vi.fn()
}));

vi.mock("../src/lib/strategy-tuning", () => ({
  applyAutonomousWeightTuning: tuningMocks.applyAutonomousWeightTuning
}));

let db: typeof import("../src/lib/db");
let maybeAutoTuneWeights: typeof import("../src/lib/auto-tune-scheduler").maybeAutoTuneWeights;

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-auto-tune-lease-${randomUUID()}.db`)}`;
  db = await import("../src/lib/db");
  ({ maybeAutoTuneWeights } = await import("../src/lib/auto-tune-scheduler"));
});

beforeEach(() => {
  tuningMocks.applyAutonomousWeightTuning.mockReset().mockResolvedValue({ applied: false, reason: "no_validated_weight_changes" });
});

function seedAccount(userId: string, accountId: string, accountNumber: string, isActive: boolean): void {
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber,
    label: accountNumber,
    isActive
  });
  db.setPolicy({
    ...DEFAULT_POLICY,
    connectedAccountId: accountId,
    accountNumber,
    tuning: { autoApplyWeights: true }
  }, userId, accountId);
}

describe("account-scoped auto-tune lease", () => {
  it("refuses to overlap an existing strategy owner on the same account", async () => {
    const userId = `busy-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    seedAccount(userId, accountId, "BUSY", true);
    expect(db.acquireStrategyLock("existing-run", userId, accountId)).toBe(true);

    const result = await maybeAutoTuneWeights(userId, Date.now(), accountId);

    expect(result).toEqual({ ran: false, skippedReason: "account_busy" });
    expect(tuningMocks.applyAutonomousWeightTuning).not.toHaveBeenCalled();
    db.releaseStrategyLock("existing-run", userId, accountId);
  });

  it("stays bound to the scheduled account even when another account is active", async () => {
    const userId = `bound-${randomUUID()}`;
    const activeAccountId = `active-${randomUUID()}`;
    const scheduledAccountId = `scheduled-${randomUUID()}`;
    seedAccount(userId, activeAccountId, "ACTIVE", true);
    seedAccount(userId, scheduledAccountId, "SCHEDULED", false);
    db.setActiveConnectedAccount(activeAccountId, userId);
    const now = Date.now();
    tuningMocks.applyAutonomousWeightTuning.mockImplementationOnce(async (_user, _model, _account, assertOwned) => {
      expect(() => assertOwned()).not.toThrow();
      return { applied: false, reason: "no_validated_weight_changes" };
    });

    const result = await maybeAutoTuneWeights(userId, now, scheduledAccountId);

    expect(result.ran).toBe(true);
    expect(tuningMocks.applyAutonomousWeightTuning).toHaveBeenCalledTimes(1);
    const [calledUser, modelOverride, calledAccount, assertOwned] = tuningMocks.applyAutonomousWeightTuning.mock.calls[0];
    expect([calledUser, modelOverride, calledAccount]).toEqual([userId, undefined, scheduledAccountId]);
    expect(assertOwned).toEqual(expect.any(Function));
    expect(db.getInternalSetting(`last_auto_tune_at:${userId}:${scheduledAccountId}`)).toBe(now);
    expect(db.getInternalSetting(`last_auto_tune_at:${userId}:${activeAccountId}`)).toBeUndefined();
  });
});
