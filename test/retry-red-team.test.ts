import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const debateProposalMock = vi.hoisted(() => vi.fn());

function approveDebate() {
  return {
    verdict: "approve" as const,
    rejected: false,
    available: true,
    reason: "Retried and the thesis still holds.",
    model: "test-red"
  };
}

vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        { T: { symbol: "T", price: 25.1, bid: 25.09, ask: 25.11, provider: "test-scan", asOf: new Date().toISOString() } },
        []
      )
  };
});

vi.mock("../src/lib/red-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/red-team")>();
  return {
    ...actual,
    debateProposal: debateProposalMock
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-retry-red-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  debateProposalMock.mockReset();
  debateProposalMock.mockResolvedValue(approveDebate());
});

function openingFixture(overrides: {
  userId: string;
  proposalId: string;
  quantity?: number;
  dollarAmount?: number;
}) {
  return {
    id: overrides.proposalId,
    runId: "r",
    accountNumber: "ACCT",
    userId: overrides.userId,
    status: "proposed" as const,
    estimatedNotional: 8,
    proposal: {
      symbol: "T",
      side: "buy" as const,
      type: "limit" as const,
      quantity: overrides.quantity ?? 1,
      ...(overrides.dollarAmount != null ? { dollarAmount: overrides.dollarAmount } : {}),
      limitPrice: 24.88,
      referencePrice: 24.88,
      timeInForce: "day" as const,
      rationale: "test",
      tradeThesisTag: "Sector-Relative-Strength",
      entryMarketRegime: "Neutral",
      redTeamVerdict: {
        available: false,
        rejected: false,
        reason: "Red Team review errored out.",
        failureKind: "timeout" as const,
        model: "deepseek-v4-flash"
      }
    },
    decision: { approved: true, reasons: [] }
  };
}

describe("retryProposalRedTeam", () => {
  it("writes a new verdict onto a still-pending opening", async () => {
    const { insertProposal, getProposal } = await import("../src/lib/db");
    const { retryProposalRedTeam } = await import("../src/lib/retry-red-team");
    const userId = `retry-red-${randomUUID()}`;
    const proposalId = `p-${randomUUID()}`;
    insertProposal(openingFixture({ userId, proposalId }));

    const result = await retryProposalRedTeam(proposalId, userId);
    expect(result.ok).toBe(true);
    expect(result.verdict?.available).toBe(true);
    expect(result.verdict?.reason).toMatch(/still holds/);

    const row = getProposal(proposalId, userId);
    expect(row?.proposal.redTeamVerdict?.available).toBe(true);
    expect(row?.proposal.reviewedByModel).toBe("test-red");
    expect(debateProposalMock.mock.calls[0]?.[4]?.sizing?.estimatedNotional).toBeGreaterThan(0);
  });

  it("applies an approve-at-half haircut onto the pending card", async () => {
    debateProposalMock.mockResolvedValue({
      verdict: "approve-at-half",
      rejected: false,
      available: true,
      reason: "Size is too large for this setup.",
      model: "test-red"
    });
    const { insertProposal, getProposal } = await import("../src/lib/db");
    const { retryProposalRedTeam } = await import("../src/lib/retry-red-team");
    const userId = `retry-red-half-${randomUUID()}`;
    const proposalId = `p-${randomUUID()}`;
    insertProposal(openingFixture({ userId, proposalId, quantity: 10 }));

    const result = await retryProposalRedTeam(proposalId, userId);
    expect(result.ok).toBe(true);
    expect(result.verdict?.verdict).toBe("approve-at-half");

    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("proposed");
    expect(row?.proposal.quantity).toBe(5);
    expect(row?.estimatedNotional).toBeGreaterThan(0);
    expect(row?.proposal.rationale).toMatch(/approved at half size/);
    expect(
      (row?.proposal.humanReviewReasons ?? []).some((reason) => reason.code === "initial_red_team")
    ).toBe(false);
  });

  it("keeps a rejected opening pending with a human-review receipt", async () => {
    debateProposalMock.mockResolvedValue({
      verdict: "reject",
      rejected: true,
      available: true,
      reason: "Thesis is stale.",
      model: "test-red"
    });
    const { insertProposal, getProposal } = await import("../src/lib/db");
    const { retryProposalRedTeam } = await import("../src/lib/retry-red-team");
    const userId = `retry-red-reject-${randomUUID()}`;
    const proposalId = `p-${randomUUID()}`;
    insertProposal(openingFixture({ userId, proposalId, quantity: 10 }));

    const result = await retryProposalRedTeam(proposalId, userId);
    expect(result.ok).toBe(true);
    expect(result.verdict?.rejected).toBe(true);

    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("proposed");
    expect(row?.proposal.quantity).toBe(10);
    expect(row?.proposal.humanReviewReasons?.some((reason) => reason.code === "initial_red_team")).toBe(
      true
    );
    expect(row?.proposal.scorecard?.decisionChain?.at(-1)).toBe("red_team_reject");
  });

  it("refuses exits", async () => {
    const { insertProposal } = await import("../src/lib/db");
    const { retryProposalRedTeam, RetryRedTeamError } = await import("../src/lib/retry-red-team");
    const userId = `retry-red-exit-${randomUUID()}`;
    const proposalId = `p-${randomUUID()}`;
    insertProposal({
      id: proposalId,
      runId: "r",
      accountNumber: "ACCT",
      userId,
      status: "proposed",
      estimatedNotional: 8,
      proposal: {
        symbol: "T",
        side: "sell",
        type: "market",
        quantity: 1,
        timeInForce: "day",
        rationale: "exit",
        tradeThesisTag: "Sector-Relative-Strength",
        entryMarketRegime: "Neutral"
      },
      decision: { approved: true, reasons: [] }
    });
    await expect(retryProposalRedTeam(proposalId, userId)).rejects.toBeInstanceOf(RetryRedTeamError);
    expect(debateProposalMock).not.toHaveBeenCalled();
  });
});
