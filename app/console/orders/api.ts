/** Self-contained typed fetch helpers for the Orders screen's two mutations.
 *  Deliberately NOT added to the shared app/console/lib/api.ts (that file is
 *  owned by a parallel workstream); the parsing rules are the same. A 401
 *  still routes through that file's `redirectToLogin` (exported for exactly
 *  this reuse) — a dead session on an order-mutation call needs the same
 *  fail-closed /login redirect the dashboard poll and every other console
 *  mutation get, not a silent OrdersApiError with no navigation.
 *
 *  Contracts (verbatim from the routes — read-only references):
 *  - POST /api/orders/replace-market (app/api/orders/replace-market/route.ts →
 *    src/lib/order-replacement.ts): body { orderId, liveConfirmation? }.
 *    broker/live requires liveConfirmation { orderId, accountNumber,
 *    executionMode: "broker/live", remainingQuantity, typedText:
 *    "REPLACE LIVE <SYMBOL>" }; on mismatch → 409
 *    { error: "live_confirmation_required", reasons, expectedText }.
 *    Preconditions → 409/400/404 { error: "replace_precondition_failed",
 *    message } or plain text; system stopped → 409 { error: "system_stopped",
 *    message }. Success → MarketReplaceResult.
 *  - POST /api/orders/cancel (app/api/orders/cancel/route.ts): body
 *    { orderId } → the broker's ExecutedOrder JSON. No typed confirmation —
 *    cancelling is risk-reducing and stays available even while stopped. */

import { redirectToLogin } from "../lib/api";

export class OrdersApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "OrdersApiError";
    this.status = status;
    this.payload = payload;
  }
}

/** 409 live_confirmation_required — `expectedText` is the server-authoritative
 *  phrase (e.g. "REPLACE LIVE NVDA"); render it and the reasons verbatim. */
export class ReplaceLiveConfirmationRequiredError extends Error {
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" ") || "Typed confirmation required.");
    this.name = "ReplaceLiveConfirmationRequiredError";
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
}

export interface ReplaceLiveConfirmation {
  orderId: string;
  accountNumber: string | null;
  executionMode: "broker/live";
  remainingQuantity: number;
  typedText: string;
}

/** Mirror of MarketReplaceResult in src/lib/order-replacement.ts. */
export interface MarketReplaceResult {
  status: "replaced" | "already_filled";
  canceledOrderId: string;
  replacementOrderId?: string;
  brokerState?: string;
  fillStatus?: string;
  remainingQuantity: number;
}

/** Mirror of ExecutedOrder in src/lib/types.ts (the cancel route's response), plus the optional
 *  cancel-dust advisory (src/lib/broker-minimum-guard.ts describeCancelDustRisk) the route
 *  attaches when cancelling left an already-filled fragment below the broker's minimum order
 *  size. ADVISORY ONLY — its presence never means the cancel didn't go through. */
export interface CancelOrderResult {
  orderId?: string;
  refId?: string;
  state?: string;
  dustWarning?: string;
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return res.json().catch(() => undefined);
  return res.text().catch(() => undefined);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.message === "string" && p.message) return p.message;
    if (typeof p.error === "string" && p.error) return p.error;
  }
  return fallback;
}

async function post<T>(url: string, body: unknown, fallbackMessage: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new OrdersApiError("Network error — the server could not be reached.", 0);
  }
  const payload = await parseBody(res);
  if (!res.ok) {
    if (res.status === 401) redirectToLogin();
    throw new OrdersApiError(messageFrom(payload, `${fallbackMessage} (${res.status}).`), res.status, payload);
  }
  return payload as T;
}

export async function replaceOrderAtMarket(
  orderId: string,
  liveConfirmation?: ReplaceLiveConfirmation
): Promise<MarketReplaceResult> {
  try {
    return await post<MarketReplaceResult>(
      "/api/orders/replace-market",
      liveConfirmation ? { orderId, liveConfirmation } : { orderId },
      "Market replacement failed"
    );
  } catch (error) {
    if (error instanceof OrdersApiError && error.status === 409 && error.payload && typeof error.payload === "object") {
      const p = error.payload as { error?: string; reasons?: string[]; expectedText?: string };
      if (p.error === "live_confirmation_required" && typeof p.expectedText === "string") {
        throw new ReplaceLiveConfirmationRequiredError(Array.isArray(p.reasons) ? p.reasons : [], p.expectedText);
      }
    }
    throw error;
  }
}

export async function cancelOrder(orderId: string): Promise<CancelOrderResult> {
  return post<CancelOrderResult>("/api/orders/cancel", { orderId }, "Order cancel failed");
}
