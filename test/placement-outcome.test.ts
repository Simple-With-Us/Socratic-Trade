import { describe, expect, it } from "vitest";
import {
  classifyPlaceOrderError,
  classifyPlacementOutcomeKind,
  isIdempotencyConflictHttpError,
  isRetryableBrokerHttpError,
  isTerminalBrokerHttpError,
  mobileCommandStatusForPlacement,
  placementCommandErrorMessage,
  resolvePlacementOutcome
} from "../src/lib/placement-outcome";

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
    expect(classifyPlaceOrderError("network timeout during placement")).toBe("other");
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
