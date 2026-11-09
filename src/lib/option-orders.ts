/**
 * Options order policy + OCC helpers.  Placement is Alpaca-first.
 *
 * Live options money stays OFF until `optionsLiveOrdersEnabled` is on.
 * Paper place/cancel works when `optionsTradingEnabled` is on and the
 * account is `broker/paper` on Alpaca.  Robinhood stays display-only.
 */

import type { ExecutionMode, OrderSide, TimeInForce } from "./types";

export const OCC_SYMBOL_RE = /^([A-Z]{1,6})\s*(\d{6})([CP])(\d{8})$/;

export type OptionRight = "call" | "put";
export type OptionIntent = "buy_to_open" | "sell_to_close" | "buy_to_close" | "sell_to_open";

export interface OptionContract {
  occSymbol: string;
  underlyingSymbol: string;
  expirationDate: string;
  optionType: OptionRight;
  strikePrice: number;
  multiplier: 100;
}

export interface OptionOrderInput {
  accountNumber: string;
  occSymbol: string;
  intent: OptionIntent;
  quantity: number;
  type: "market" | "limit";
  limitPrice?: number;
  timeInForce?: TimeInForce;
  refId: string;
}

export interface OptionOrderPolicy {
  optionsTradingEnabled?: boolean;
  optionsLiveOrdersEnabled?: boolean;
  activeBroker?: string;
}

export type OptionOrderDecision =
  | { allowed: true; paperOnly: boolean; broker: string }
  | { allowed: false; reason: string };

export function parseOccSymbol(raw: string): OptionContract | undefined {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, "");
  const used = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(compact);
  if (!used) return undefined;
  const underlying = used[1]!;
  const yymmdd = used[2]!;
  const right = used[3] === "P" ? "put" : "call";
  const strikeRaw = Number(used[4]);
  if (!Number.isFinite(strikeRaw) || strikeRaw <= 0) return undefined;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = yymmdd.slice(2, 4);
  const day = yymmdd.slice(4, 6);
  return {
    occSymbol: formatOccSymbol(underlying, `${year}-${month}-${day}`, right, strikeRaw / 1000),
    underlyingSymbol: underlying,
    expirationDate: `${year}-${month}-${day}`,
    optionType: right,
    strikePrice: strikeRaw / 1000,
    multiplier: 100
  };
}

export function formatOccSymbol(
  underlying: string,
  expirationDate: string,
  right: OptionRight,
  strikePrice: number
): string {
  const root = underlying.trim().toUpperCase();
  const date = expirationDate.replace(/-/g, "");
  const yy = date.length === 8 ? date.slice(2) : date;
  const strike = Math.round(strikePrice * 1000);
  return `${root.padEnd(6, " ")}${yy}${right === "put" ? "P" : "C"}${String(strike).padStart(8, "0")}`;
}

export function optionIntentToBrokerSide(intent: OptionIntent): Extract<OrderSide, "buy" | "sell"> {
  return intent === "buy_to_open" || intent === "buy_to_close" ? "buy" : "sell";
}

export function optionNotionalUsd(premium: number, quantity: number): number {
  return Math.abs(premium) * Math.abs(quantity) * 100;
}

/**
 * Gate for place/cancel across all supported brokers. Paper-only until the live flag is on.
 */
export function evaluateOptionOrderPolicy(
  policy: OptionOrderPolicy,
  executionMode: ExecutionMode
): OptionOrderDecision {
  if (policy.optionsTradingEnabled !== true) {
    return { allowed: false, reason: "Options trading is off. Enable Options Trading in Guardrails to place paper option orders." };
  }
  const broker = policy.activeBroker ?? "alpaca";
  if (broker === "robinhood") {
    return { allowed: false, reason: "Option orders are not supported on Robinhood. Robinhood stays display-only." };
  }
  const supported = ["alpaca", "alpaca-mcp", "tradier", "webull", "public", "test"].includes(broker);
  if (!supported) {
    return { allowed: false, reason: `Option orders are not supported on ${broker}.` };
  }
  const normalizedBroker = broker === "alpaca-mcp" ? "alpaca" : broker;
  if (executionMode === "broker/paper") {
    return { allowed: true, paperOnly: true, broker: normalizedBroker };
  }
  if (executionMode === "broker/live") {
    if (policy.optionsLiveOrdersEnabled !== true) {
      return { allowed: false, reason: "Live option orders are off. Paper place/cancel works; turn on Live Option Orders only after a paper round-trip." };
    }
    return { allowed: true, paperOnly: false, broker: normalizedBroker };
  }
  return { allowed: false, reason: "Option orders require a broker paper or live execution mode." };
}

export async function placeGatedOptionOrder(input: {
  order: OptionOrderInput;
  policy: OptionOrderPolicy;
  executionMode: ExecutionMode;
  gateway: {
    placeOptionOrder?: (order: OptionOrderInput) => Promise<{ orderId?: string; state?: string; raw?: unknown }>;
  };
}): Promise<{ ok: true; paperOnly: boolean; result: unknown } | { ok: false; reason: string }> {
  const inputErr = assertOptionOrderInput(input.order);
  if (inputErr) return { ok: false, reason: inputErr };
  const decision = evaluateOptionOrderPolicy(input.policy, input.executionMode);
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  if (!input.gateway.placeOptionOrder) return { ok: false, reason: "This broker cannot place option orders." };
  const result = await input.gateway.placeOptionOrder(input.order);
  return { ok: true, paperOnly: decision.paperOnly, result };
}

export async function cancelGatedOptionOrder(input: {
  accountNumber: string;
  orderId: string;
  policy: OptionOrderPolicy;
  executionMode: ExecutionMode;
  gateway: {
    cancelOptionOrder?: (accountNumber: string, orderId: string) => Promise<unknown>;
  };
}): Promise<{ ok: true; paperOnly: boolean } | { ok: false; reason: string }> {
  const decision = evaluateOptionOrderPolicy(input.policy, input.executionMode);
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  if (!input.gateway.cancelOptionOrder) return { ok: false, reason: "This broker cannot cancel option orders." };
  await input.gateway.cancelOptionOrder(input.accountNumber, input.orderId);
  return { ok: true, paperOnly: decision.paperOnly };
}

export function assertOptionOrderInput(input: OptionOrderInput): string | undefined {
  if (!parseOccSymbol(input.occSymbol)) return "occSymbol must be a valid OCC option symbol.";
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) return "quantity must be a positive whole contract count.";
  if (input.type === "limit" && !(typeof input.limitPrice === "number" && input.limitPrice > 0)) {
    return "limit orders require a positive limitPrice (premium per share).";
  }
  if (!input.refId.trim()) return "refId is required.";
  return undefined;
}
