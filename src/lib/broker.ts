import type { BrokerGateway, EquityOrderInput, ExecutedOrder, TradingPolicy } from "./types";
import { getRobinhoodGateway, getTestGateway } from "./robinhood";
import { getAlpacaGateway } from "./alpaca";
import { getActiveConnectedAccount, getConnectedAccount } from "./db";
import { deriveExecutionState } from "./execution-mode";
import { assertLivePreflight } from "./preflight-live-guard";

function resolveGateway(policy: TradingPolicy, userId: string): BrokerGateway {
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return getAlpacaGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "robinhood") {
    return getRobinhoodGateway(userId);
  }
  // "test" is TEST INFRASTRUCTURE (TestBrokerGateway) — a genuinely connected account whose
  // broker is "test", used by the unit-test suite so execution flows through this same broker
  // path without hitting real Alpaca/Robinhood. It is not a product default.
  if (policy.activeBroker === "test") {
    return getTestGateway(userId);
  }
  // No connected account: an account is an account, and with none connected the app cannot
  // place orders. There is no local-simulation fallback.
  throw new Error("No connected broker account. Connect a broker account before the app can place orders.");
}

/**
 * Wrap a gateway so `placeEquityOrder` runs the default-off live pre-flight guard first. This is the
 * SINGLE choke point every real-order PLACEMENT path flows through — the strategy loop, approval path,
 * synthetic stops, broker protective stops, order replacement, and any future caller — so real capital
 * is never committed unless `ALLOW_LIVE_TRADING` is set AND the connected account's environment is
 * genuinely live.
 *
 * `cancelEquityOrder` is deliberately NOT guarded here: cancelling is RISK-REDUCING, and an operator
 * who disables live trading in an emergency must still be able to cancel outstanding live orders /
 * stale protective stops (manual `/api/orders/cancel`, cancel-on-close cleanup, etc.). The narrow
 * cancel-THEN-place workflows (order replacement, protective-stop reconcile) instead run the pre-flight
 * BEFORE their own cancel phase (see `livePreflightBlocks`), so they fail atomically with no orphaned
 * cancel — without blocking standalone cancels.
 *
 * No-op on the broker/paper path. Execution state is derived lazily (only when a placement actually
 * runs) so read-only gateway uses pay no extra DB cost. A Proxy (not mutation) keeps the underlying
 * gateway untouched, so re-resolving the gateway can never double-wrap it.
 */
function withLivePreflight(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (prop === "placeEquityOrder") {
        // async so a guard failure becomes a REJECTED promise (correct async contract) rather than a
        // synchronous throw, matching how every caller `await`s placeEquityOrder.
        return async (input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          const activeAccount =
            (policy.connectedAccountId ? getConnectedAccount(policy.connectedAccountId, userId) : undefined) ??
            getActiveConnectedAccount(userId);
          const executionState = deriveExecutionState(policy, activeAccount);
          // resolveGateway already refused a missing account before this Proxy could exist, but guard
          // again here (defense in depth / type narrowing) rather than trust that invariant blindly.
          if (!executionState.mode) {
            throw new Error("No connected broker account. Connect a broker account before the app can place orders.");
          }
          assertLivePreflight({
            mode: executionState.mode,
            symbol: input.symbol,
            side: input.side
          });
          return target.placeEquityOrder(input);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  return withLivePreflight(resolveGateway(policy, userId), policy, userId);
}
