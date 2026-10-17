import { isTradierSandboxOpenDeferralMessage, isTradierTransientServerError } from "./tradier-transient";

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

/**
 * A caller-side timeout.  HTTP 408 is matched separately.  The Tradier adapter's
 * 5xx exclusion in `isTradierTransientServerError` stays put: a 500 is retryable
 * here, and it can still halt.
 */
export function isTimeoutPlaceMessage(message: string): boolean {
  return /\b(?:timeout|timed out|etimedout)\b/i.test(message) || /\bAbortError\b/.test(message);
}

/**
 * HTTP 429 / 408, caller timeouts, and HTTP 5xx are transient.  Tradier's HTTP 400
 * "Unexpected server error" is the same class (#4668): the sandbox OMS wedged and
 * refused the request.  A plain HTTP 400 (buying power, bad symbol) is not.
 * HTTP 5xx is not folded into `isTradierTransientServerError`, so the adapter
 * still fails a 500 on the first POST and broker-health can still halt.
 */
export function isRetryableBrokerHttpError(message: string): boolean {
  return (
    /\bHTTP (429|408)\b/i.test(message) ||
    /\bHTTP 5\d\d\b/i.test(message) ||
    isTimeoutPlaceMessage(message) ||
    isTradierTransientServerError(message)
  );
}

/** Sandbox open-window deferral is a local skip, safe to retry after the window. */
export function isRetryablePlaceMessage(message: string): boolean {
  return isRetryableBrokerHttpError(message) || isTradierSandboxOpenDeferralMessage(message);
}

/**
 * Retryable errors that may still have landed at the broker.  Book
 * `not_placed` only after refId reconcile.  HTTP 408, other timeouts, and
 * HTTP 5xx are that class.  Tradier's HTTP 400 "Unexpected server error" is
 * the same class once it escapes the adapter: the POST may have been accepted,
 * and the next attempt mints a new refId.  A confirmed tag hit never throws
 * this sentence.  A 5xx with that sentence stays outside
 * `isTradierTransientServerError` so the adapter does not retry it as the
 * sandbox 400 and broker-health can still halt.  HTTP 429 and the sandbox
 * open deferral never reached a live order and stay on the short-circuit.
 */
export function mustReconcileRetryablePlaceError(message: string): boolean {
  return (
    /\bHTTP 408\b/i.test(message) ||
    /\bHTTP 5\d\d\b/i.test(message) ||
    isTimeoutPlaceMessage(message) ||
    isTradierTransientServerError(message)
  );
}

/** HTTP 200 only when the broker accepted the order.  Anything else is 409. */
export function httpStatusForPlacement(outcome: PlacementOutcomeKind): 200 | 409 {
  return outcome === "placed" ? 200 : 409;
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
    !isRetryablePlaceMessage(message) &&
    !isIdempotencyConflictHttpError(message)
  );
}

export type PlaceOrderErrorClass = "retryable" | "idempotency_conflict" | "rejected_terminal" | "other";

/**
 * Shared place-order error class for the approval path and the autonomous run.
 * `retryable` is a timeout, HTTP 5xx, HTTP 429, Tradier's HTTP 400
 * "Unexpected server error", or the sandbox open deferral.  Timeouts, 5xx,
 * HTTP 408, and that Tradier sentence may already be live, so they reconcile
 * before `not_placed`.  HTTP 429 and the open deferral never reached a live
 * order.  `idempotency_conflict` must reconcile (409, or a duplicate
 * client_order_id on another 4xx).  `rejected_terminal` is a definitive
 * broker refusal (plain 400 / 403 / 422).
 */
export function classifyPlaceOrderError(message: string): PlaceOrderErrorClass {
  if (isRetryablePlaceMessage(message)) return "retryable";
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
        /safe to retry|mutation lease lost|uncertain|never reached the broker|rate-limited|timed out|timeout|\bHTTP 5\d\d\b|\bHTTP 408\b|\bHTTP 429\b|unexpected server error/i.test(
          text
        ) ||
        isTimeoutPlaceMessage(text)
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
