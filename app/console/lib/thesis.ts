import type { HumanReviewReasonReceipt, OrderSide, PolicyDecision, TradeProposal } from "@/lib/types";

const RED_TEAM_MARKERS = [
  "\n\nRed Team Review Survived:",
  "\n\nRed Team review",
  "\n\nRed Team verdict:",
  "\n\n⚠ Red Team"
] as const;

export interface ThesisRationaleParts {
  greenTeam: string;
  checks?: string;
}

/** Split the legacy append-only rationale without guessing at arbitrary prose. New decisions carry
 * an exact greenTeamRationale; old decisions are cut only at known app-authored Red Team markers. */
export function splitThesisRationale(rationale: string, greenTeamRationale?: string): ThesisRationaleParts {
  const firstMarker = RED_TEAM_MARKERS
    .map((marker) => rationale.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const beforeRed = (firstMarker == null ? rationale : rationale.slice(0, firstMarker)).trim();
  const exactGreen = greenTeamRationale?.trim();

  if (exactGreen && beforeRed.startsWith(exactGreen)) {
    const checks = beforeRed.slice(exactGreen.length).trim();
    return { greenTeam: exactGreen, ...(checks ? { checks } : {}) };
  }

  return { greenTeam: beforeRed };
}

export type OutcomeTone = "pos" | "warn" | "neg" | "accent";

export interface DeterministicOutcomePresentation {
  label: string;
  body: string;
  tone: OutcomeTone;
}

export function deterministicOutcomePresentation(
  status: string | undefined,
  decision?: PolicyDecision
): DeterministicOutcomePresentation | undefined {
  if (!status && !decision) return undefined;
  const reasons = decision?.reasons?.filter(Boolean) ?? [];
  const reasonText = reasons.length > 0 ? reasons.join(" ") : "";

  if (status === "filled") {
    return {
      label: "Order filled",
      body: reasonText || "The broker reports that the order filled.",
      tone: "pos"
    };
  }
  if (status === "placed") {
    return {
      label: "Order placed",
      body: reasonText || "Deterministic policy checks and broker preflight passed; the order was submitted.",
      tone: "pos"
    };
  }
  if (status === "placing") {
    return {
      label: "Placement pending confirmation",
      body: "The order was submitted, but broker acceptance has not yet been confirmed.",
      tone: "warn"
    };
  }
  if (status === "blocked") {
    return {
      label: "Blocked before placement",
      body: reasonText || "A deterministic policy or execution check prevented the order from being submitted.",
      tone: "neg"
    };
  }
  if (status === "rejected") {
    return {
      label: "Rejected by user",
      body: "The pending proposal was declined before placement.",
      tone: "neg"
    };
  }
  if (status === "rejected_by_broker") {
    return {
      label: "Rejected by broker",
      body: "The broker declined the order; no placement is being claimed.",
      tone: "neg"
    };
  }
  if (status === "not_placed" || status === "placing_failed") {
    return {
      label: "Order not placed",
      body: "No broker order was confirmed.  The proposal can be reviewed and retried if it still makes sense.",
      tone: "neg"
    };
  }
  if (status === "expired" || status === "withdrawn") {
    return {
      label: status === "expired" ? "Proposal expired" : "Proposal withdrawn",
      body:
        status === "expired"
          ? "The proposal aged out before placement."
          : "The strategy withdrew the proposal before placement.",
      tone: "warn"
    };
  }
  if (status === "error" || status === "failed") {
    return {
      label: "Placement failed",
      body: reasonText || "The trade was not confirmed as placed.",
      tone: "neg"
    };
  }
  if (status === "proposed" || status === "pending" || status === "planned") {
    return {
      label: "Awaiting approval",
      body: reasonText || "The trade has not been placed; it is waiting for a human decision.",
      tone: "warn"
    };
  }

  return {
    label: status ? status.replaceAll("_", " ") : decision?.approved ? "Policy approved" : "Policy reviewed",
    body: reasonText || (decision?.approved ? "Deterministic policy checks approved the trade." : "No placement outcome was recorded."),
    tone: decision?.approved ? "pos" : "accent"
  };
}

const PLACED_SIDE_LABEL: Record<OrderSide, string> = {
  buy: "Bought",
  sell: "Sold",
  short: "Shorted",
  cover: "Covered"
};

const INTENT_SIDE_LABEL: Record<OrderSide, string> = {
  buy: "Buy",
  sell: "Sell",
  short: "Short",
  cover: "Cover"
};

/** Past tense is reserved for a confirmed placement; blocked/proposed rows describe intent. */
export function decisionActionLabel(side: OrderSide, status: string): string {
  return status === "placed" || status === "filled" ? PLACED_SIDE_LABEL[side] : INTENT_SIDE_LABEL[side];
}

/** Approval endpoints return `filled` when the broker completes synchronously and `placed` while
 * execution is still pending. Both are successful submissions; `paper` remains for legacy rows. */
export function isSuccessfulApprovalResult(status: string): boolean {
  return status === "placed" || status === "filled" || status === "paper";
}

export function proposalGreenRationale(proposal?: TradeProposal): string | undefined {
  if (!proposal?.rationale) return undefined;
  return splitThesisRationale(proposal.rationale, proposal.greenTeamRationale).greenTeam;
}

export function proposalHumanReviewReasons(proposal?: TradeProposal): HumanReviewReasonReceipt[] {
  return (proposal?.humanReviewReasons ?? []).filter(
    (reason) => reason.title.trim().length > 0 && reason.summary.trim().length > 0
  );
}
