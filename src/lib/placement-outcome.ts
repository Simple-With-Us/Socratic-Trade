/**
 * Single classifier for human approval placement results (`executeProposal` and mobile
 * `proposal.approve`). Consumers must not treat a resolved command as "placed" unless
 * `outcome === "placed"`.
 */

export type PlacementOutcomeKind = "placed" | "blocked" | "busy" | "retryable" | "rejected";

export interface ExecuteProposalResult {
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}

export interface PlacementOutcome extends ExecuteProposalResult {
  outcome: PlacementOutcomeKind;
}

/** HTTP 429 / 408 are transient broker-side limits — not terminal rejections. */
export function isRetryableBrokerHttpError(message: string): boolean {
  return /\bHTTP (429|408)\b/i.test(message);
}

/**
 * Alpaca reports a reused `client_order_id` as HTTP 409, and also as HTTP 422
 * `"client_order_id must be unique"`. Either way the key already exists at the
 * broker — usually because the first createOrder was accepted and the response
 * socket died. That is a live order, not a rejection. Callers must reconcile
 * by refId instead of marking rejected_by_broker.
 */
export function isDuplicateClientOrderIdError(message: string): boolean {
  return /client_order_id[^.]{0,80}(must be unique|already exists|duplicate)|(must be unique|already exists|duplicate)[^.]{0,80}client_order_id/i.test(
    message
  );
}

export function isIdempotencyConflictHttpError(message: string): boolean {
  return /\bHTTP 409\b/i.test(message) || isDuplicateClientOrderIdError(message);
}

/** Definitive broker HTTP 4xx excluding retryable limits and idempotency conflicts. */
export function isTerminalBrokerHttpError(message: string): boolean {
  return (
    /\bHTTP 4\d\d\b/i.test(message) &&
    !isRetryableBrokerHttpError(message) &&
    !isIdempotencyConflictHttpError(message)
  );
}

export type PlaceOrderErrorClass = "retryable" | "idempotency_conflict" | "rejected_terminal" | "other";

/**
 * Shared place-order error class for the approval path and the autonomous run.
 * `retryable` books not_placed (429/408).  `idempotency_conflict` must reconcile
 * (409, or a duplicate client_order_id on another 4xx) — an order may already
 * be live.  `rejected_terminal` is a definitive broker refusal.
 */
export function classifyPlaceOrderError(message: string): PlaceOrderErrorClass {
  if (isRetryableBrokerHttpError(message)) return "retryable";
  if (isIdempotencyConflictHttpError(message)) return "idempotency_conflict";
  if (/\bHTTP 4\d\d\b/i.test(message)) return "rejected_terminal";
  return "other";
}

export function classifyPlacementOutcomeKind(status: string, reasons?: string[]): PlacementOutcomeKind {
  switch (status) {
    case "filled":
    case "placed":
    case "paper":
      return "placed";
    case "blocked":
      return "blocked";
    case "busy":
      return "busy";
    case "not_placed":
      return "retryable";
    case "proposed":
      return "rejected";
    case "error": {
      const text = (reasons ?? []).join(" ");
      if (
        /safe to retry|mutation lease lost|uncertain|never reached the broker|rate-limited|timed out/i.test(text)
      ) {
        return "retryable";
      }
      return "rejected";
    }
    default:
      return "rejected";
  }
}

export function resolvePlacementOutcome(result: ExecuteProposalResult): PlacementOutcome {
  return {
    ...result,
    outcome: classifyPlacementOutcomeKind(result.status, result.reasons)
  };
}

export function mobileCommandStatusForPlacement(outcome: PlacementOutcomeKind): "succeeded" | "failed" {
  return outcome === "placed" ? "succeeded" : "failed";
}

export function placementCommandErrorMessage(outcome: PlacementOutcome): string | undefined {
  if (outcome.outcome === "placed") return undefined;
  const fromReasons = (outcome.reasons ?? []).join(" ").trim();
  if (fromReasons) return fromReasons;
  switch (outcome.outcome) {
    case "blocked":
      return "Blocked at approval time.";
    case "busy":
      return "Approval is still busy.";
    case "retryable":
      return "Order not placed — safe to retry.";
    case "rejected":
      return "Order was not placed.";
  }
}
