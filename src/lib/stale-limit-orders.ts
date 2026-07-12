import { audit, getInternalSetting, setInternalSetting } from "./db";
import { DEFAULT_POLICY } from "./defaults";
import { isActiveBrokerOrderState } from "./broker-held-orders";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import type { EquityOrder, TradingPolicy } from "./types";

const LIMIT_ORDER_TYPES = new Set(["limit", "stop_limit"]);
const EXTRA_WORKING_STATES = new Set(["done_for_day", "stopped", "calculated"]);

export interface StaleLimitOrder {
  order: EquityOrder;
  ageMinutes: number;
  thresholdMinutes: number;
  remainingQuantity: number;
}

export function staleLimitOrderThresholdMinutes(policy: Pick<TradingPolicy, "staleLimitOrderMinutes">): number {
  const threshold = policy.staleLimitOrderMinutes ?? DEFAULT_POLICY.staleLimitOrderMinutes ?? 15;
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
}

export function listStaleLimitOrders(
  orders: EquityOrder[],
  policy: Pick<TradingPolicy, "staleLimitOrderMinutes">,
  now: Date = new Date()
): StaleLimitOrder[] {
  const thresholdMinutes = staleLimitOrderThresholdMinutes(policy);
  if (thresholdMinutes <= 0) return [];

  const nowMs = now.getTime();
  return orders.flatMap((order) => {
    if (!LIMIT_ORDER_TYPES.has(String(order.type ?? "").toLowerCase())) return [];
    if (!isWorkingOrderState(order.state)) return [];

    const createdMs = Date.parse(order.createdAt);
    if (!Number.isFinite(createdMs) || createdMs > nowMs) return [];

    const quantity = order.quantity ?? 0;
    const filledQuantity = order.filledQuantity ?? 0;
    const remainingQuantity = Math.max(quantity - filledQuantity, 0);
    if (remainingQuantity <= 0) return [];

    const ageMinutes = Math.floor((nowMs - createdMs) / 60_000);
    if (ageMinutes < thresholdMinutes) return [];

    return [{ order, ageMinutes, thresholdMinutes, remainingQuantity }];
  });
}

export async function notifyStaleLimitOrders(input: {
  userId?: string;
  policy: TradingPolicy;
  orders: EquityOrder[];
  now?: Date;
}): Promise<{ alerted: number; stale: StaleLimitOrder[] }> {
  const userId = input.userId ?? "local";
  const stale = listStaleLimitOrders(input.orders, input.policy, input.now ?? new Date());
  let alerted = 0;

  for (const item of stale) {
    const key = staleLimitOrderAlertKey(userId, input.policy, item);
    if (getInternalSetting(key)) continue;

    const symbol = normalizeSymbol(item.order.symbol);
    const side = String(item.order.side ?? "order").toUpperCase();
    const title = `${symbol} ${side} limit order still working`;
    const summary =
      `${symbol} ${side} ${item.order.type} order ${item.order.id} is still open after ` +
      `${item.ageMinutes} minutes (${formatQuantity(item.remainingQuantity)} remaining). ` +
      "Review the order; cancel/reprice it before replacing it with a market order.";

    audit(
      "limit_order_stale",
      {
        orderId: item.order.id,
        symbol,
        side: item.order.side,
        type: item.order.type,
        state: item.order.state,
        createdAt: item.order.createdAt,
        ageMinutes: item.ageMinutes,
        thresholdMinutes: item.thresholdMinutes,
        quantity: item.order.quantity,
        filledQuantity: item.order.filledQuantity ?? 0,
        remainingQuantity: item.remainingQuantity,
        summary
      },
      userId,
      input.policy.connectedAccountId
    );

    await sendNotification(
      {
        type: "limit_order_stale",
        title,
        payload: {
          summary,
          order: item.order,
          ageMinutes: item.ageMinutes,
          thresholdMinutes: item.thresholdMinutes,
          remainingQuantity: item.remainingQuantity
        }
      },
      { policy: input.policy, userId }
    );
    setInternalSetting(key, { alertedAt: new Date().toISOString(), orderId: item.order.id });
    alerted += 1;
  }

  return { alerted, stale };
}

function isWorkingOrderState(state: string | undefined): boolean {
  const normalized = String(state ?? "").trim().toLowerCase();
  return isActiveBrokerOrderState(normalized) || EXTRA_WORKING_STATES.has(normalized);
}

function staleLimitOrderAlertKey(userId: string, policy: TradingPolicy, item: StaleLimitOrder): string {
  const accountKey = policy.connectedAccountId ?? policy.accountNumber ?? "base";
  return `stale_limit_order_alert:${userId}:${accountKey}:${item.order.id}:${item.thresholdMinutes}`;
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/\.?0+$/, "");
}
