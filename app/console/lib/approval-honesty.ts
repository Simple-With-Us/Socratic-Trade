/** Client mirrors of the server's approve-time execution-mode resolution and
 *  the honest toast for a finished approve call.  The server uses
 *  `row.executionMode ?? currentMode` (`src/lib/strategy-execution.ts` and
 *  `app/api/proposals/bulk-approve/route.ts`).  A NULL row stamp on a live
 *  account is still a live order. */

import type { ExecutionMode } from "@/lib/types";
import { feedStatusLabel } from "@/lib/dashboard-ui";
import { isSuccessfulApprovalResult } from "./thesis";
import { realityForMode } from "./derive";
import { SENTENCE_GAP } from "./format";

export function resolveApprovalExecutionMode(
  rowMode: ExecutionMode | null | undefined,
  currentMode: ExecutionMode | undefined
): ExecutionMode | undefined {
  return rowMode ?? currentMode;
}

export function willPromptTypedApproval(
  resolvedMode: ExecutionMode | undefined,
  requireTypedConfirmation: boolean | undefined
): boolean {
  return realityForMode(resolvedMode).tone === "live" && requireTypedConfirmation !== false;
}

export type ApprovalHomeToast = {
  tone: "pos" | "warn" | "info";
  title: string;
  detail?: string;
};

export type ApproveToastInput = {
  status: string;
  reasons?: string[];
  symbol?: string;
  side?: string;
};

const SIDE_LABEL: Record<string, string> = { buy: "BUY", sell: "SELL", short: "SHORT", cover: "COVER" };

function placedTitle(input: ApproveToastInput): string {
  const side = input.side ? (SIDE_LABEL[input.side] ?? input.side) : "";
  const label = `${side} ${input.symbol ?? ""}`.trim();
  if (input.status === "filled") return `${label} filled`;
  if (input.status === "paper") return `${label} filled (paper)`;
  return `${label} placed`;
}

function placedDetail(status: string): string {
  if (status === "filled") return "The broker reports that the order completed.";
  if (status === "paper") return "Recorded on the broker paper account.";
  return "The order went to the broker with a durable, idempotent intent record.";
}

/** Shared approve toast.  With a symbol, the card titles (BUY AAPL placed).
 *  Without one, the home title stays "Approved" and only for a real placement.
 *  busy/blocked keep the existing phrases. */
export function toastForApproveResult(input: ApproveToastInput): ApprovalHomeToast {
  const reasons = input.reasons;
  if (isSuccessfulApprovalResult(input.status)) {
    if (input.symbol) {
      return { tone: "pos", title: placedTitle(input), detail: placedDetail(input.status) };
    }
    return { tone: "pos", title: "Approved", detail: `Order status: ${input.status}` };
  }
  if (input.status === "blocked") {
    return {
      tone: "warn",
      title: "Blocked at approval time",
      detail: (reasons ?? []).join(" ") || "The policy gate re-ran and refused it."
    };
  }
  if (input.status === "busy") {
    return {
      tone: "warn",
      title: "Approval is still busy",
      detail:
        (reasons ?? []).join(" ") ||
        `A strategy run is still in progress after waiting.${SENTENCE_GAP}Wait for the run to finish (or for its lock to expire, up to ~5 minutes), then Approve again.`
    };
  }
  return {
    tone: "info",
    title: `Result: ${feedStatusLabel(input.status)}`,
    detail: (reasons ?? []).join(" ") || undefined
  };
}

/** Home Proposal Details toast.  "Approved" is reserved for a placed/filled/paper
 *  result.  busy/blocked keep the existing card phrases — they are not rewrites. */
export function approvalHomeToast(status: string, reasons?: string[]): ApprovalHomeToast {
  return toastForApproveResult({ status, reasons });
}
