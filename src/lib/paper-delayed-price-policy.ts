/**
 * Price choice for an Alpaca PAPER account.
 *
 * Alpaca's paper market reads the `delayed_sip` feed on the market-data API
 * (`data.alpaca.markets`, `feed=delayed_sip`).  That feed is the 15-minute
 * delayed SIP tape, and each quote already carries its print time.  This
 * module prefers that quote and keeps Alpaca's timestamp.
 *
 * When Alpaca returns no price, the caller's other source is kept as-is.
 * A fallback is not relabeled with a synthetic "wall clock minus 15 minutes"
 * as-of.  The account-level note says prices are generally 15-min delayed.
 * Live accounts, Tradier, and every other broker pass through unchanged.
 */

import {
  ALPACA_PAPER_DELAY_TOLERANCE_SEC,
  ALPACA_PAPER_EXPECTED_DELAY_SEC,
  isAlpacaPaperAccount,
  type AlpacaPaperAccountLike
} from "./alpaca-paper-quotes";

export const PAPER_DELAYED_PRICE_LABEL = "15-min delayed" as const;

/** Account-level copy.  Not a per-price print time. */
export const PAPER_DELAYED_PRICE_NOTE = "Prices are generally 15-min delayed.";

export type PaperDelayedPriceLabel = typeof PAPER_DELAYED_PRICE_LABEL;

export interface PaperPriceDelayStamp {
  label: PaperDelayedPriceLabel;
  asOf: string;
}

export interface PaperDelayedPricePolicy {
  active: boolean;
  /**
   * Wall clock minus the documented 15 minutes.  Kept so existing stamps
   * still decode.  It is not applied to a quote: an Alpaca print uses
   * Alpaca's own timestamp, and a fallback keeps its own.
   */
  asOf?: string;
  asOfMs?: number;
  expectedDelaySec: number;
  toleranceSec: number;
  label: PaperDelayedPriceLabel;
}

export type PaperPriceChoiceSource =
  | "passthrough"
  | "delayed_sip"
  | "fallback"
  | "withheld";

export interface DelayablePrice {
  price?: number;
  asOf?: string;
  provider?: string;
  expectedDelaySec?: number;
  venuePriceAuthoritative?: boolean;
  bid?: number;
  ask?: number;
  priceDelayLabel?: PaperDelayedPriceLabel;
}

export interface PaperPriceChoice {
  price?: number;
  asOf?: string;
  bid?: number;
  ask?: number;
  priceDelayLabel?: PaperDelayedPriceLabel;
  withheld: boolean;
  source: PaperPriceChoiceSource;
}

export function paperDelayedPricePolicy(
  account: AlpacaPaperAccountLike,
  nowMs: number = Date.now()
): PaperDelayedPricePolicy {
  const base = {
    expectedDelaySec: ALPACA_PAPER_EXPECTED_DELAY_SEC,
    toleranceSec: ALPACA_PAPER_DELAY_TOLERANCE_SEC,
    label: PAPER_DELAYED_PRICE_LABEL
  };
  if (!isAlpacaPaperAccount(account)) {
    return { ...base, active: false };
  }
  const asOfMs = nowMs - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000;
  return {
    ...base,
    active: true,
    asOfMs,
    asOf: new Date(asOfMs).toISOString()
  };
}

/** Rebuild a policy from a stamp already attached to a scan. */
export function paperPolicyFromStamp(stamp: PaperPriceDelayStamp | undefined): PaperDelayedPricePolicy | undefined {
  if (!stamp) return undefined;
  const asOfMs = Date.parse(stamp.asOf);
  if (!Number.isFinite(asOfMs)) return undefined;
  return {
    active: true,
    asOf: new Date(asOfMs).toISOString(),
    asOfMs,
    expectedDelaySec: ALPACA_PAPER_EXPECTED_DELAY_SEC,
    toleranceSec: ALPACA_PAPER_DELAY_TOLERANCE_SEC,
    label: PAPER_DELAYED_PRICE_LABEL
  };
}

function positivePrice(price: number | undefined): number | undefined {
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : undefined;
}

function isAlpacaDelayedQuote(obs: DelayablePrice): boolean {
  return typeof obs.expectedDelaySec === "number" && Number.isFinite(obs.expectedDelaySec) && obs.expectedDelaySec > 0;
}

function choiceFrom(obs: DelayablePrice, source: PaperPriceChoiceSource, label?: PaperDelayedPriceLabel): PaperPriceChoice {
  return {
    price: positivePrice(obs.price),
    asOf: obs.asOf,
    bid: obs.bid,
    ask: obs.ask,
    priceDelayLabel: label,
    withheld: false,
    source
  };
}

/**
 * Prefer Alpaca's delayed quote and keep its timestamp.  Otherwise keep the
 * first other positive price unchanged.  An inactive policy returns the first
 * positive price with its own as-of and no label.
 */
export function choosePaperPrice(
  candidates: Array<DelayablePrice | null | undefined>,
  policy: PaperDelayedPricePolicy
): PaperPriceChoice {
  const present = candidates.filter((row): row is DelayablePrice => Boolean(row));
  if (!policy.active) {
    const first = present.find((row) => positivePrice(row.price) !== undefined);
    return {
      price: first ? positivePrice(first.price) : undefined,
      asOf: first?.asOf,
      bid: first?.bid,
      ask: first?.ask,
      withheld: false,
      source: "passthrough"
    };
  }

  const delayed = present.find((row) => isAlpacaDelayedQuote(row) && positivePrice(row.price) !== undefined);
  if (delayed) return choiceFrom(delayed, "delayed_sip", policy.label);

  const fallback = present.find((row) => positivePrice(row.price) !== undefined);
  if (fallback) return choiceFrom(fallback, "fallback");

  return {
    withheld: true,
    source: "withheld"
  };
}

export function alignBrokerQuoteRecord<T extends DelayablePrice & { symbol?: string }>(
  quotes: Record<string, T>,
  policy: PaperDelayedPricePolicy
): Record<string, T> {
  if (!policy.active) return quotes;
  const next: Record<string, T> = {};
  for (const [symbol, quote] of Object.entries(quotes)) {
    const chosen = choosePaperPrice([quote], policy);
    if (chosen.withheld || chosen.price === undefined) continue;
    next[symbol] = {
      ...quote,
      price: chosen.price,
      asOf: chosen.asOf,
      bid: chosen.bid,
      ask: chosen.ask,
      priceDelayLabel: chosen.priceDelayLabel
    };
  }
  return next;
}
