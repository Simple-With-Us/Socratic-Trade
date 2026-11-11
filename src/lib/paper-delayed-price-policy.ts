/**
 * One delayed-price clock for an Alpaca PAPER account.
 *
 * Alpaca's paper market fills on `delayed_sip` (~900s).  Scan rows, Yahoo,
 * charts, and broker marks were free to show a different print.  This module
 * is the only place that decides which price a paper account may show or
 * trade on:
 *
 * 1. Prefer an Alpaca `delayed_sip` observation whose print time sits in the
 *    expected window.
 * 2. Otherwise keep another source only when its print is already in that
 *    window, or when it is the Nasdaq delayed screener with no precise print
 *    time.  Those prices are relabeled to the SAME as-of.
 * 3. A fresher print is withheld.  Minute bars, when the caller has them, may
 *    be rewound to the last bar inside the window.
 * 4. Live accounts, Tradier, and every other broker pass through unchanged.
 */

import {
  ALPACA_PAPER_CLOCK_SKEW_SLACK_SEC,
  ALPACA_PAPER_DELAY_TOLERANCE_SEC,
  ALPACA_PAPER_EXPECTED_DELAY_SEC,
  isAlpacaPaperAccount,
  type AlpacaPaperAccountLike
} from "./alpaca-paper-quotes";

export const PAPER_DELAYED_PRICE_LABEL = "15-min delayed" as const;

export type PaperDelayedPriceLabel = typeof PAPER_DELAYED_PRICE_LABEL;

export interface PaperPriceDelayStamp {
  label: PaperDelayedPriceLabel;
  asOf: string;
}

export interface PaperDelayedPricePolicy {
  active: boolean;
  asOf?: string;
  asOfMs?: number;
  expectedDelaySec: number;
  toleranceSec: number;
  label: PaperDelayedPriceLabel;
}

export type PaperPriceChoiceSource =
  | "passthrough"
  | "delayed_sip"
  | "aligned"
  | "older"
  | "rewound"
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

export interface RewindBar {
  timeMs: number;
  price: number;
}

/**
 * Providers whose product is already a delayed tape but which often omit a
 * precise print timestamp (the Nasdaq screener's payload as-of is frequently
 * a session date).  A fresher feed such as the Yahoo chart quote is NOT in
 * this set: without a print time inside the window it is withheld.
 */
const KNOWN_DELAYED_PROVIDERS = new Set([
  "nasdaq-delayed-screener",
  "yahoo-finance-delayed",
  "yahoo-finance-delayed-quotes"
]);

const RANK = {
  sip: 0,
  window: 1,
  known: 2,
  older: 3,
  reject: 4
} as const;

type RankName = keyof typeof RANK;

interface Classified {
  rank: RankName;
  obs: DelayablePrice;
  asOf?: string;
  distanceMs: number;
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

/** Rebuild a policy from a stamp already attached to a scan, so a later merge uses the same as-of. */
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

function observationMs(asOf: string | undefined): number | undefined {
  if (!asOf) return undefined;
  const ms = Date.parse(asOf);
  return Number.isFinite(ms) ? ms : undefined;
}

function isDateOnly(asOf: string | undefined): boolean {
  return typeof asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asOf.trim());
}

function isDelayedSip(obs: DelayablePrice): boolean {
  return typeof obs.expectedDelaySec === "number" && Number.isFinite(obs.expectedDelaySec) && obs.expectedDelaySec > 0;
}

function withinWindow(obsMs: number, policy: PaperDelayedPricePolicy): boolean {
  const canonical = policy.asOfMs;
  if (canonical === undefined) return false;
  return Math.abs(obsMs - canonical) <= policy.toleranceSec * 1000;
}

function classify(obs: DelayablePrice, policy: PaperDelayedPricePolicy): Classified | undefined {
  if (positivePrice(obs.price) === undefined) return undefined;
  const ms = observationMs(obs.asOf);
  const canonical = policy.asOfMs ?? 0;
  const distanceMs = ms === undefined ? Number.POSITIVE_INFINITY : Math.abs(ms - canonical);
  const sip = isDelayedSip(obs);
  if (sip && (ms === undefined || withinWindow(ms, policy))) {
    return { rank: "sip", obs, asOf: policy.asOf, distanceMs };
  }
  if (ms !== undefined && withinWindow(ms, policy)) {
    return { rank: "window", obs, asOf: policy.asOf, distanceMs };
  }
  const provider = obs.provider?.trim().toLowerCase();
  if (provider && KNOWN_DELAYED_PROVIDERS.has(provider) && (ms === undefined || isDateOnly(obs.asOf))) {
    return { rank: "known", obs, asOf: policy.asOf, distanceMs };
  }
  if (ms !== undefined && ms < canonical - policy.toleranceSec * 1000) {
    return { rank: "older", obs, asOf: obs.asOf, distanceMs };
  }
  return { rank: "reject", obs, distanceMs };
}

function choiceFrom(classified: Classified, policy: PaperDelayedPricePolicy, source: PaperPriceChoiceSource): PaperPriceChoice {
  return {
    price: positivePrice(classified.obs.price),
    asOf: classified.asOf,
    bid: classified.obs.bid,
    ask: classified.obs.ask,
    priceDelayLabel: policy.label,
    withheld: false,
    source
  };
}

function sourceForRank(rank: RankName): PaperPriceChoiceSource {
  switch (rank) {
    case "sip":
      return "delayed_sip";
    case "window":
    case "known":
      return "aligned";
    case "older":
      return "older";
    case "reject":
      return "withheld";
    default: {
      const neverRank: never = rank;
      return neverRank;
    }
  }
}

function rewind(bars: RewindBar[] | undefined, policy: PaperDelayedPricePolicy): PaperPriceChoice | undefined {
  const canonical = policy.asOfMs;
  if (!bars || bars.length === 0 || canonical === undefined) return undefined;
  const cutoff = canonical + ALPACA_PAPER_CLOCK_SKEW_SLACK_SEC * 1000;
  let best: RewindBar | undefined;
  for (const bar of bars) {
    if (!(bar.price > 0) || !Number.isFinite(bar.timeMs)) continue;
    if (bar.timeMs > cutoff) continue;
    if (!withinWindow(bar.timeMs, policy)) continue;
    if (!best || bar.timeMs > best.timeMs) best = bar;
  }
  if (!best) return undefined;
  return {
    price: best.price,
    asOf: policy.asOf,
    priceDelayLabel: policy.label,
    withheld: false,
    source: "rewound"
  };
}

/**
 * Pick the price a paper account may show.  Every accepted in-window price
 * shares `policy.asOf`.  An inactive policy returns the first positive price
 * with its own as-of and no label.
 */
export function choosePaperPrice(
  candidates: Array<DelayablePrice | null | undefined>,
  policy: PaperDelayedPricePolicy,
  bars?: RewindBar[]
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

  let best: Classified | undefined;
  for (const obs of present) {
    const classified = classify(obs, policy);
    if (!classified || classified.rank === "reject") continue;
    if (
      !best ||
      RANK[classified.rank] < RANK[best.rank] ||
      (classified.rank === best.rank && classified.distanceMs < best.distanceMs)
    ) {
      best = classified;
    }
  }
  if (best) return choiceFrom(best, policy, sourceForRank(best.rank));

  const rewound = rewind(bars, policy);
  if (rewound) return rewound;

  return {
    asOf: policy.asOf,
    priceDelayLabel: policy.label,
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
