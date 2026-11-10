import { dataSourceFetch } from "./data-source-fetch";
import { isAbortOrTimeoutError } from "./network-errors";
import { withProviderLimit } from "./provider-rate-limit";
import { BROWSER_UA } from "./web-sources/http";
import { YahooChartResponseSchema, YahooV7QuoteResponseSchema } from "./yahoo-schemas";
import {
  getYahooSessionCreds,
  invalidateYahooSessionCreds,
  YAHOO_SESSION_UA
} from "./yahoo-session";

/** Call-site options. userId selects that user's data-source proxy (when set);
 *  without it the operator env / residential default applies. */
export interface YahooFetchOptions {
  userId?: string;
  signal?: AbortSignal;
  /** Chart-pool calls pass the fallback deadline so retries/timeouts stay in budget. */
  deadlineAt?: number;
}

export interface YahooFinanceQuote {
  /** Exchange-reported issuer identity from chart metadata (longName/shortName). */
  companyName?: string;
  price: number;
  bid: number;
  ask: number;
  /** Previous regular-session close.  Undefined when Yahoo does not report one — never
   *  defaulted to the current price (that fabricates a 0% intraday change). */
  prevClose?: number;
  volume: number;
  /** ISO timestamp of the quote (from meta.regularMarketTime) — the real "as of", not a daily-bar date. */
  asOf?: string;
  /** true when bid/ask were SYNTHESIZED from price (the chart endpoint has no real quote spread) rather
   *  than reported by Yahoo. Consumers must not treat a synthetic ask as a real quoted ask (e.g. for
   *  ask-relative limit pricing) — it is only a rough placeholder derived from the last price.
   *  `syntheticSpread` stays true only when BOTH sides were derived (for back-compat); the side-specific
   *  flags below tell you exactly which side is synthetic, so the REAL side of a one-sided quote is
   *  preserved rather than being blanket-tagged synthetic. */
  syntheticSpread?: boolean;
  /** true when the BID was derived from price (Yahoo reported no real bid). */
  syntheticBid?: boolean;
  /** true when the ASK was derived from price (Yahoo reported no real ask). */
  syntheticAsk?: boolean;
  /**
   * Optional keyless fundamentals. Chart meta already carries the 52-week range
   * on the same payload as price/volume. PE/EPS/div/beta live on crumb-authed
   * quoteSummary (YahooFinanceEnrichmentProvider) — never fabricated here.
   */
  peRatio?: number;
  eps?: number;
  dividendYield?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  open?: number;
  high?: number;
  low?: number;
  change?: number;
  changePct?: number;
}

export type YahooQuoteTelemetryKind =
  | "v7_batch_complete"
  | "v7_auth_wall"
  | "v7_session_unavailable"
  | "v7_chunk_abort"
  | "v7_chunk_empty"
  | "chart_quote_abort";

export interface YahooQuoteTelemetry {
  kind: YahooQuoteTelemetryKind;
  symbolsRequested?: number;
  symbolsPriced?: number;
  v7Chunks?: number;
  v7ChunksOk?: number;
  v7ChunksAuth?: number;
  v7ChunksAbort?: number;
  v7SkippedCooldown?: boolean;
  v7SkippedNoSession?: boolean;
  chartAttempts?: number;
  chartAborts?: number;
}

let lastYahooQuoteTelemetry: YahooQuoteTelemetry | undefined;

export function peekLastYahooQuoteTelemetry(): YahooQuoteTelemetry | undefined {
  return lastYahooQuoteTelemetry;
}

export function __resetYahooQuoteTelemetryForTests(): void {
  lastYahooQuoteTelemetry = undefined;
}

function emitYahooQuoteTelemetry(payload: YahooQuoteTelemetry): void {
  lastYahooQuoteTelemetry = payload;
  console.warn("[yahoo-finance]", JSON.stringify({ ...payload, ts: Date.now() }));
}

function jitteredBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp + Math.random() * Math.min(250, baseMs));
}

