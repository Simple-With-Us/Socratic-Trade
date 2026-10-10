import { describe, expect, it } from "vitest";
import {
  approvalHomeToast,
  resolveApprovalExecutionMode,
  toastForApproveResult,
  willPromptTypedApproval
} from "../app/console/lib/approval-honesty";
import { approvalIsLive } from "../app/console/approvals/triage";
import type { PendingProposal } from "../src/lib/types";

function pending(executionMode?: PendingProposal["executionMode"]): PendingProposal {
  return {
    id: "p1",
    createdAt: "2026-08-25T00:00:00.000Z",
    executionMode,
    proposal: {
      symbol: "NVDA",
      side: "buy",
      type: "market",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Breakout",
      tradeThesisTag: "Breakout",
      entryMarketRegime: "Risk-On"
    },
    decision: { shouldTrade: true, approved: true, reasons: [] }
  } as unknown as PendingProposal;
}

describe("approve honesty: row.executionMode ?? currentMode", () => {
  it("treats a NULL row stamp on a live account as live", () => {
    expect(resolveApprovalExecutionMode(undefined, "broker/live")).toBe("broker/live");
    expect(resolveApprovalExecutionMode(null, "broker/live")).toBe("broker/live");
    expect(willPromptTypedApproval(resolveApprovalExecutionMode(undefined, "broker/live"), true)).toBe(true);
    expect(approvalIsLive(pending(undefined), "broker/live")).toBe(true);
  });

  it("keeps an explicit paper stamp even when the current account is live", () => {
    expect(resolveApprovalExecutionMode("broker/paper", "broker/live")).toBe("broker/paper");
    expect(willPromptTypedApproval(resolveApprovalExecutionMode("broker/paper", "broker/live"), true)).toBe(false);
    expect(approvalIsLive(pending("broker/paper"), "broker/live")).toBe(false);
  });

  it("does not prompt typed confirm when the owner turned the ritual off", () => {
    expect(willPromptTypedApproval("broker/live", false)).toBe(false);
  });

  it("does not title a toast Approved unless placement succeeded", () => {
    expect(approvalHomeToast("placed").title).toBe("Approved");
    expect(approvalHomeToast("filled").title).toBe("Approved");
    expect(approvalHomeToast("paper").title).toBe("Approved");
    expect(approvalHomeToast("busy").title).toBe("Approval is still busy");
    expect(approvalHomeToast("busy").title).not.toBe("Approved");
    expect(approvalHomeToast("busy").detail).toContain("\u00A0 ");
    expect(approvalHomeToast("blocked").title).toBe("Blocked at approval time");
    expect(approvalHomeToast("blocked").title).not.toBe("Approved");
  });

  it("shares card titles when a symbol is present and keeps home Approved without one", () => {
    expect(toastForApproveResult({ status: "placed", symbol: "AAPL", side: "buy" })).toMatchObject({
      tone: "pos",
      title: "BUY AAPL placed"
    });
    expect(toastForApproveResult({ status: "filled", symbol: "AAPL", side: "sell" }).title).toBe("SELL AAPL filled");
    expect(toastForApproveResult({ status: "paper", symbol: "AAPL", side: "short" }).title).toBe("SHORT AAPL filled (paper)");
    expect(toastForApproveResult({ status: "busy", symbol: "AAPL", side: "buy" }).title).toBe("Approval is still busy");
    expect(toastForApproveResult({ status: "busy", symbol: "AAPL", side: "buy" }).title).not.toBe("Approved");
    expect(toastForApproveResult({ status: "placed" }).title).toBe("Approved");
  });
});
