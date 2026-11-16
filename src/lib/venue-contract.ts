/**
 * Venue contract — what THIS connected account can actually do.
 *
 * Capabilities come from the broker (live getAccounts when possible) merged with
 * a per-broker known-limits profile.  Policy flags (shortSellingEnabled) can only
 * NARROW the contract, never widen it past the venue.
 *
 * The Green/Red LLM paths must derive their schema + prose from this object so we
 * never spend tokens debating a short, option, session, or order type the account
 * cannot place.  Place-time fail-closed is the last line, not the first.
 */

import type { ConnectedAccount, OrderSide, TradingPolicy } from "./types";
import type { ExecutionAccount } from "./execution-mode";
import { resolveSourceBool } from "./source-settings";
import {
  brokerDisplayLabel,
  buildPromptLines,
  mergeAccountCapabilities,
  resolveSessions,
  type VenueContract
} from "./venue-contract-pure";

export {
  brokerDisplayLabel,
  emptyCapabilities,
  knownBrokerLimits,
  mergeAccountCapabilities,
  type VenueContract
} from "./venue-contract-pure";

export function deriveVenueContract(
  policy: Pick<TradingPolicy, "shortSellingEnabled">,
  account?: ExecutionAccount | Pick<ConnectedAccount, "broker" | "capabilities">
): VenueContract {
  const broker = account?.broker ?? "none";
  const caps = mergeAccountCapabilities(account?.broker, account?.capabilities);
  const publicParked = broker === "public" && !resolveSourceBool("PUBLIC_EXECUTION_ENABLED");
  const shortAllowed = !publicParked && policy.shortSellingEnabled === true && caps.shortSelling === true;
  const sides: OrderSide[] = publicParked ? [] : shortAllowed ? ["buy", "sell", "short", "cover"] : ["buy", "sell"];
  const orderTypes = (caps.orderTypes?.length ? caps.orderTypes : ["market", "limit"]) as VenueContract["orderTypes"];
  const marketHours = resolveSessions(caps);
  const promptLines = buildPromptLines({
    brokerLabel: brokerDisplayLabel(account?.broker),
    shortAllowed,
    caps,
    orderTypes,
    marketHours
  });
  if (publicParked) {
    promptLines.unshift(
      "Public.com execution is parked until the account is funded.  Do not propose any orders for this venue."
    );
  }
  return {
    broker,
    brokerLabel: brokerDisplayLabel(account?.broker),
    sides,
    orderTypes,
    marketHours,
    fractional: caps.fractional === true,
    trailingStops: caps.trailingStops === true,
    nativeBrackets: caps.nativeBrackets === true,
    optionsTrading: caps.optionsTrading === true,
    optionsOrders: caps.optionsOrders === true,
    minShareQuantity: caps.minShareQuantity ?? (caps.fractional === true ? 0 : 1),
    minOrderNotional: caps.minOrderNotional,
    positionIdCloses: caps.positionIdCloses === true,
    promptLines
  };
}
