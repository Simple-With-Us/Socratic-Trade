import { describe, expect, it } from "vitest";
import {
  classifyPlaceOrderError,
  classifyPlacementOutcomeKind,
  httpStatusForPlacement,
  isIdempotencyConflictHttpError,
  isRetryableBrokerHttpError,
  isTerminalBrokerHttpError,
  mustReconcileRetryablePlaceError,
  mobileCommandStatusForPlacement,
  placementCommandErrorMessage,
  resolvePlacementOutcome
} from "../src/lib/placement-outcome";
import { isTradierTransientServerError } from "../src/lib/tradier-transient";

describe("placement outcome resolver", () => {
  it("classifies placed outcomes", () => {
    for (const status of ["filled", "placed", "paper"]) {
      expect(classifyPlacementOutcomeKind(status)).toBe("placed");
    }
  });

  it("classifies blocked, busy, and retryable statuses", () => {
    expect(classifyPlacementOutcomeKind("blocked")).toBe("blocked");
    expect(classifyPlacementOutcomeKind("busy")).toBe("busy");
    expect(classifyPlacementOutcomeKind("not_placed")).toBe("retryable");
  });

  it("classifies error strings by whether the order can be retried", () => {
    expect(classifyPlacementOutcomeKind("error", ["Order not placed (safe to retry): timeout"])).toBe("retryable");
    expect(classifyPlacementOutcomeKind("error", ["Broker declined the order (state: rejected)."])).toBe("rejected");
    expect(classifyPlacementOutcomeKind("proposed", ["Red rejected the final size"])).toBe("rejected");
  });

  it("treats HTTP 429 and 408 as retryable broker errors, not terminal 4xx", () => {
    expect(isRetryableBrokerHttpError("Alpaca order failed: HTTP 429 Too Many Requests")).toBe(true);
    expect(isRetryableBrokerHttpError("Broker HTTP 408 while placing")).toBe(true);
    expect(isTerminalBrokerHttpError("Alpaca order failed: HTTP 429 Too Many Requests")).toBe(false);
    expect(isTerminalBrokerHttpError("Broker HTTP 403 Forbidden")).toBe(true);
    expect(isTerminalBrokerHttpError("HTTP 400 Bad Request")).toBe(true);
    expect(isRetryableBrokerHttpError("HTTP 403 Forbidden")).toBe(false);
  });

  it("treats HTTP 409 as an idempotency conflict, not a terminal rejection", () => {
    const message = "Alpaca order failed: HTTP 409 — {\"code\":40010000,\"message\":\"client_order_id already exists\"}";
    expect(isIdempotencyConflictHttpError(message)).toBe(true);
    expect(isRetryableBrokerHttpError(message)).toBe(false);
    expect(isTerminalBrokerHttpError(message)).toBe(false);
    expect(isTerminalBrokerHttpError("Alpaca order failed: HTTP 403 Forbidden")).toBe(true);
  });

  it("classifies retryable 429/408, idempotency 409, and duplicate client_order_id apart from terminal 4xx", () => {
    expect(classifyPlaceOrderError("Alpaca order failed: HTTP 429 Too Many Requests")).toBe("retryable");
    expect(classifyPlaceOrderError("Broker HTTP 408 while placing")).toBe("retryable");
    expect(classifyPlaceOrderError("Alpaca order failed: HTTP 409 — client_order_id already exists")).toBe(
      "idempotency_conflict"
    );
    // Alpaca also returns HTTP 422 when the idempotency key is already taken.
    const duplicate422 = 'HTTP 422 — {"message":"client_order_id must be unique"}';
    expect(classifyPlaceOrderError(duplicate422)).toBe("idempotency_conflict");
    expect(isTerminalBrokerHttpError(duplicate422)).toBe(false);
    expect(classifyPlaceOrderError("HTTP 403 Forbidden")).toBe("rejected_terminal");
    expect(classifyPlaceOrderError("HTTP 400 Bad Request")).toBe("rejected_terminal");
    expect(classifyPlaceOrderError('HTTP 422 — {"message":"invalid client_order_id"}')).toBe("rejected_terminal");
    // Unrelated sentences must not become idempotency_conflict (clause boundary is `.`).
    expect(classifyPlaceOrderError('HTTP 422 — duplicate symbol in basket. client_order_id format invalid')).toBe(
      "rejected_terminal"
    );
    expect(classifyPlaceOrderError("network timeout during placement")).toBe("retryable");
    expect(mustReconcileRetryablePlaceError("network timeout during placement")).toBe(true);
    expect(classifyPlaceOrderError("AbortError: The operation was aborted")).toBe("retryable");
  });

  it("treats Tradier HTTP 400 Unexpected server error as retryable and keeps real rejects terminal", () => {
    const sentence = "Tradier order failed: Tradier HTTP 400: Unexpected server error";
    const wrapped422 = "Tradier HTTP 422: Unexpected server error";
    const buyingPower = "Tradier order failed: Tradier HTTP 400: Not enough buying power";
    const plain400 = "HTTP 400 Bad Request";
    const http500 = "Tradier HTTP 500: Unexpected server error";
    const deferral = "Tradier sandbox order placement is deferred until 15 minutes after the open. Safe to retry.";
    const deferral16 =
      "Tradier sandbox quotes are 15 minutes delayed, so strategy runs and order placement wait until 16 minutes after the open (9:46am ET).  Safe to retry.";
    expect(isRetryableBrokerHttpError(sentence)).toBe(true);
    expect(isTerminalBrokerHttpError(sentence)).toBe(false);
    expect(classifyPlaceOrderError(sentence)).toBe("retryable");
    expect(classifyPlaceOrderError(wrapped422)).toBe("retryable");
    expect(isTerminalBrokerHttpError(wrapped422)).toBe(false);
    expect(classifyPlaceOrderError(buyingPower)).toBe("rejected_terminal");
    expect(isTerminalBrokerHttpError(buyingPower)).toBe(true);
    expect(classifyPlaceOrderError(plain400)).toBe("rejected_terminal");
    expect(isRetryableBrokerHttpError(http500)).toBe(true);
    expect(classifyPlaceOrderError(http500)).toBe("retryable");
    expect(isTerminalBrokerHttpError(http500)).toBe(false);
    // #4668: a 5xx with the same sentence is not the sandbox-400 retry, and it can still halt.
    expect(isTradierTransientServerError(http500)).toBe(false);
    expect(mustReconcileRetryablePlaceError(http500)).toBe(true);
    expect(classifyPlaceOrderError("An unexpected error occurred. Please try again.")).toBe("other");
    expect(classifyPlaceOrderError(deferral)).toBe("retryable");
    expect(isTerminalBrokerHttpError(deferral)).toBe(false);
    expect(classifyPlaceOrderError(deferral16)).toBe("retryable");
    expect(isTerminalBrokerHttpError(deferral16)).toBe(false);
    expect(classifyPlaceOrderError("HTTP 403 Forbidden")).toBe("rejected_terminal");
    // The sentence stays retryable, but it must reconcile before not_placed.
    // HTTP 429 and the local open-window deferral never reached a live order.
    expect(mustReconcileRetryablePlaceError(sentence)).toBe(true);
    expect(mustReconcileRetryablePlaceError(wrapped422)).toBe(true);
    expect(mustReconcileRetryablePlaceError("Broker HTTP 408 while placing")).toBe(true);
    expect(mustReconcileRetryablePlaceError("Alpaca order failed: HTTP 429 Too Many Requests")).toBe(false);
    expect(mustReconcileRetryablePlaceError(deferral)).toBe(false);
    expect(mustReconcileRetryablePlaceError(deferral16)).toBe(false);
    expect(mustReconcileRetryablePlaceError(buyingPower)).toBe(false);
    expect(mustReconcileRetryablePlaceError(http500)).toBe(true);
    const unverified = "Tradier order placement unverified: the tag lookup failed. Reconcile before retrying.";
    expect(classifyPlaceOrderError(unverified)).toBe("other");
    expect(mustReconcileRetryablePlaceError(unverified)).toBe(false);
    expect(isTerminalBrokerHttpError(unverified)).toBe(false);
  });

  it("resolvePlacementOutcome preserves the executeProposal payload and adds outcome", () => {
    const resolved = resolvePlacementOutcome({
      status: "busy",
      reasons: ["A strategy run is in progress; try again in a moment."]
    });
    expect(resolved).toMatchObject({
      status: "busy",
      outcome: "busy",
      reasons: ["A strategy run is in progress; try again in a moment."]
    });
  });

  it("reports HTTP success only for a placed order", () => {
    expect(httpStatusForPlacement("placed")).toBe(200);
    expect(httpStatusForPlacement("blocked")).toBe(409);
    expect(httpStatusForPlacement("busy")).toBe(409);
    expect(httpStatusForPlacement("retryable")).toBe(409);
    expect(httpStatusForPlacement("rejected")).toBe(409);
  });

  it("classifies placed, not placed, retryable, and terminal outcomes", () => {
    expect(classifyPlacementOutcomeKind("placed")).toBe("placed");
    expect(classifyPlacementOutcomeKind("filled")).toBe("placed");
    expect(classifyPlacementOutcomeKind("not_placed")).toBe("retryable");
    expect(classifyPlaceOrderError("Broker HTTP 503")).toBe("retryable");
    expect(classifyPlaceOrderError("request timed out")).toBe("retryable");
    expect(classifyPlaceOrderError("Tradier order failed: Tradier HTTP 400: Unexpected server error")).toBe(
      "retryable"
    );
    expect(
      classifyPlacementOutcomeKind("error", ["Tradier sandbox quotes wait until 16 minutes after the open. Safe to retry."])
    ).toBe("retryable");
    expect(classifyPlaceOrderError("Tradier HTTP 403: Not enough buying power")).toBe("rejected_terminal");
    expect(classifyPlacementOutcomeKind("error", ["Broker declined the order (state: rejected)."])).toBe("rejected");
    expect(httpStatusForPlacement("placed")).toBe(200);
    expect(httpStatusForPlacement("retryable")).toBe(409);
    expect(httpStatusForPlacement("rejected")).toBe(409);
  });

  it("maps placement outcomes to honest mobile command statuses", () => {
    expect(mobileCommandStatusForPlacement("placed")).toBe("succeeded");
    expect(mobileCommandStatusForPlacement("blocked")).toBe("failed");
    expect(mobileCommandStatusForPlacement("busy")).toBe("failed");
    expect(mobileCommandStatusForPlacement("retryable")).toBe("failed");
    expect(mobileCommandStatusForPlacement("rejected")).toBe("failed");
  });

  it("builds command error text from reasons when placement did not succeed", () => {
    const blocked = resolvePlacementOutcome({ status: "blocked", reasons: ["Symbol is not tradable."] });
    expect(placementCommandErrorMessage(blocked)).toBe("Symbol is not tradable.");
    const placed = resolvePlacementOutcome({ status: "placed", orderId: "ord-1" });
    expect(placementCommandErrorMessage(placed)).toBeUndefined();
  });
});
