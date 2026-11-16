import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-execution-mode-${randomUUID()}.db`)}`;
});

describe("execution mode persistence", () => {
  it("round-trips executionMode across proposals, claims, fills, and snapshots", async () => {
    const db = await import("../src/lib/db");
    const proposalId = randomUUID();
    const placingProposalId = randomUUID();
    const accountNumber = "APCA-PAPER-PERSIST";
    const proposal = {
      symbol: "AAPL",
      side: "buy" as const,
      type: "market" as const,
      dollarAmount: 100,
      timeInForce: "gfd" as const,
      marketHours: "regular_hours" as const,
      rationale: "test",
      tradeThesisTag: "test",
      entryMarketRegime: "test"
    };
    const decision = { approved: true, reasons: [] };
    const review = { estimatedNotional: 100, alerts: [], raw: {} };

    db.insertProposal({
      id: proposalId,
      runId: "run-mode-1",
      accountNumber,
      proposal,
      decision,
      review,
      estimatedNotional: 100,
      status: "proposed",
      executionMode: "broker/paper"
    });
    db.upsertSocraticDecisionCase({
      id: proposalId,
      proposalId,
      runId: "run-mode-1",
      accountNumber,
      symbol: "AAPL",
      side: "buy",
      status: "proposed",
      authority: "decide",
      thesis: "test",
      rationale: "test",
      action: "BUY AAPL $100"
    });

    const pending = db.listPendingProposals(accountNumber);
    expect(pending.find((row) => row.id === proposalId)?.executionMode).toBe("broker/paper");
    expect(pending.find((row) => row.id === proposalId)?.estimatedNotional).toBe(100);

    expect(db.claimProposalForExecution(proposalId, "placing", "local", { executionMode: "broker/paper", refId: "ref-mode-1" })).toBe(true);
    expect(db.getProposal(proposalId)?.executionMode).toBe("broker/paper");

    db.insertProposal({
      id: placingProposalId,
      runId: "run-mode-2",
      accountNumber,
      proposal,
      decision,
      status: "placing",
      refId: "ref-mode-2",
      executionMode: "broker/paper"
    });
    const stale = db.listStalePlacingProposals(accountNumber, new Date(Date.now() + 60_000).toISOString());
    expect(stale.find((row) => row.id === placingProposalId)?.executionMode).toBe("broker/paper");

    db.insertFillEvent({
      accountNumber,
      source: "paper",
      executionMode: "broker/paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "pending_reconciliation",
      brokerOrderId: "paper-order-1"
    });
    expect(db.listFillEvents(accountNumber, "paper").at(-1)?.executionMode).toBe("broker/paper");
    expect(db.listPendingBrokerReconciliationFills(accountNumber).at(-1)?.executionMode).toBe("broker/paper");

    db.insertPortfolioSnapshot({
      accountNumber,
      source: "paper",
      executionMode: "broker/paper",
      equity: 100_000,
      cash: 99_900,
      buyingPower: 99_900,
      positionsValue: 100,
      positions: []
    });
    expect(db.listPortfolioSnapshots(accountNumber, "paper").at(-1)?.executionMode).toBe("broker/paper");
  });
});
