// Deterministic "on fill" handler (Phase 1 — no LLM, no cost).
//
// A real-time fill (from the Alpaca trade_updates stream) reconciles the matching fill record
// against the broker immediately instead of waiting for the next strategy run, and pushes a
// dashboard refresh. Per the expert policy a fill is DETERMINISTIC-ONLY: it must NOT trigger an
// LLM run (so we emit a dashboard `order` event, not a run-triggering material event). Dynamic
// imports avoid any load-time import cycle with the heavy strategy module.

import { emitDashboardEvent } from "./events";

export async function onBrokerFill(detail: { orderId: string; symbol?: string; event: string }): Promise<void> {
  const { listUsers, getPolicy } = await import("./db");
  const { getBrokerGateway } = await import("./broker");
  const { reconcilePendingFills } = await import("./strategy");

  for (const userId of listUsers()) {
    const policy = getPolicy(userId);
    // The trade_updates stream is authed with the Alpaca account; reconcile only users on Alpaca.
    if (policy.activeBroker !== "alpaca" || !policy.accountNumber) continue;
    try {
      await reconcilePendingFills(getBrokerGateway(policy, userId), policy.accountNumber, userId, policy.connectedAccountId);
    } catch (err) {
      console.error("[fills] reconcile error:", err);
    }
    emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { orderId: detail.orderId, symbol: detail.symbol, event: detail.event } });
  }
}
