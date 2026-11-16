// polymarket-provider.ts — keyless Polymarket prediction-market context for the strategist prompt.
//
// Implementable subset of the "social-sentiment lesson" (real-money crowd odds as LLM context):
// Reddit/X stay blocked on owner-provisioned API keys and are OUT of scope here. Polymarket's
// public Gamma API needs no key at all, so this module never creates, holds, or checks any
// credential (owner ruling — CLAUDE.md "NEVER create a new provider API key").
//
// ── API shape (LIVE-VERIFIED 2026-08-12, not training-data memory) ─────────────────────────────
// GET https://gamma-api.polymarket.com/public-search?q=<text>&limit_per_type=<n>
//   -> { events: [ { id, title, active, closed, archived,
//                     markets: [ { id, question,
//                                  outcomes: '["Yes","No"]'       (JSON-encoded STRING, not an array),
//                                  outcomePrices: '["0.905","0.095"]' (also a JSON-encoded string,
//                                                                      index-aligned with outcomes),
//                                  volume: number|string (LIVE-VERIFIED as a decimal STRING, e.g.
//                                                          "268663.894..." — toFiniteNumber below
//                                                          parses either shape), volume24hr: number|null,
//                                  active: boolean, closed: boolean, archived: boolean } ] } ],
//        pagination: { hasMore, totalResults } }
// Confirmed live: HTTP 200, no API key/auth header required or accepted; response carries
// `cache-control: public, max-age=300` (the upstream CDN itself caches 5 minutes) and no documented
// rate-limit headers. `q` is a loose text match against event/market titles — a company-name query
// ("apple") returns markets literally about that company; a bare-ticker query ("TSLA") also works
// (Polymarket runs its own periodic price-range markets that name the ticker directly). Both shapes
// are filtered through the exact same scoreHeadlineRelevance() rubric every other keyless provider
// in this app uses (news-relevance.ts), so an unrelated same-word hit is dropped exactly like a news
// headline would be — including the ambiguous-company-name corroboration gate ("Meta", "Block",
// "Shell", ...).
//
// ── Design ───────────────────────────────────────────────────────────────────────────────────
// This is a PROMPT-TIME provider, not a scan-wide one: it runs only over the candidates about to
// enter the LLM call (strategy.ts's proposeTrades, mirroring how getUpcomingEconomicEventsForPrompt
// and the RAG dossier pass are fetched at that same seam) — never through data-providers.ts's
// CascadingEnrichmentProvider, so it is deliberately absent from EnrichmentSourcedField/takeScalar/
// EMPTY_SOURCED (same posture as evidenceBulletins, which also bypasses that scalar cascade).
// One /public-search request per unique symbol (query = companyName ?? symbol), in-process cached
// 10 minutes (matches the upstream CDN's own edge cache with headroom), bounded to at most
// POLYMARKET_MAX_SYMBOLS_PER_RUN distinct symbols per call — a deliberate ceiling since this is
// prompt-time enrichment for the top-N candidates, not a scan-wide budget.
// Fails open on ANY error (network, malformed JSON, unexpected shape, disabled knob): a symbol that
// errors or has no relevant live market simply gets no entry — never a fabricated market, never an
// empty-array placeholder.
//
// ── Health/observability ─────────────────────────────────────────────────────────────────────
// fetchWithRetry(..., { service: "polymarket" }) below writes api_health_log rows exactly like every
// other provider; getServiceHealthSummaries() (src/lib/db-health.ts) derives its dependency list
// dynamically from `SELECT DISTINCT service FROM api_health_log` — there is no static map to edit,
// and nothing here adds a per-tick network call: a health row is written only when this module
// actually fires (i.e. once per LLM-bound strategy run touching real candidates).

import { fetchWithRetry } from "./data-providers";
import { scoreHeadlineRelevance } from "./news-relevance";
import { audit } from "./db";
import { normalizeSymbol } from "./money";
import { resolveSourceBool, resolveSourceNumber } from "./source-settings";
import {
  POLYMARKET_MACRO_CATALOG,
  POLYMARKET_THEME_CATALOG,
  bookDepthFrom,
  classifyMarketKind,
  crowdLeanFromYes,
  isUsScopedQuestion,
  parseYesNoPercents,
  themesForQuote,
  tiltFrom,
  yesImpliesForKind,
  type PolymarketBookDepth,
  type PolymarketCrowdLean,
  type PolymarketEquityTilt,
  type PolymarketMarketKind,
  type PolymarketScope
} from "./polymarket-signals";

