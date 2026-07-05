import { describe, expect, it } from "vitest";
import type { PendingProposal } from "../src/lib/types";
import {
  approvalEstimatedNotional,
  approvalIsExit,
  approvalIsLive,
  summarizeBulkSelection,
  summarizePendingProposals,
  triagePendingProposals
} from "../app/console/approvals/triage";

type PendingInput = Omit<Partial<PendingProposal>, "proposal" | "decision" | "id" | "createdAt"> & {
  id: string;
  createdAt: string;
  proposal?: Partial<PendingProposal["proposal"]>;
  decision?: Partial<PendingProposal["decision"]>;
};

function pending(input: PendingInput): PendingProposal {
  const { id, createdAt, proposal, decision, ...rest } = input;
  return {
    ...rest,
    id,
    createdAt,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Momentum improving",
      tradeThesisTag: "Breakout",
      entryMarketRegime: "Risk-On",
      ...proposal
    },
    decision: {
      shouldTrade: true,
      reasons: [],
      ...decision
    }
  } as PendingProposal;
}

describe("approvals triage helpers", () => {
  it("filters by search, side, and reality and sorts by notional", () => {
    const rows = triagePendingProposals(
      [
        pending({
          id: "exit-paper",
          createdAt: "2026-07-04T10:00:00.000Z",
          proposal: { symbol: "NVDA", side: "sell", rationale: "Trim after earnings", tradeThesisTag: "Trim" },
          executionMode: "broker/paper",
          estimatedNotional: 2000
        }),
        pending({
          id: "open-live",
          createdAt: "2026-07-04T12:00:00.000Z",
          proposal: { symbol: "NVDA", side: "buy", rationale: "Breakout after earnings", tradeThesisTag: "Breakout" },
          executionMode: "broker/live",
          estimatedNotional: 9000
        }),
        pending({
          id: "open-paper",
          createdAt: "2026-07-04T11:00:00.000Z",
          proposal: { symbol: "MSFT", side: "buy", rationale: "Cloud momentum", tradeThesisTag: "Breakout" },
          executionMode: "broker/paper",
          estimatedNotional: 5000
        })
      ],
      {
        query: "nvda breakout",
        side: "openings",
        reality: "live",
        sort: "notional"
      }
    );

    expect(rows.map((row) => row.id)).toEqual(["open-live"]);
  });

  it("summarizes pending proposals and bulk-safe selection", () => {
    const rows = [
      pending({
        id: "paper-buy",
        createdAt: "2026-07-04T11:00:00.000Z",
        executionMode: "broker/paper",
        estimatedNotional: 1200
      }),
      pending({
        id: "live-buy",
        createdAt: "2026-07-04T12:00:00.000Z",
        executionMode: "broker/live",
        estimatedNotional: 3400
      }),
      pending({
        id: "paper-exit",
        createdAt: "2026-07-04T13:00:00.000Z",
        proposal: { side: "sell" },
        executionMode: "broker/paper",
        estimatedNotional: 800
      })
    ];

    expect(approvalIsLive(rows[1]!)).toBe(true);
    expect(approvalIsExit(rows[2]!)).toBe(true);
    expect(approvalEstimatedNotional(rows[0]!)).toBe(1200);

    expect(summarizePendingProposals(rows)).toEqual({
      count: 3,
      liveCount: 1,
      exitCount: 1,
      totalEstimatedNotional: 5400
    });

    expect(summarizeBulkSelection(rows, ["paper-buy", "live-buy", "paper-exit"])).toEqual({
      selectedCount: 3,
      safeApproveCount: 2,
      liveCount: 1,
      rejectCount: 3
    });
  });
});
