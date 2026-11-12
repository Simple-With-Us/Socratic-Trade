import { brokerReadOrRethrow, jsonError, parseRequestJson } from "@/lib/api-error";
import { cancelWorkingOrder, OrderCancelPreconditionError } from "@/lib/order-cancel";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/cancel — the console's manual cancel.
 *
 * All of the behaviour (lease-interleave receipt, time-bounded cancel-dust advisory, audit trail,
 * dashboard event, dust notification) lives in `src/lib/order-cancel.ts` so the mobile
 * `order.cancel` command executes the SAME path rather than a second, drifting one. This route is
 * the HTTP shell: auth, rate limit, status mapping.
 *
 * No typed confirmation, by design: cancelling is risk-REDUCING and stays available even while the
 * system is stopped. Typed confirmation is the ceremony for opening live risk, not closing it.
 */
export async function POST(request: Request) {
  const parsed = await parseRequestJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { orderId?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError(400, "invalid_json", "Request body must be a JSON object.");
  }
  const { orderId } = body;
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const limited = enforceRateLimit(userId, "orders/cancel", RATE_LIMITS.orders);
  if (limited) return limited;
  try {
    const result = await cancelWorkingOrder({ userId, orderId: String(orderId ?? ""), source: "console" });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OrderCancelPreconditionError) {
      return new NextResponse(error.message, { status: error.status });
    }
    // Post-cancel bookkeeping (audit, DB, notifications) can fail after the broker accepted the
    // cancel.  Only broker-originated failures get the broker envelope; anything else stays a 500.
    return brokerReadOrRethrow(error);
  }
}
