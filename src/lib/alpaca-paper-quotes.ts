/**
 * Account-scoped Alpaca PAPER `delayed_sip` quote tape.
 *
 * Owner authorization (2026-11-05): the CONNECTED Alpaca PAPER account
 * (`broker=alpaca`, `environment=paper`) trades against Alpaca's `delayed_sip`
 * feed, which carries an expected ~900s (15 minute) publication delay.
 *
 * Design rules that this module owns:
 *
 * 1. ACCOUNT SCOPED, NEVER GLOBAL.  The switch is the connected account row
 *    (`broker` + `environment`), never the process-global `ALPACA_DATA_FEED`
 *    env var.  A live Alpaca account, a Tradier account, Robinhood, and the
 *    operator's env-key path all keep their existing tape.
 * 2. EXPECTED DELAY IS NOT STALENESS.  A quote whose trade time is ~900s old
 *    is the venue behaving as designed.  It must not trip the 120s staleness
 *    gate and must not be aged by `asOf` in a way that discards it.
 * 3. BUT OLD TIMESTAMPS ARE NEVER IGNORED.  Two independent checks must pass:
 *    a. FRESH RETRIEVAL — `fetchedAt` must be recent (the snapshot was really
 *       pulled now), and
 *    b. NO EXCESS DELAY — the `asOf` age must stay within
 *       `expectedDelaySec + tolerance`.  A feed that is lagging far beyond
 *       the documented 900s is broken and is flagged, not silently accepted.
 * 4. NO REALTIME OVERLAY.  A delayed tape priced by the venue is never
 *    replaced by Yahoo / IEX / any fresher secondary, and missing broker data
 *    fails closed rather than silently substituting another tape.
 */

import type { ConnectedAccount } from "./types";

/** Alpaca market-data feed used for the connected PAPER account. */
export const ALPACA_PAPER_DELAYED_FEED = "delayed_sip" as const;

/**
 * Documented publication delay of Alpaca's `delayed_sip` feed: 15 minutes.
 * Measured in prod on 2026-11-05: asOf ages 900-902s, extraLagVs900 ~= 0.
 */
export const ALPACA_PAPER_EXPECTED_DELAY_SEC = 900;

/**
 * Tolerance around the expected delay before the tape is considered
 * EXCESSIVELY delayed (i.e. the feed itself is broken rather than delayed).
 * 120s matches the app's default `maxQuoteAgeSec` so a single stale-feed
 * episode does not immediately flip every symbol to "excess".
 */
export const ALPACA_PAPER_DELAY_TOLERANCE_SEC = 120;

/** Every feed Alpaca's market-data REST endpoints accept. */
export type AlpacaMarketDataFeed = "iex" | "sip" | "otc" | "delayed_sip";

/** Minimal account shape needed for the account-scoped decision. */
export type AlpacaPaperAccountLike =
  | Pick<ConnectedAccount, "broker" | "environment">
  | { broker?: string; environment?: string }
  | null
  | undefined;

/**
 * True only for the connected Alpaca PAPER account.
 *
 * `alpaca-mcp` is deliberately excluded: the MCP transport is a different
 * data path and was not part of the owner authorization.
 */
export function isAlpacaPaperAccount(account: AlpacaPaperAccountLike): boolean {
  if (!account) return false;
  return account.broker === "alpaca" && account.environment === "paper";
}

/**
 * The feed the given connected account must use.  Returns `delayed_sip` for
 * Alpaca PAPER and `undefined` for everything else (the caller then keeps
 * its existing default feed — the SDK default for the broker path, or the
 * process-global `ALPACA_DATA_FEED` for the enrichment path).
 */
export function alpacaPaperFeedForAccount(account: AlpacaPaperAccountLike): AlpacaMarketDataFeed | undefined {
  return isAlpacaPaperAccount(account) ? ALPACA_PAPER_DELAYED_FEED : undefined;
}