function optionalFinite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalPositive(value: unknown): number | undefined {
  const n = optionalFinite(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** Fields the keyless chart endpoint actually returns (today: 52-week range). */
export function yahooFundamentalsFromRecord(row: Record<string, unknown>): Pick<
  YahooFinanceQuote,
  "peRatio" | "eps" | "dividendYield" | "beta" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow"
> {
  const peRatio = optionalPositive(row.trailingPE ?? row.peRatio);
  const eps = optionalFinite(row.epsTrailingTwelveMonths ?? row.eps);
  const beta = optionalFinite(row.beta);
  const fiftyTwoWeekHigh = optionalPositive(row.fiftyTwoWeekHigh);
  const fiftyTwoWeekLow = optionalPositive(row.fiftyTwoWeekLow);
  return {
    ...(peRatio !== undefined ? { peRatio } : {}),
    ...(eps !== undefined ? { eps } : {}),
    ...(beta !== undefined ? { beta } : {}),
    ...(fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh } : {}),
    ...(fiftyTwoWeekLow !== undefined ? { fiftyTwoWeekLow } : {})
  };
}

/** Map a chart `meta` object (plus optional indicator volume) into a quote. */
export function yahooQuoteFromChartMeta(
  meta: Record<string, unknown>,
  volumeHint?: number
): YahooFinanceQuote | undefined {
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const companyName = [meta.longName, meta.shortName]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const prevCloseRaw = meta.chartPreviousClose ? Number(meta.chartPreviousClose) : NaN;
  const prevClose = Number.isFinite(prevCloseRaw) && prevCloseRaw > 0 ? prevCloseRaw : undefined;
  const volume = Number(meta.regularMarketVolume ?? volumeHint ?? 0);
  const t = Number(meta.regularMarketTime);
  const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;
  return {
    ...(companyName ? { companyName } : {}),
    price,
    bid: price * 0.999,
    ask: price * 1.001,
    ...(prevClose !== undefined ? { prevClose } : {}),
    volume,
    asOf,
    syntheticBid: true,
    syntheticAsk: true,
    syntheticSpread: true,
    ...yahooFundamentalsFromRecord(meta)
  };
}

export const YAHOO_CHART_QUOTE_TIMEOUT_MS = 9_000;
export const YAHOO_CHART_QUOTE_MAX_ATTEMPTS = 3;
export const YAHOO_CHART_FALLBACK_QUOTE_TIMEOUT_MS = 5_000;
export const YAHOO_CHART_FALLBACK_MAX_ATTEMPTS = 2;
export const YAHOO_CHART_QUOTE_BACKOFF_MS = 400;

function chartAttemptBudget(options?: YahooFetchOptions): {
  maxAttempts: number;
  perAttemptTimeoutMs: number;
} {
  if (options?.deadlineAt !== undefined) {
    return {
      maxAttempts: YAHOO_CHART_FALLBACK_MAX_ATTEMPTS,
      perAttemptTimeoutMs: YAHOO_CHART_FALLBACK_QUOTE_TIMEOUT_MS
    };
  }
  return {
    maxAttempts: YAHOO_CHART_QUOTE_MAX_ATTEMPTS,
    perAttemptTimeoutMs: YAHOO_CHART_QUOTE_TIMEOUT_MS
  };
}

export async function fetchYahooFinanceQuote(
  symbol: string,
  options?: YahooFetchOptions
): Promise<YahooFinanceQuote | undefined> {
  const clean = encodeURIComponent(symbol.toUpperCase());
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${clean}?interval=1d&range=1d`;
  const callerSignal = options?.signal;
  if (callerSignal?.aborted) return undefined;
  const userId = options?.userId;
  const deadlineAt = options?.deadlineAt;
  const { maxAttempts, perAttemptTimeoutMs } = chartAttemptBudget(options);

  let chartAborts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (callerSignal?.aborted) return undefined;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) return undefined;
    try {
      const response = await withProviderLimit("yahoo-finance", async () => {
        if (callerSignal?.aborted) {
          throw callerSignal.reason ?? new DOMException("aborted", "AbortError");
        }
        const remainingMs =
          deadlineAt === undefined ? perAttemptTimeoutMs : Math.min(perAttemptTimeoutMs, deadlineAt - Date.now());
        if (remainingMs <= 0) {
          throw new DOMException("aborted", "AbortError");
        }
        const controller = new AbortController();
        const onCallerAbort = (): void => controller.abort();
        if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        const timeout = setTimeout(() => controller.abort(), remainingMs);
        try {
          return await dataSourceFetch(
            url,
            {
              cache: "no-store",
              signal: controller.signal,
              headers: { "user-agent": BROWSER_UA, accept: "application/json" }
            },
            { userId }
          );
        } finally {
          clearTimeout(timeout);
          callerSignal?.removeEventListener("abort", onCallerAbort);
        }
      });

      if (response.status === 429 && attempt < maxAttempts - 1) {
        const backoff = jitteredBackoffMs(attempt, YAHOO_CHART_QUOTE_BACKOFF_MS, 4_000);
        if (deadlineAt !== undefined && Date.now() + backoff >= deadlineAt) return undefined;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      if (!response.ok) return undefined;
      const raw = await response.json();
      const parsed = YahooChartResponseSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const chartResult = parsed.data.chart?.result?.[0];
      const meta = chartResult?.meta;
      if (!meta) return undefined;
      const volumeArr = chartResult?.indicators?.quote?.[0]?.volume;
      const volumeHint = Number(volumeArr?.[0] ?? 0);
      return yahooQuoteFromChartMeta(
        meta as Record<string, unknown>,
        Number.isFinite(volumeHint) ? volumeHint : undefined
      );
    } catch (error) {
      if (isAbortOrTimeoutError(error)) {
        chartAborts += 1;
        if (attempt < maxAttempts - 1) {
          const backoff = jitteredBackoffMs(attempt, YAHOO_CHART_QUOTE_BACKOFF_MS, 2_000);
          if (deadlineAt !== undefined && Date.now() + backoff >= deadlineAt) return undefined;
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        emitYahooQuoteTelemetry({ kind: "chart_quote_abort", chartAborts, chartAttempts: attempt + 1 });
      }
      return undefined;
    }
  }
  return undefined;
}

/** How long a v7 batch 401/403 (crumb/cookie auth wall) suppresses further v7 calls process-wide. */
export const YAHOO_V7_AUTH_COOLDOWN_MS = 10 * 60 * 1000;

/** Per-chunk HTTP budget starts only after the yahoo-finance pacer slot is acquired. */
export const YAHOO_V7_CHUNK_TIMEOUT_MS = 10_000;
export const YAHOO_V7_CHUNK_MAX_ATTEMPTS = 2;
/** Stop further v7 waves after this many chunks exhausted retries (proxy pressure). */
export const YAHOO_V7_ABORT_WAVE_BREAK = 2;

type YahooFinanceHost = typeof globalThis & {
  __yahooV7AuthBlockedUntilMs?: number;
};

const yahooFinanceHost = globalThis as YahooFinanceHost;

function v7AuthBlockedUntilMs(): number {
  return yahooFinanceHost.__yahooV7AuthBlockedUntilMs ?? 0;
}

function setV7AuthBlockedUntilMs(value: number): void {
  yahooFinanceHost.__yahooV7AuthBlockedUntilMs = value;
}

function isYahooV7AuthBlocked(now: number = Date.now()): boolean {
  return now < v7AuthBlockedUntilMs();
}

function markYahooV7AuthBlocked(): void {
  const now = Date.now();
  if (now < v7AuthBlockedUntilMs()) return;
  setV7AuthBlockedUntilMs(now + YAHOO_V7_AUTH_COOLDOWN_MS);
  emitYahooQuoteTelemetry({ kind: "v7_auth_wall" });
}

/** Test-only reset for the v7 auth cooldown. */
export function __resetYahooV7AuthCooldownForTests(): void {
  setV7AuthBlockedUntilMs(0);
}

/** Bounded pool for the per-symbol chart fallback: matches the proxy gate cap
 *  (DEFAULT_PROXY_MAX_CONCURRENCY in proxy-fetch.ts) so fallback requests do
 *  not queue behind each other inside the gate and abort on their own timers
 *  before a slot frees up (prod 2026-11-06). */
export const YAHOO_CHART_FALLBACK_CONCURRENCY = 4;

/** Own overall budget for the chart fallback. Launching stops after this and
 *  whatever priced so far is returned. It starts when the fallback starts, so
 *  an upstream batch abort/timeout can never consume the fallback's budget. */
export const YAHOO_CHART_FALLBACK_DEADLINE_MS = 45_000;

/** Per-symbol chart quotes with bounded concurrency and an overall deadline.
 *  Each request's timer starts only when a pool slot picks the symbol up. */
export async function fetchYahooFinanceChartQuotes(
  symbols: string[],
  options?: { concurrency?: number; deadlineMs?: number; userId?: string; signal?: AbortSignal }
): Promise<Map<string, YahooFinanceQuote>> {
  const result = new Map<string, YahooFinanceQuote>();
  const queue = Array.from(new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
  if (queue.length === 0) return result;
  const concurrency = Math.max(1, options?.concurrency ?? YAHOO_CHART_FALLBACK_CONCURRENCY);
  const deadlineAt = Date.now() + Math.max(0, options?.deadlineMs ?? YAHOO_CHART_FALLBACK_DEADLINE_MS);
  const userId = options?.userId;
  const signal = options?.signal;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const symbol = queue.shift();
      if (symbol === undefined) return;
      if (Date.now() >= deadlineAt || signal?.aborted) return;
      const quote = await fetchYahooFinanceQuote(symbol, {
        userId,
        signal,
        deadlineAt
      });
      if (quote) result.set(symbol, quote);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return result;
}

export async function fetchYahooFinanceQuotesBatch(
  symbols: string[],
  options?: { concurrency?: number; userId?: string }
): Promise<Map<string, YahooFinanceQuote>> {
  const result = new Map<string, YahooFinanceQuote>();
  const requested = symbols.length;
  if (requested === 0) return result;

  const stats = {
    v7Chunks: 0,
    v7ChunksOk: 0,
    v7ChunksAuth: 0,
    v7ChunksAbort: 0,
    v7SkippedCooldown: false,
    v7SkippedNoSession: false
  };

  if (isYahooV7AuthBlocked()) {
    stats.v7SkippedCooldown = true;
    emitYahooQuoteTelemetry({
      kind: "v7_batch_complete",
      symbolsRequested: requested,
      symbolsPriced: 0,
      ...stats
    });
    return result;
  }

  let sessionCreds: Awaited<ReturnType<typeof getYahooSessionCreds>> | undefined;
  try {
    sessionCreds = await getYahooSessionCreds(options?.userId);
  } catch {
    stats.v7SkippedNoSession = true;
    emitYahooQuoteTelemetry({
      kind: "v7_session_unavailable",
      symbolsRequested: requested,
      symbolsPriced: 0,
      ...stats
    });
    return result;
  }

  const chunkSize = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 1, 4));

  for (let i = 0; i < chunks.length; i += concurrency) {
    if (isYahooV7AuthBlocked()) break;
    if (stats.v7ChunksAbort >= YAHOO_V7_ABORT_WAVE_BREAK) break;
    const wave = chunks.slice(i, i + concurrency);
    const maps = await Promise.all(
      wave.map((chunk) => fetchYahooQuoteChunk(chunk, sessionCreds!, options?.userId, stats))
    );
    for (const map of maps) {
      for (const [symbol, quote] of map) result.set(symbol, quote);
    }
    if (isYahooV7AuthBlocked()) break;
    if (stats.v7ChunksAbort >= YAHOO_V7_ABORT_WAVE_BREAK) break;
  }

  emitYahooQuoteTelemetry({
    kind: "v7_batch_complete",
    symbolsRequested: requested,
    symbolsPriced: result.size,
    ...stats
  });
  return result;
}

type V7ChunkStats = {
  v7Chunks: number;
  v7ChunksOk: number;
  v7ChunksAuth: number;
  v7ChunksAbort: number;
};

async function fetchYahooQuoteChunk(
  chunk: string[],
  creds: { cookie: string; crumb: string },
  userId: string | undefined,
  stats: V7ChunkStats
): Promise<Map<string, YahooFinanceQuote>> {
  const result = new Map<string, YahooFinanceQuote>();
  const cleanSymbols = chunk.map((s) => encodeURIComponent(s.toUpperCase().trim())).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${cleanSymbols}&crumb=${encodeURIComponent(creds.crumb)}`;

  stats.v7Chunks += 1;

  for (let attempt = 0; attempt < YAHOO_V7_CHUNK_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await withProviderLimit("yahoo-finance", async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), YAHOO_V7_CHUNK_TIMEOUT_MS);
        try {
          return await dataSourceFetch(
            url,
            {
              cache: "no-store",
              signal: controller.signal,
              headers: {
                "user-agent": YAHOO_SESSION_UA,
                Cookie: creds.cookie,
                accept: "application/json"
              }
            },
            { userId }
          );
        } finally {
          clearTimeout(timeout);
        }
      });

      if (response.status === 401 || response.status === 403) {
        stats.v7ChunksAuth += 1;
        invalidateYahooSessionCreds(userId);
        markYahooV7AuthBlocked();
        return result;
      }
      if (!response.ok) {
        emitYahooQuoteTelemetry({ kind: "v7_chunk_empty", v7Chunks: stats.v7Chunks });
        return result;
      }

      const raw = await response.json();
      const parsed = YahooV7QuoteResponseSchema.safeParse(raw);
      if (!parsed.success) {
        emitYahooQuoteTelemetry({ kind: "v7_chunk_empty", v7Chunks: stats.v7Chunks });
        return result;
      }

      const items = parsed.data.quoteResponse?.result;
      if (!items || items.length === 0) {
        emitYahooQuoteTelemetry({ kind: "v7_chunk_empty", v7Chunks: stats.v7Chunks });
        return result;
      }

      for (const item of items) {
        if (!item.symbol) continue;
        const price = Number(item.regularMarketPrice);
        if (!Number.isFinite(price) || price <= 0) continue;
        const prevClose = optionalPositive(item.regularMarketPreviousClose);
        const open = optionalPositive(item.regularMarketOpen);
        const high = optionalPositive(item.regularMarketDayHigh);
        const low = optionalPositive(item.regularMarketDayLow);
        const change = optionalFinite(item.regularMarketChange);
        const changePct = optionalFinite(item.regularMarketChangePercent);
        const companyName = [item.longName, item.shortName]
          .find((v): v is string => typeof v === "string" && v.trim().length > 0)
          ?.trim();
        const peRatio = optionalPositive(item.trailingPE);
        const fiftyTwoWeekHigh = optionalPositive(item.fiftyTwoWeekHigh);
        const fiftyTwoWeekLow = optionalPositive(item.fiftyTwoWeekLow);

        const syntheticBid = !(item.bid && item.bid > 0);
        const syntheticAsk = !(item.ask && item.ask > 0);
        const hasRealSpread = !syntheticBid && !syntheticAsk;
        const bid = syntheticBid ? price * 0.999 : Number(item.bid);
        const ask = syntheticAsk ? price * 1.001 : Number(item.ask);
        const volume = Number(item.regularMarketVolume ?? 0);
        const t = Number(item.regularMarketTime);
        const asOf = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : undefined;

        result.set(item.symbol.toUpperCase().trim(), {
          price,
          bid,
          ask,
          volume,
          asOf,
          ...(prevClose !== undefined ? { prevClose } : {}),
          ...(open !== undefined ? { open } : {}),
          ...(high !== undefined ? { high } : {}),
          ...(low !== undefined ? { low } : {}),
          ...(change !== undefined ? { change } : {}),
          ...(changePct !== undefined ? { changePct } : {}),
          ...(companyName ? { companyName } : {}),
          ...(peRatio !== undefined ? { peRatio } : {}),
          ...(fiftyTwoWeekHigh !== undefined ? { fiftyTwoWeekHigh } : {}),
          ...(fiftyTwoWeekLow !== undefined ? { fiftyTwoWeekLow } : {}),
          syntheticBid,
          syntheticAsk,
          ...(hasRealSpread ? {} : { syntheticSpread: true })
        });
      }

      if (result.size > 0) stats.v7ChunksOk += 1;
      else emitYahooQuoteTelemetry({ kind: "v7_chunk_empty", v7Chunks: stats.v7Chunks });
      return result;
    } catch (error) {
      if (isAbortOrTimeoutError(error) && attempt < YAHOO_V7_CHUNK_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, jitteredBackoffMs(attempt, 300, 1_500))
        );
        continue;
      }
      if (isAbortOrTimeoutError(error)) {
        stats.v7ChunksAbort += 1;
        emitYahooQuoteTelemetry({
          kind: "v7_chunk_abort",
          v7ChunksAbort: stats.v7ChunksAbort,
          v7Chunks: stats.v7Chunks
        });
      }
      return result;
    }
  }

  return result;
}
