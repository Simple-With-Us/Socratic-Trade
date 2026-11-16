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
import { normalizeModelId, redTeamSummaryChip } from "../app/console/components/approval-card";
import { modelDisplayName } from "../app/console/lib/models";
import type { RedTeamCardState } from "../app/console/lib/red-team";

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
      approveCount: 3,
      safeApproveCount: 2,
      liveCount: 1,
      liveEstimatedNotional: 3400,
      rejectCount: 3
    });
  });

  it("counts a NULL executionMode row as live when the current account is live", () => {
    const row = pending({
      id: "legacy-null-mode",
      createdAt: "2026-08-25T12:00:00.000Z",
      estimatedNotional: 1500
    });
    expect(row.executionMode).toBeUndefined();
    expect(approvalIsLive(row)).toBe(false);
    expect(approvalIsLive(row, "broker/live")).toBe(true);
    expect(summarizePendingProposals([row], "broker/live").liveCount).toBe(1);
    expect(summarizeBulkSelection([row], ["legacy-null-mode"], "broker/live").liveCount).toBe(1);
  });

  describe("normalizeModelId", () => {
    it("handles null, undefined, empty inputs", () => {
      expect(normalizeModelId(null)).toBe("");
      expect(normalizeModelId(undefined)).toBe("");
      expect(normalizeModelId("")).toBe("");
    });

    it("strips routing prefixes and collapses versions onto the catalog family", () => {
      expect(normalizeModelId("openrouter/google/gemini-2.5-flash")).toBe("gemini-flash-latest");
      expect(normalizeModelId("google/gemini-3.7-flash")).toBe("gemini-flash-latest");
      expect(normalizeModelId("openrouter/openai/gpt-4o")).toBe("gpt-4o");
      expect(normalizeModelId("openai/gpt-4o")).toBe("gpt-4o");
      expect(normalizeModelId("gpt-4o")).toBe("gpt-4o");
      expect(normalizeModelId("openrouter/~anthropic/claude-sonnet-latest")).toBe("claude-sonnet-latest");
      expect(normalizeModelId("~anthropic/claude-sonnet-latest")).toBe("claude-sonnet-latest");
    });
  });

  describe("redTeamSummaryChip (PR-A2 collapsed receipt)", () => {
    const baseVerdict = {
      available: true,
      rejected: false,
      verdict: "approve" as const,
      reason: "Looks fine",
      model: "openai/gpt-4o"
    };

    it("maps approve verdict to pos chip", () => {
      const chip = redTeamSummaryChip("verdict-panel" satisfies RedTeamCardState, baseVerdict);
      expect(chip.label).toBe("AI critic: approve");
      expect(chip.tone).toBe("pos");
    });

    it("maps reject / rejected flag to neg chip", () => {
      expect(redTeamSummaryChip("verdict-panel", { ...baseVerdict, rejected: true }).label).toBe("AI critic: reject");
      expect(redTeamSummaryChip("verdict-panel", { ...baseVerdict, verdict: "reject", rejected: false }).tone).toBe("neg");
    });

    it("maps approve-at-half and failed review (failure chip names the CAUSE — #2552)", () => {
      expect(redTeamSummaryChip("verdict-panel", { ...baseVerdict, verdict: "approve-at-half" }).label).toBe(
        "AI critic: half size"
      );
      const failed = redTeamSummaryChip("verdict-panel", {
        ...baseVerdict,
        available: false,
        reason: "provider error",
        failureKind: "provider_error"
      });
      // Console parity with the PWA's "Red team FAILED (provider error) — <model>" honesty:
      // the collapsed chip itself carries reviewer + failure kind, not a bare "failed".
      expect(failed.tone).toBe("warn");
      expect(failed.label).toBe(`AI critic failed — ${modelDisplayName("openai/gpt-4o")}: provider error`);
    });

    it("names the failure kind without inventing a reviewer when no model is persisted (#2552)", () => {
      const failed = redTeamSummaryChip("verdict-panel", {
        ...baseVerdict,
        model: undefined,
        available: false,
        reason: "The reviewer answered in prose.",
        failureKind: "malformed_response"
      });
      expect(failed.tone).toBe("warn");
      expect(failed.label).toBe("AI critic failed — malformed response");
      // The configured model IS a fair attribution when the verdict predates per-proposal stamping.
      const attributed = redTeamSummaryChip(
        "verdict-panel",
        { ...baseVerdict, model: undefined, available: false, failureKind: "timeout" },
        undefined,
        "deepseek-chat"
      );
      expect(attributed.label).toBe(`AI critic failed — ${modelDisplayName("deepseek-chat")}: timeout`);
    });

    it("keeps not-configured visually distinct from a real failure (#2552)", () => {
      const notConfigured = redTeamSummaryChip("verdict-panel", {
        ...baseVerdict,
        model: undefined,
        available: false,
        reason: "No adversarial model configured.",
        failureKind: "not_configured"
      });
      expect(notConfigured.label).toBe("AI critic: not configured");
      expect(notConfigured.tone).toBe("muted");
    });

    it("maps legacy-unavailable and no-review", () => {
      expect(redTeamSummaryChip("legacy-unavailable", undefined).label).toBe("AI critic: unavailable");
      const none = redTeamSummaryChip("no-review", undefined);
      expect(none.label).toBe("No AI critic");
      expect(none.tone).toBe("muted");
    });
  });
});
