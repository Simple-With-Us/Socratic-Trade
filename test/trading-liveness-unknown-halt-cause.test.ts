import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// The fleet-dark decision and the halt-cause read it depends on.
//
// A halt whose cause could NOT be read is an UNKNOWN cause, not a confirmed owner stop.  This
// file pins that distinction: the confirmed count keeps its contract, the degradation is
// published, and the page decision is unchanged by the split.
//
// Its own database, so the counts here are exact: the fleet-wide DB the other liveness tests
// share would put other accounts' idleness into every number below.

const dir = mkdtempSync(join(tmpdir(), "agentic-liveness-unknown-halt-"));
// This file's own database and key.  Both are process-wide, so the previous values are put back
// after the file: a later test in the same worker must not query this file's database.
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "b".repeat(64);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  restoreEnv("DATABASE_URL", previousDatabaseUrl);
  restoreEnv("ENCRYPTION_KEY", previousEncryptionKey);
});

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

  // Runs first, so the fleet is this one account.  It is retired from the fleet at the end, so
  // the next case's counts stay exact.
  it("decides the page by the named unknown-as-idle policy when the unknown cause is the whole fleet", async () => {
    const liveness = await import("../src/lib/trading-liveness");
    const causes = await import("../src/lib/autonomy-halt-cause");
    const db = await import("../src/lib/db");
    const alone = await seedHaltedAccount("Unreadable Alone");
    const key = `${alone.userId}:${alone.accountId}`;

    let invocations = 0;
    const previous = causes.__setHaltAuditRunnerForTests(async () => {
      invocations += 1;
      throw new Error("off-loop read failed");
    });
    try {
      const summary = await liveness.getTradingLivenessSummary();
      // Control: the injected failing read is the one that ran, once.
      expect(invocations).toBe(1);
      const batch = await causes.batchedHaltCauseKinds([
        { userId: alone.userId, accountId: alone.accountId, accountNumber: db.getPolicy(alone.userId, alone.accountId).accountNumber ?? "" }
      ]);
      expect(batch.unknown.has(key)).toBe(true);
      if (liveness.HALT_CAUSE_UNKNOWN_COUNTS_AS_IDLE) {
        // Unknown counts toward idleness for the page, so an all-unknown fleet does not page --
        // and the summary is null because nothing else is wrong.
        expect(summary?.darkness?.fullyDark ?? false).toBe(false);
      } else {
        expect(summary?.darkness?.fullyDark).toBe(true);
      }
      // Whatever the policy, the unknown cause is never a confirmed owner stop.
      expect(summary?.darkness?.eligibleDeliberatelyIdle ?? 0).toBe(0);
    } finally {
      causes.__setHaltAuditRunnerForTests(previous);
      // Retire it: ask-first authority is neither eligible nor active.
      db.setPolicy(
        { ...db.getPolicy(alone.userId, alone.accountId), strategyAuthority: "propose", systemState: "halted" },
        alone.userId,
        alone.accountId
      );
    }
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
