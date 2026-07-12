import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-acctdel-${randomUUID()}.db`)}`;
});

describe("deleteConnectedAccount — FK pragma + cascade cleanup", () => {
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

    expect(db.deleteConnectedAccount(accId, "local")).toBe(true);

    // All purged.
    expect(db.listFillEvents(acct, "live", 10, "local")).toHaveLength(0);
    expect(db.listPortfolioSnapshots(acct, "live", 10, "local")).toHaveLength(0);
    expect(db.getProposal(pid, "local")).toBeFalsy();
    expect(db.listSyntheticStops(acct, "local")).toHaveLength(0);
  });

  it("returns false for a non-existent account and touches nothing", async () => {
    const { deleteConnectedAccount } = await import("../src/lib/db");
    expect(deleteConnectedAccount("does-not-exist", "local")).toBe(false);
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

    expect(db.deleteConnectedAccount(accId, "local")).toBe(true);
    expect(db.listLearningMutations("local", { connectedAccountId: accId }).length).toBe(0);
  });
});