/**
 * Cache identity for the Alpaca snapshot enrichment cache.
 *
 * The enrichment cache key is `scope + prefix + symbol` and the scope is
 * derived from the credential source only.  A delayed_sip snapshot and an
 * iex snapshot of the same symbol would therefore collide for the ~30s
 * snapshot TTL.  Folding the account id and the feed into the prefix keeps
 * the two tapes apart and stops one account from serving another account's
 * price.
 */
export function alpacaSnapshotCacheIdentity(
  accountId: string | undefined,
  feed: AlpacaMarketDataFeed | undefined
): string | undefined {
  if (!feed) return undefined;
  return `${accountId ?? "env"}:${feed}`;
}

/** A quote that belongs to a tape with a known expected publication delay. */
export interface DelayedTapeQuote {
  asOf?: string;
  fetchedAt?: string;
  expectedDelaySec?: number;
  delayToleranceSec?: number;
}

export interface DelayedTapeStatus {
  /** True when the quote carries a documented expected delay (delayed tape). */
  delayed: boolean;
  /** Age of the provider observation in seconds (undefined when unknown). */
  asOfAgeSec?: number;
  /** Seconds the tape lags BEYOND `expected + tolerance` (>0 means broken). */
  excessDelaySec?: number;
  /** True when the retrieval itself is recent (fresh `fetchedAt`). */
  retrievalFresh: boolean;
  /** Age of the retrieval in seconds (undefined when unknown). */
  fetchAgeSec?: number;
  /** True only when the tape is fresh AND not excessively delayed. */
  usable: boolean;
}

/**
 * Independent freshness + excess-delay evaluation for a delayed tape.
 *
 * `nowMs` and `maxFetchAgeMs` are injected so the result is deterministic in
 * tests.  `maxFetchAgeMs` defaults to the same 120s window the cascade uses
 * for real-time venues (the "fresh retrieval" requirement).
 */
export function delayedTapeStatus(
  quote: DelayedTapeQuote | null | undefined,
  nowMs: number,
  maxFetchAgeMs: number
): DelayedTapeStatus {
  if (!quote || typeof quote.expectedDelaySec !== "number" || !Number.isFinite(quote.expectedDelaySec)) {
    return { delayed: false, retrievalFresh: false, usable: false };
  }
  const toleranceSec =
    typeof quote.delayToleranceSec === "number" && Number.isFinite(quote.delayToleranceSec)
      ? Math.max(0, quote.delayToleranceSec)
      : ALPACA_PAPER_DELAY_TOLERANCE_SEC;

  const asOfMs = quote.asOf ? new Date(quote.asOf).getTime() : Number.NaN;
  const asOfAgeSec = Number.isNaN(asOfMs) ? undefined : Math.max(0, Math.round((nowMs - asOfMs) / 1000));

  const fetchedMs = quote.fetchedAt ? new Date(quote.fetchedAt).getTime() : Number.NaN;
  const fetchAgeSec = Number.isNaN(fetchedMs) ? undefined : Math.max(0, Math.round((nowMs - fetchedMs) / 1000));
  // Fresh retrieval is INDEPENDENT of the tape delay: a 900s-old print pulled
  // one second ago is a healthy delayed tape; a 2s-old print pulled 10
  // minutes ago is a broken read, not a fresh quote.
  const retrievalFresh =
    fetchAgeSec !== undefined && fetchAgeSec * 1000 <= Math.max(1, maxFetchAgeMs);

  // The expected delay is NORMAL.  Only lag beyond expected + tolerance is
  // excess.  A missing asOf is NOT excess — it is a missing observation, and
  // the caller treats a missing observation as missing data (fail closed).
  const excessDelaySec =
    asOfAgeSec === undefined ? undefined : Math.max(0, asOfAgeSec - (quote.expectedDelaySec + toleranceSec));

  return {
    delayed: true,
    asOfAgeSec,
    excessDelaySec,
    retrievalFresh,
    fetchAgeSec,
    usable: retrievalFresh && excessDelaySec !== undefined && excessDelaySec === 0
  };
}
