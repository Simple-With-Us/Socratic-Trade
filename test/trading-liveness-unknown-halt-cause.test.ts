import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The fleet-dark decision and the halt-cause read it depends on.
//
// A halt whose cause could NOT be read is an UNKNOWN cause, not a confirmed owner stop.  This
// file pins that distinction: the confirmed count keeps its contract, the degradation is
// published, and the page decision is unchanged by the split.
//
// Its own database, so the counts here are exact: the fleet-wide DB the other liveness tests
// share would put other accounts' idleness into every number below.

const dir = mkdtempSync(join(tmpdir(), "agentic-liveness-unknown-halt-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "b".repeat(64);

async function seedHaltedAccount(label: string): Promise<{ userId: string; accountId: string }> {
  const db = await import("../src/lib/db");
  const userId = `liveness-unknown-${randomUUID()}`;
  const accountId = `acct-${randomUUID()}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: `ACC-${randomUUID().slice(0, 8)}`,
    label,
    isActive: true
  });
  const policy = db.getPolicy(userId, accountId);
  db.setPolicy({ ...policy, strategyAuthority: "decide", systemState: "halted" }, userId, accountId);
  return { userId, accountId };
}

describe("a halt cause that could not be read", () => {
  afterEach(async () => {
    // The read's failure bookkeeping, its cooldown and the shared read state are process-wide, so
    // a case that makes the read fail must not leave any of them behind for the next case.
    const causes = await import("../src/lib/autonomy-halt-cause");
    causes.__resetHaltAuditReadFailureForTests();
    causes.__resetHaltAuditStateForTests();
  });

  it("is not a confirmed owner stop, and it does not suppress the fleet-dark page", async () => {
    const liveness = await import("../src/lib/trading-liveness");
    const causes = await import("../src/lib/autonomy-halt-cause");

    // One account the app halted (a boot receipt): an app halt, so the fleet is dark and the
    // page fires.  One account whose cause cannot be read: an unknown cause.
    const appHalted = await seedHaltedAccount("App Halted");
    causes.recordBootHaltReceipt(appHalted.userId, appHalted.accountId, {
      at: "2026-10-14T18:00:00.000Z",
      from: "active"
    });
    await seedHaltedAccount("Unreadable");

    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      throw new Error("off-loop read failed");
    });
    try {
      const summary = await liveness.getTradingLivenessSummary();
      expect(summary).not.toBeNull();

      // The cause could not be read, so it is UNKNOWN: counted as an unknown cause.
      expect(summary!.darkness?.haltCauseUnknown).toBe(1);
      // It is NOT a confirmed owner stop.  The confirmed count is "the owner left this account
      // idle", and a read that failed is not that: folding the unknown in made a degraded probe
      // read as deliberate owner idleness.
      expect(summary!.darkness?.eligibleDeliberatelyIdle).toBe(0);
      // The page still fires: the app-halted account is not idle, and the unknown cause does not
      // stand in for the confirmed idleness of the other one.
      expect(summary!.darkness?.fullyDark).toBe(true);

      // The degradation is published, so the blind spot is measurable from outside.
      const publicAgg = liveness.toPublicTradingLiveness(summary!);
      expect(publicAgg.autonomyHaltCauseUnknown).toBe(1);
      expect(publicAgg.autonomyHaltCauseReadFailures).toBe(1);
      expect(publicAgg.autonomyFullyDark).toBe(true);

      // Control: the injected runner is the one the read used, and it was used once.
      expect(invocations).toBe(1);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
    }
  });
});