export type {
  PolymarketBookDepth,
  PolymarketCrowdLean,
  PolymarketEquityTilt,
  PolymarketMarketKind,
  PolymarketScope
} from "./polymarket-signals";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

/** One currently-active Polymarket market, optionally translated into a labeled tilt. */
export interface PolymarketMarketMatch {
  question: string;
  /** 0-100, 1dp — the probability of this market's most-likely outcome (whichever side of the
   *  market currently has the higher implied price; see impliedProbabilityFromOutcomes). */
  impliedProbabilityPct: number;
  /** The outcome label the probability refers to (e.g. "Yes"/"No"), when the API provided one. */
  outcomeLabel?: string;
  volume24h?: number;
  volumeTotal?: number;
  scope?: PolymarketScope;
  themeId?: string;
  kind?: PolymarketMarketKind;
  yesPct?: number;
  noPct?: number;
  crowdLean?: PolymarketCrowdLean;
  yesImplies?: PolymarketEquityTilt;
  tilt?: PolymarketEquityTilt;
  tiltBasis?: string;
  bookDepth?: PolymarketBookDepth;
}

// In-process cache: news moves in minutes, and the upstream CDN itself caches 5 minutes — 10
// minutes gives headroom without going stale for a same-run repeat lookup (e.g. a held position
// that is also a scan candidate).
const DEFAULT_TTL_MS = 10 * 60_000;
// Exported so the prompt-assembly layer (strategy.ts) can state the REAL cache-age upper bound in
// the strategist prompt's block-level freshness note (data-age audit, 2026-08-13) instead of
// hardcoding a duplicate constant that could drift from this one.
export function polymarketTtlMs(): number {
  const value = Number(process.env.POLYMARKET_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
}

// Conservative per-run ceiling on distinct network requests. This module is prompt-time
// enrichment for the top-N candidates entering ONE LLM call, not a scan-wide provider — 20 comfortably
// covers a normal candidate list while keeping a pathological candidate count from firing unbounded
// requests against a third party we have no SLA with.
const DEFAULT_MAX_SYMBOLS_PER_RUN = 20;
function polymarketMaxSymbolsPerRun(): number {
  const value = Number(process.env.POLYMARKET_MAX_SYMBOLS_PER_RUN);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_SYMBOLS_PER_RUN;
}

/** At most this many markets kept per symbol (spec-bounded, mirrors HEADLINES_PER_CANDIDATE). */
export const MAX_MARKETS_PER_SYMBOL = 3;

// Modest concurrency — a keyless third-party CDN endpoint with no documented rate limit still
// deserves gentle pacing rather than firing up to DEFAULT_MAX_SYMBOLS_PER_RUN requests at once.
const CONCURRENCY = 4;

// Per-query result set from /public-search; large enough to find the relevant market(s) among
// same-day noise (sports/politics events sharing generic words) without over-fetching.
const SEARCH_LIMIT_PER_TYPE = 10;

interface GammaMarket {
  question?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  volume?: unknown;
  volume24hr?: unknown;
  active?: unknown;
  closed?: unknown;
  archived?: unknown;
}

interface GammaEvent {
  markets?: unknown;
}

const searchCache = new Map<string, { expiresAt: number; markets: GammaMarket[] }>();

/** Test helper: clear the cache between runs. */
export function clearPolymarketCache(): void {
  searchCache.clear();
}

function parseJsonStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toFiniteNumber(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Tolerates the documented `{ events: [...] }` envelope only; anything else (malformed payload,
 *  missing/non-array `events`, non-object rows) yields [] rather than throwing — a malformed
 *  response must produce no markets, never a fabricated one. */
export function extractGammaMarkets(payload: unknown): GammaMarket[] {
  if (!payload || typeof payload !== "object") return [];
  const events = (payload as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const markets: GammaMarket[] = [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const eventMarkets = (rawEvent as GammaEvent).markets;
    if (!Array.isArray(eventMarkets)) continue;
    for (const m of eventMarkets) {
      if (m && typeof m === "object") markets.push(m as GammaMarket);
    }
  }
  return markets;
}

/** True active/non-closed/non-archived market — a resolved or delisted market is not "currently
 *  active" context regardless of how well its question text matches. */
function isLiveMarket(m: GammaMarket): boolean {
  return m.active === true && m.closed !== true && m.archived !== true;
}

/** The higher-priced outcome and its label (index-aligned with `outcomes`), 1dp percent. Returns
 *  undefined when outcomePrices is missing/unparseable — never a fabricated 50/50 guess.
 *  IMPORTANT: `prices` is kept index-aligned with `outcomes` (no filtering before the scan) — a
 *  partially malformed outcomePrices array (e.g. one non-finite entry among several valid ones)
 *  must never shift indices, or the winning price gets attributed to the WRONG outcome label. */
function impliedProbabilityFromOutcomes(m: GammaMarket): { pct: number; label?: string } | undefined {
  const outcomes = parseJsonStringArray(m.outcomes);
  const prices = parseJsonStringArray(m.outcomePrices).map(Number);
  let bestIdx = -1;
  for (let i = 0; i < prices.length; i++) {
    if (!Number.isFinite(prices[i])) continue;
    if (bestIdx === -1 || prices[i] > prices[bestIdx]) bestIdx = i;
  }
  if (bestIdx === -1) return undefined;
  return { pct: Math.round(prices[bestIdx] * 1000) / 10, label: outcomes[bestIdx] };
}

function toMarketMatch(m: GammaMarket, scope: PolymarketScope = "company", themeId?: string): PolymarketMarketMatch | undefined {
  const question = typeof m.question === "string" ? m.question.trim() : "";
  if (!question) return undefined;
  const implied = impliedProbabilityFromOutcomes(m);
  if (!implied) return undefined;
  const outcomes = parseJsonStringArray(m.outcomes);
  const prices = parseJsonStringArray(m.outcomePrices).map(Number);
  const yesNo = parseYesNoPercents(outcomes, prices);
  const volume24h = toFiniteNumber(m.volume24hr);
  const volumeTotal = toFiniteNumber(m.volume);
  const kind = classifyMarketKind(question);
  const bookDepth = bookDepthFrom(volume24h, volumeTotal);
  const yesImplies = yesImpliesForKind(kind);
  const crowdLean = yesNo ? crowdLeanFromYes(yesNo.yesPct) : undefined;
  const tilt = yesNo && crowdLean ? tiltFrom(yesImplies, crowdLean, bookDepth) : "unclear";
  const tiltBasis = yesNo
    ? `yes ${yesNo.yesPct}% on kind=${kind}; lean=${crowdLean}; book=${bookDepth}`
    : `kind=${kind}; no Yes token`;
  return {
    question,
    impliedProbabilityPct: implied.pct,
    outcomeLabel: implied.label,
    volume24h,
    volumeTotal,
    scope,
    themeId,
    kind,
    yesPct: yesNo?.yesPct,
    noPct: yesNo?.noPct,
    crowdLean,
    yesImplies,
    tilt,
    tiltBasis,
    bookDepth
  };
}

// Gamma is a third-party CDN with no documented SLA and no failure-row-writing hang detector (a
// hung — not failing — request never trips the circuit breaker, since no failure row is ever
// written). This sits directly on the strategist run path (proposeTrades), so a hang must not
// stall it; abort and fail open instead of waiting out undici's default header timeout.
const FETCH_TIMEOUT_MS = 4_000;

async function fetchMarketsForQuery(query: string): Promise<GammaMarket[]> {
  const now = Date.now();
  const cached = searchCache.get(query);
  if (cached && cached.expiresAt > now) return cached.markets;

  const params = new URLSearchParams({ q: query, limit_per_type: String(SEARCH_LIMIT_PER_TYPE) });
  const url = `${GAMMA_BASE_URL}/public-search?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let markets: GammaMarket[];
  try {
    const response = await fetchWithRetry(
      url,
      { cache: "no-store", signal: controller.signal },
      { service: "polymarket" }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    markets = extractGammaMarkets(await response.json());
  } finally {
    clearTimeout(timeout);
  }
  searchCache.set(query, { expiresAt: now + polymarketTtlMs(), markets });
  return markets;
}

/**
 * Keyless Polymarket prediction-market context for a bounded set of symbols — see file header for
 * the full contract. Returns a map keyed by normalized symbol; a symbol with no relevant live
 * market (or one dropped by POLYMARKET_MIN_RELEVANCE) simply has no entry — never an empty-array
 * placeholder. Fails open to `{}` on the POLYMARKET_CONTEXT knob being off or on any unexpected
 * error; per-symbol fetch/parse errors are caught independently so one bad symbol never blanks
 * the rest.
 */
export async function fetchPolymarketContextForSymbols(
  symbols: readonly string[],
  companyNames: Record<string, string | undefined>
): Promise<Record<string, PolymarketMarketMatch[]>> {
  const result: Record<string, PolymarketMarketMatch[]> = {};
  try {
    if (!resolveSourceBool("POLYMARKET_CONTEXT")) return result;

    const seen = new Set<string>();
    const bounded: { symbol: string; companyName?: string }[] = [];
    for (const raw of symbols) {
      const symbol = normalizeSymbol(raw);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      bounded.push({ symbol, companyName: companyNames[symbol] });
      if (bounded.length >= polymarketMaxSymbolsPerRun()) break;
    }
    if (bounded.length === 0) return result;

    const minRelevance = resolveSourceNumber("POLYMARKET_MIN_RELEVANCE");
    let marketsMatched = 0;
    let droppedForRelevance = 0;

    for (let i = 0; i < bounded.length; i += CONCURRENCY) {
      const chunk = bounded.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ symbol, companyName }) => {
          try {
            const query = companyName?.trim() || symbol;
            const rawMarkets = await fetchMarketsForQuery(query);
            const scored = rawMarkets
              .filter(isLiveMarket)
              .map((m) => toMarketMatch(m, "company"))
              .filter((m): m is PolymarketMarketMatch => Boolean(m))
              .map((match) => ({ match, relevance: scoreHeadlineRelevance(match.question, symbol, companyName).score }));

            const relevant = scored.filter((x) => x.relevance >= minRelevance);
            droppedForRelevance += scored.length - relevant.length;
            if (relevant.length === 0) return;

            relevant.sort(
              (a, b) => b.relevance - a.relevance || (b.match.volume24h ?? 0) - (a.match.volume24h ?? 0)
            );
            const top = relevant.slice(0, MAX_MARKETS_PER_SYMBOL).map((x) => x.match);
            result[symbol] = top;
            marketsMatched += top.length;
          } catch {
            // Fail open — this symbol simply contributes nothing this run.
          }
        })
      );
    }

    // One bounded aggregate audit row per call, never per-market (audit_events is a hash-chained
    // log; see marketaux-provider.ts's identical convention for why this stays a single row).
    audit(
      "polymarket.context",
      { symbolsProbed: bounded.length, marketsMatched, droppedForRelevance },
      "local"
    );
  } catch {
    // Fail open — an unexpected error (bad knob read, etc.) yields no data, never a thrown error
    // out of a prompt-context helper.
  }
  return result;
}

function formatCompactVolume(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

/**
 * Formats up to MAX_MARKETS_PER_SYMBOL bounded, whole, Polymarket-attributed lines for the
 * strategist prompt — one line per market, each already whole (never truncated mid-claim, mirrors
 * prompt-headlines.ts's compactHeadlinesForPrompt contract). Pure: same input always produces the
 * same output.
 */
export function formatPolymarketLinesForPrompt(markets: readonly PolymarketMarketMatch[] | undefined): string[] {
  if (!markets || markets.length === 0) return [];
  return markets.slice(0, 5).map(formatOneMarketLine);
}

function formatOneMarketLine(m: PolymarketMarketMatch): string {
  const scopeTag =
    m.scope === "macro"
      ? "macro"
      : m.scope === "sector" || m.scope === "theme"
        ? `${m.scope}:${m.themeId ?? "theme"}`
        : "company";
  const yesNo =
    typeof m.yesPct === "number"
      ? `Yes ${Math.round(m.yesPct)}%${typeof m.noPct === "number" ? ` / No ${Math.round(m.noPct)}%` : ""}`
      : m.outcomeLabel
        ? `${m.outcomeLabel} ${Math.round(m.impliedProbabilityPct)}%`
        : `${Math.round(m.impliedProbabilityPct)}%`;
  const tiltLabel =
    m.tilt === "unclear"
      ? "tilt unclear — read the question"
      : m.tilt
        ? `tilt ${m.tilt}`
        : undefined;
  const parts = [yesNo];
  if (m.crowdLean) parts.push(`crowd ${m.crowdLean}`);
  if (tiltLabel) parts.push(tiltLabel);
  if (m.kind && m.kind !== "other") parts.push(`kind ${m.kind}`);
  if (m.bookDepth) parts.push(`${m.bookDepth} book`);
  if (typeof m.volume24h === "number") parts.push(`24h ${formatCompactVolume(m.volume24h)}`);
  return `Polymarket (${scopeTag}): "${m.question}" — ${parts.join(" · ")}`;
}

const MAX_THEME_MARKETS = 2;

function themeQueryCap(): number {
  const value = resolveSourceNumber("POLYMARKET_MAX_THEME_QUERIES");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 6;
}

function liveMatchesForQuery(query: string, scope: PolymarketScope, themeId?: string): Promise<PolymarketMarketMatch[]> {
  return fetchMarketsForQuery(query)
    .then((raw) =>
      raw
        .filter(isLiveMarket)
        .map((m) => toMarketMatch(m, scope, themeId))
        .filter((m): m is PolymarketMarketMatch => Boolean(m))
    )
    .catch(() => []);
}

export async function fetchPolymarketThemeContext(
  candidates: readonly { sector?: string; industry?: string }[]
): Promise<Record<string, PolymarketMarketMatch[]>> {
  const out: Record<string, PolymarketMarketMatch[]> = {};
  try {
    if (!resolveSourceBool("POLYMARKET_CONTEXT") || !resolveSourceBool("POLYMARKET_THEME_CONTEXT")) return out;
    const wanted = new Map<string, (typeof POLYMARKET_THEME_CATALOG)[number]>();
    for (const candidate of candidates) {
      for (const theme of themesForQuote(candidate)) wanted.set(theme.id, theme);
    }
    const queries: { themeId: string; query: string }[] = [];
    for (const theme of wanted.values()) {
      for (const query of theme.queries) queries.push({ themeId: theme.id, query });
    }
    const bounded = queries.slice(0, themeQueryCap());
    await Promise.all(
      bounded.map(async ({ themeId, query }) => {
        const matches = await liveMatchesForQuery(query, "theme", themeId);
        if (matches.length === 0) return;
        const ranked = [...matches].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, MAX_THEME_MARKETS);
        const existing = out[themeId] ?? [];
        out[themeId] = [...existing, ...ranked].slice(0, MAX_THEME_MARKETS);
      })
    );
  } catch {
    return {};
  }
  return out;
}

export async function fetchPolymarketMacroContext(): Promise<{ lines: string[]; markets: PolymarketMarketMatch[] }> {
  const empty = { lines: [] as string[], markets: [] as PolymarketMarketMatch[] };
  try {
    if (!resolveSourceBool("POLYMARKET_CONTEXT") || !resolveSourceBool("POLYMARKET_MACRO_CONTEXT")) return empty;
    const override = String(process.env.POLYMARKET_MACRO_QUERIES ?? "").trim();
    const catalog = override
      ? override.split(",").map((q) => ({ id: q.trim(), queries: [q.trim()], kind: "other" as const }))
      : POLYMARKET_MACRO_CATALOG;
    const markets: PolymarketMarketMatch[] = [];
    for (const spec of catalog) {
      for (const query of spec.queries) {
        const matches = (await liveMatchesForQuery(query, "macro", spec.id)).filter((m) => isUsScopedQuestion(m.question));
        if (matches.length === 0) continue;
        matches.sort((a, b) => (b.volume24h ?? b.volumeTotal ?? 0) - (a.volume24h ?? a.volumeTotal ?? 0));
        markets.push({ ...matches[0], kind: spec.kind, themeId: spec.id, scope: "macro" });
        break;
      }
    }
    return { lines: formatPolymarketLinesForPrompt(markets), markets };
  } catch {
    return empty;
  }
}

export function attachThemesToSymbols(
  candidates: readonly { symbol: string; sector?: string; industry?: string }[],
  themeById: Record<string, PolymarketMarketMatch[]>,
  companyBySymbol: Record<string, PolymarketMarketMatch[]>
): Record<string, PolymarketMarketMatch[]> {
  const merged: Record<string, PolymarketMarketMatch[]> = { ...companyBySymbol };
  for (const candidate of candidates) {
    const symbol = normalizeSymbol(candidate.symbol);
    if (!symbol) continue;
    const themes = themesForQuote(candidate);
    const extras: PolymarketMarketMatch[] = [];
    for (const theme of themes) {
      const rows = themeById[theme.id] ?? [];
      extras.push(...rows.map((row) => ({ ...row, scope: "theme" as const, themeId: theme.id })));
    }
    const company = (merged[symbol] ?? []).slice(0, MAX_MARKETS_PER_SYMBOL);
    const themeSlice = extras.slice(0, 2);
    const next = [...company, ...themeSlice];
    if (next.length > 0) merged[symbol] = next;
  }
  return merged;
}
