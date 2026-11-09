import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-acctdel-${randomUUID()}.db`)}`;
});

describe("purgeConnectedAccount — FK pragma + cascade cleanup", () => {
  it("enables foreign_keys enforcement", async () => {
    const { getDb } = await import("../src/lib/db");
    expect(Number(getDb().pragma("foreign_keys", { simple: true }))).toBe(1);
  });

  it("purges the account's fills/snapshots/proposals/stops when the account is deleted", async () => {
    const db = await import("../src/lib/db");
    const acct = "DELME";
    const accId = randomUUID();
    db.upsertConnectedAccount({
      id: accId, userId: "local", broker: "alpaca", environment: "paper",
      accountNumber: acct, label: "x", isActive: true
    });
    db.insertFillEvent({ accountNumber: acct, source: "live", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled" });
    db.insertPortfolioSnapshot({ accountNumber: acct, source: "live", equity: 100, cash: 0, buyingPower: 0, positionsValue: 100, positions: [] });
    const pid = randomUUID();
    db.insertProposal({ id: pid, userId: "local", runId: "r1", accountNumber: acct, proposal: { side: "buy", symbol: "AAPL" } as never, decision: { approved: true, reasons: [] }, status: "proposed" });
    db.upsertSyntheticStop({ id: randomUUID(), userId: "local", accountNumber: acct, symbol: "AAPL", side: "long", quantity: 1, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active" });

    // Sanity: all dependent rows exist.
    expect(db.listFillEvents(acct, "live", 10, "local")).toHaveLength(1);
    expect(db.listPortfolioSnapshots(acct, "live", 10, "local")).toHaveLength(1);
    expect(db.getProposal(pid, "local")).toBeTruthy();
    expect(db.listSyntheticStops(acct, "local")).toHaveLength(1);

    expect(db.purgeConnectedAccount(accId, "local")).toBe(true);

    // All purged.
    expect(db.listFillEvents(acct, "live", 10, "local")).toHaveLength(0);
    expect(db.listPortfolioSnapshots(acct, "live", 10, "local")).toHaveLength(0);
    expect(db.getProposal(pid, "local")).toBeFalsy();
    expect(db.listSyntheticStops(acct, "local")).toHaveLength(0);
  });

  it("returns false for a non-existent account and touches nothing", async () => {
    const { purgeConnectedAccount } = await import("../src/lib/db");
    expect(purgeConnectedAccount("does-not-exist", "local")).toBe(false);
  });

  // Codex review, PR #1371: account deletion must purge the account's per-position stop plans, or a
  // connected account removed and later re-added with the same broker account number could have an
  // old "none"/"trailing"/fixed/ATR plan silently reappear and govern a brand-new position.
  it("purges the account's position_stop_plans rows when the account is deleted", async () => {
    const db = await import("../src/lib/db");
    const acct = "STOPPLANDEL";
    const accId = randomUUID();
    db.upsertConnectedAccount({
      id: accId, userId: "local", broker: "alpaca", environment: "paper",
      accountNumber: acct, label: "x", isActive: true
    });
    db.recordStopPlan(acct, "AAPL", "none", "high-conviction hold", 100, "local");
    expect(db.getStopPlans(acct, "local")).toHaveProperty("AAPL");

    expect(db.purgeConnectedAccount(accId, "local")).toBe(true);
    expect(db.getStopPlans(acct, "local")).not.toHaveProperty("AAPL");
  });

  // Codex finding #8: account deletion must purge the account's learning-mutation ledger rows.
  it("purges the account's learning_mutations ledger rows when the account is deleted", async () => {
    const db = await import("../src/lib/db");
    const acct = "LEDGERDEL";
    const accId = randomUUID();
    db.upsertConnectedAccount({
      id: accId, userId: "local", broker: "alpaca", environment: "paper",
      accountNumber: acct, label: "x", isActive: true
    });
    db.insertLearningMutation({
      userId: "local", connectedAccountId: accId, subsystem: "scoring_weights",
      beforeState: { scoringWeights: { a: 1 } }, afterState: { scoringWeights: { a: 2 } }
    });
    expect(db.listLearningMutations("local", { connectedAccountId: accId }).length).toBe(1);

    expect(db.purgeConnectedAccount(accId, "local")).toBe(true);
    expect(db.listLearningMutations("local", { connectedAccountId: accId }).length).toBe(0);
  });

  // Codex review, PR #1738: account deletion must also purge the per-account option-alert dedupe
  // reservations, or a removed account's alert claims linger indefinitely (the row it dedupes,
  // notification_events, is already purged).
  it("purges the account's option_alert_reservations when the account is deleted", async () => {
    const db = await import("../src/lib/db");
    const acct = "OPTALERTDEL";
    const accId = randomUUID();
    db.upsertConnectedAccount({
      id: accId, userId: "local", broker: "alpaca", environment: "paper",
      accountNumber: acct, label: "x", isActive: true
    });
    expect(db.reserveOptionAlert("local", accId, "AAPL240101C00100000", "appearance")).toBe(true);
    // Sanity: the reservation now blocks a second claim.
    expect(db.reserveOptionAlert("local", accId, "AAPL240101C00100000", "appearance")).toBe(false);

    expect(db.purgeConnectedAccount(accId, "local")).toBe(true);
    // After purge the row is gone, so the claim is free again.
    expect(db.reserveOptionAlert("local", accId, "AAPL240101C00100000", "appearance")).toBe(true);
  });
});
