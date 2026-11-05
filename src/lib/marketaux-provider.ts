// Marketaux news-sentiment enrichment provider — key-gated, dormant producer for the two carrier
// fields Marketaux can genuinely fill: `headlines` (recent article titles for the symbol) and
// `sentiment` (0–100 news tone, 50 = neutral), derived from Marketaux's OWN per-entity sentiment
// model — not a keyword-proxy guess like the scoreHeadlines() fallback other providers use when
// their news feed carries no sentiment score of its own.
//
// ── ToS verification (why this file exists at all) ─────────────────────────────────────────────
// A prior research pass flagged Marketaux's API ToS as "unverifiable" because marketaux.com/
// terms-of-service 403'd its fetch attempt. That URL is simply wrong — the real page (linked from
// the site's own footer) is https://www.marketaux.com/tos, and it fetched clean (HTTP 200, full
// text read) with a normal browser User-Agent on 2026-08-02. It is a generic TermsFeed-style site
// ToS with no API-specific acceptable-use, attribution, or redistribution clauses anywhere in it
// (grepped the full text for "API", "commercial", "redistribut", "attribution", "resale" — the
// only commercial-adjacent hits are boilerplate: a "solely for your personal, non-commercial use"
// content license, and a "may not be used in connection with any commercial endeavors except
// those...specifically endorsed...by us" site-use clause). Marketaux's own documentation page
// (marketaux.com/documentation, fetched live the same day) states outright that "Our API is
// designed to provide global financial and stock market news and analysis to elevate financial
// apps" — i.e. embedding its data into a financial app (this app's exact use case) is the
// explicitly stated, endorsed purpose of the product. Every paid tier (marketaux.com/pricing,
// fetched live same day: Free $0/100 req/day, Basic/Standard/Pro/Pro 50K) is priced purely by
// request volume — there is no separate "commercial tier", no attribution requirement, and no
// free-tier-specific restriction anywhere in the ToS, pricing, or FAQ pages. Combined with this
// app's actual deployment model (sole user, BYOK — each deployment uses its own operator's own key
// for that operator's own non-resold personal trading decisions, never redistributed or resold to
// third parties), this clears the personal/non-commercial bar even under the strictest reading of
// the generic ToS clause. Full page dumps and the live unauthenticated-request verification
// (api.marketaux.com/v1/news/all with a bad token → real HTTP 401 `invalid_api_token`, matching
// the documented error shape exactly) are cited in the integration-pass rollout note.
//
// ── Response shape (live-verified, NOT from training-data memory) ──────────────────────────────
// Documentation example response for GET https://api.marketaux.com/v1/news/all (fetched live
// 2026-08-02, reproduced structurally — field names/types only, not the copyrighted example text):
//   { meta: { found, returned, limit, page },
//     data: [ { uuid, title, description, keywords, snippet, url, image_url, language,
//               published_at, source, relevance_score,
//               entities: [ { symbol, name, exchange, exchange_long, country, type, industry,
//                             match_score, sentiment_score, highlights: [...] } ],
//               similar: [] } ] }
// `entities[].sentiment_score` is documented as "Average sentiment of all highlighted text found
// for the identified entity", ranging -1 (bearish) to +1 (bullish), 0 = neutral. Error responses
// (also live-verified via the unauthenticated request above) are
// `{ "error": { "code": "...", "message": "..." } }` — codes include invalid_api_token (401),
// usage_limit_reached (402), rate_limit_reached (429), malformed_parameters (400).
//
// ── Sentiment scale convention ──────────────────────────────────────────────────────────────────
// SymbolEnrichment.sentiment is documented in data-providers.ts as "0–100 news tone (50 =
// neutral)". Alpha Vantage's real per-ticker model score maps via `50 + avgScore * 100` there —
// but that deliberately treats AV's PRACTICAL clustering range (~±0.35, per that file's own
// comment, matching AV's documented Bullish/Bearish bucket edges) as if it were the full span, so
// most real AV values land in a wide 15–85 band. Marketaux documents its full nominal range as -1
// to +1 with no narrower practical-clustering guidance, so this file maps the FULL documented span
// linearly (`50 + score * 50`) instead of reusing AV's ×100 factor — using ×100 here would
// needlessly saturate most real (non-extreme) headlines to 0/100 and throw away the very
// granularity the 0–100 scale exists to preserve. See mapMarketauxSentiment().
//
// ── Free-tier economics (100 req/day) ───────────────────────────────────────────────────────────
// Unlike Quiver (5 dataset calls PER SYMBOL) Marketaux's `symbols` param accepts a comma-separated
// batch in ONE request — so this provider groups misses into small batches (MARKETAUX_SYMBOLS_PER_
// REQUEST, default 3) rather than firing one call per symbol. The free plan caps `limit` (articles
// per request) at 3 regardless of what's requested, so a request only ever returns a handful of
// articles total across the whole batch — some batched symbols may legitimately get zero coverage
// this cycle purely from that ceiling, not from a bug. That is fine: an unmatched symbol simply
// gets `{}` (no fabricated headline/sentiment), same fail-open contract as every other field here.
// A conservative self-contained daily request counter (MARKETAUX_DAILY_REQUEST_BUDGET, default 80,
// resetting on UTC date rollover) keeps this provider well under the real 100/day ceiling even
// across many scan cycles in one day; once exhausted, remaining symbols are simply left unfilled
// for the rest of the day rather than risking a 402/429 that would also count against provider
// health. This provider NEVER throws out of enrich() — every sub-fetch is caught independently and
// a failed group just leaves its symbols unfilled (short negative-TTL cache so it retries soon).

import "server-only";

import type { MarketEnrichmentProvider, SymbolEnrichment } from "./data-providers";
import { fetchWithRetry } from "./data-providers";
import { audit, resolveApiKeyWithSource } from "./db";
import { normalizeSymbol } from "./money";
import { resolveSourceBool, resolveSourceNumber } from "./source-settings";

const MARKETAUX_BASE_URL = "https://api.marketaux.com/v1";

/**
 * Registration gate: per-user stored key (when userId given) → MARKETAUX_API_KEY env →
 * local-user stored key, via the shared resolver (marketaux is a catalogued per-user
 * service in db-api-keys). Without userId this preserves the old env-only behavior
 * plus the resolver's local fallback. Blank/whitespace counts as unset.
 */
export function resolveMarketauxApiKey(userId?: string): string | undefined {
  if (!userId) {
    const key = (process.env.MARKETAUX_API_KEY ?? "").trim();
    return key || undefined;
  }
  return resolveApiKeyWithSource("marketaux", userId).key;
}

// Positive cache floor: news moves faster than Quiver's slow-moving filings, but the free plan's
// 100/day budget can't support minute-level refresh across a real watchlist. 60 minutes balances
// freshness against quota — overridable, with a 15-minute floor so a low override can't quietly
// burn the whole daily budget in an hour.
const DEFAULT_TTL_MS = 60 * 60_000;
const MIN_TTL_MS = 15 * 60_000;
function marketauxTtlMs(): number {
  const value = Number(process.env.MARKETAUX_CACHE_TTL_MS);
  return Number.isFinite(value) && value >= MIN_TTL_MS ? value : DEFAULT_TTL_MS;
}

// Short negative TTL so a transient outage/quota block retries well before the positive floor.
const DEFAULT_NEGATIVE_TTL_MS = 10 * 60_000;
function marketauxNegativeTtlMs(): number {
  const value = Number(process.env.MARKETAUX_NEGATIVE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NEGATIVE_TTL_MS;
}

const DEFAULT_MAX_SYMBOLS = 30;
function marketauxMaxSymbols(): number {
  const value = Number(process.env.MARKETAUX_MAX_SYMBOLS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SYMBOLS;
  return Math.floor(value);
}

// How many symbols get batched into a single `symbols=` request. Small on purpose — the free
// plan's `limit` (articles per request) is capped at 3 regardless of what we request, so batching
// too many symbols into one call just spreads those 3 articles across more tickers and lowers the
// odds any given symbol actually gets covered this cycle.
const DEFAULT_SYMBOLS_PER_REQUEST = 3;
function marketauxSymbolsPerRequest(): number {
  const value = Number(process.env.MARKETAUX_SYMBOLS_PER_REQUEST);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SYMBOLS_PER_REQUEST;
  return Math.floor(value);
}

// Articles requested per call. The free plan silently clamps this to 3 server-side regardless of
// what we ask for; a higher override only matters on a paid plan.
const DEFAULT_ARTICLE_LIMIT = 3;
function marketauxArticleLimit(): number {
  const value = Number(process.env.MARKETAUX_ARTICLE_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ARTICLE_LIMIT;
  return Math.floor(value);
}

// Conservative headroom under the documented 100/day free-plan ceiling.
const DEFAULT_DAILY_REQUEST_BUDGET = 80;
function marketauxDailyBudget(): number {
  const value = Number(process.env.MARKETAUX_DAILY_REQUEST_BUDGET);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DAILY_REQUEST_BUDGET;
  return Math.floor(value);
}

// Modest concurrency — Marketaux's documented rate_limit_reached (429) is "too many requests in
// the past 60 seconds"; unlike Quiver's 5-calls-per-symbol fan-out, each of these calls is already
// a multi-symbol batch, so there is no need to run many in parallel.
const CONCURRENCY = 2;

const HEADLINES_PER_SYMBOL = 5;

interface MarketauxEntity {
  symbol?: unknown;
  sentiment_score?: unknown;
  // Documented (live-verified 2026-08-12, marketaux.com/documentation) as "the overall strength
  // of the matching for the identified entity" — NOT the 0..1 scale its name might suggest; real
  // example values from the docs' own live response samples run ~12-82, no documented upper
  // bound. marketauxEntityIsRelevant() normalizes it /100 (clamped to 0..1) before comparing
  // against NEWS_RELEVANCE_MIN_SCORE, so the shared 0-1 knob gates all providers on one scale.
  match_score?: unknown;
}

interface MarketauxArticle {
  title?: unknown;
  entities?: unknown;
}

/** Marketaux's documented response envelope is `{ meta, data: [...] }`. Tolerate anything else
 *  (missing `data`, `data` not an array, non-object rows, `null`/malformed payloads) by returning
 *  an empty list rather than throwing — a malformed/empty API response must produce no fields,
 *  never a fabricated one. */
export function extractMarketauxArticles(payload: unknown): MarketauxArticle[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is MarketauxArticle => !!row && typeof row === "object");
}

/** Maps Marketaux's native entity sentiment_score (-1..+1, 0 = neutral, per their docs) onto this
 *  app's 0-100 scale (50 = neutral) using the FULL documented span — see the file-level comment
 *  for why this deliberately does not reuse Alpha Vantage's ×100 factor. */
export function mapMarketauxSentiment(score: number): number {
  const scaled = 50 + score * 50;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/** True unless the filter is on AND this entity's own match_score parses AND that value is below
 *  minScore. An entity Marketaux never scored (field absent/unparseable) always passes through —
 *  never drop data the provider didn't itself flag as a weak match.
 *
 *  match_score is normalized onto the knob's 0..1 scale by dividing by 100 (observed range
 *  ~12-82, no documented upper bound — values above 100 clamp to 1). Without this the shared
 *  NEWS_RELEVANCE_MIN_SCORE (0-1) could never exclude anything: every real-world score already
 *  exceeded 1, so the gate was inert at any UI-settable threshold. */
function marketauxEntityIsRelevant(entity: MarketauxEntity, filterEnabled: boolean, minScore: number): boolean {
  if (!filterEnabled) return true;
  const raw = entity.match_score;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
  if (value === undefined || !Number.isFinite(value)) return true;
  const normalized = Math.max(0, Math.min(1, value / 100));
  return normalized >= minScore;
}

/** Groups a batch of articles' matching entities by symbol, producing at most one SymbolEnrichment
 *  per requested symbol. A symbol with no matching (and, when the relevance filter is on,
 *  sufficiently relevant) entity in any article gets `{}` (never a fabricated headline or
 *  sentiment). `sentiment` is the mean of every matching entity's sentiment_score across the
 *  whole batch, mapped through mapMarketauxSentiment(). `onDropped`, when given, fires once per
 *  entity dropped for low match_score — the caller's aggregate counter for observability; never
 *  called on the common (unscored or relevant) path. */
export function aggregateMarketauxBySymbol(
  articles: MarketauxArticle[],
  symbols: string[],
  onDropped?: (symbol: string) => void
): Record<string, SymbolEnrichment> {
  const wanted = new Set(symbols);
  const headlinesBySymbol = new Map<string, string[]>();
  const sentimentAccBySymbol = new Map<string, { sum: number; count: number }>();
  const filterEnabled = resolveSourceBool("NEWS_RELEVANCE_FILTER");
  const minScore = resolveSourceNumber("NEWS_RELEVANCE_MIN_SCORE");

  for (const article of articles) {
    const title = typeof article.title === "string" ? article.title.trim() : "";
    const entities = Array.isArray(article.entities) ? article.entities : [];
    for (const rawEntity of entities) {
      if (!rawEntity || typeof rawEntity !== "object") continue;
      const entity = rawEntity as MarketauxEntity;
      const symbol = typeof entity.symbol === "string" ? entity.symbol.trim().toUpperCase() : "";
      if (!symbol || !wanted.has(symbol)) continue;

      // Below-threshold match_score drops BOTH the headline and the sentiment contribution for
      // this entity — a weak match shouldn't half-count toward either.
      if (!marketauxEntityIsRelevant(entity, filterEnabled, minScore)) {
        onDropped?.(symbol);
        continue;
      }

      if (title) {
        const list = headlinesBySymbol.get(symbol) ?? [];
        if (list.length < HEADLINES_PER_SYMBOL && !list.includes(title)) list.push(title);
        headlinesBySymbol.set(symbol, list);
      }

      const raw = entity.sentiment_score;
      const score = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
      if (score !== undefined && Number.isFinite(score)) {
        const acc = sentimentAccBySymbol.get(symbol) ?? { sum: 0, count: 0 };
        acc.sum += score;
        acc.count += 1;
        sentimentAccBySymbol.set(symbol, acc);
      }
    }
  }

  const result: Record<string, SymbolEnrichment> = {};
  for (const symbol of symbols) {
    const data: SymbolEnrichment = {};
    const headlines = headlinesBySymbol.get(symbol);
    if (headlines && headlines.length > 0) data.headlines = headlines;
    const acc = sentimentAccBySymbol.get(symbol);
    if (acc && acc.count > 0) data.sentiment = mapMarketauxSentiment(acc.sum / acc.count);
    result[symbol] = data;
  }
  return result;
}

const marketauxCache = new Map<string, { expiresAt: number; data: SymbolEnrichment }>();

/** Test helper: clear the cache between runs. */
export function clearMarketauxCache(): void {
  marketauxCache.clear();
}

let dailyBudgetState = { day: "", used: 0 };

/** Test helper: reset the daily request-budget counter between runs. */
export function resetMarketauxDailyBudget(): void {
  dailyBudgetState = { day: "", used: 0 };
}

function utcDateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Reserves one request against today's conservative budget; returns false (no reservation) once
 *  exhausted for the UTC day. Self-contained — deliberately NOT wired into the shared
 *  provider-rate-limit.ts registry (that file is owned by a separate integration pass); mirrors
 *  quiver-provider.ts's posture of a fully standalone, dormant-until-configured file. */
export function tryReserveMarketauxDailyRequest(now: number): boolean {
  const key = utcDateKey(now);
  if (dailyBudgetState.day !== key) dailyBudgetState = { day: key, used: 0 };
  if (dailyBudgetState.used >= marketauxDailyBudget()) return false;
  dailyBudgetState.used += 1;
  return true;
}

export class MarketauxEnrichmentProvider implements MarketEnrichmentProvider {
  readonly name = "marketaux";
  readonly configured = true;
  readonly costTier = "free" as const;
  // The 100 req/day free-plan ceiling is scarce enough that a wave-gated cascade should spend it
  // deliberately rather than burning it on every symbol regardless of whether headlines/sentiment
  // are already covered by an earlier (free, non-scarce) tier.
  readonly quotaScarce = true;
  readonly suppliesFields = ["headlines", "sentiment"] as const;

  constructor(private readonly apiKey: string) {}

  async enrich(symbols: string[]): Promise<Record<string, SymbolEnrichment>> {
    const normalized = Array.from(new Set(symbols.map(normalizeSymbol))).filter(Boolean).slice(0, marketauxMaxSymbols());
    const result: Record<string, SymbolEnrichment> = {};
    if (normalized.length === 0) return result;

    const now = Date.now();
    const misses: string[] = [];
    for (const symbol of normalized) {
      const cached = marketauxCache.get(symbol);
      if (cached && cached.expiresAt > now) result[symbol] = cached.data;
      else misses.push(symbol);
    }
    if (misses.length === 0) return result;

    const groupSize = marketauxSymbolsPerRequest();
    const groups: string[][] = [];
    for (let i = 0; i < misses.length; i += groupSize) groups.push(misses.slice(i, i + groupSize));

    // Aggregate-only counter for the whole enrich() call (never per-headline) — see the audit()
    // call after the loop below.
    let droppedForRelevance = 0;

    for (let i = 0; i < groups.length; i += CONCURRENCY) {
      const chunk = groups.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (group) => {
          if (!tryReserveMarketauxDailyRequest(now)) {
            // Daily budget exhausted — leave this group unfilled for the rest of the day rather
            // than risking a 402/429. Not cached (no expiresAt written) so the very next symbol
            // pass (tomorrow, or once other groups' TTLs expire) retries normally.
            for (const symbol of group) result[symbol] = {};
            return;
          }
          try {
            const articles = await this.fetchArticles(group);
            const bySymbol = aggregateMarketauxBySymbol(articles, group, () => { droppedForRelevance++; });
            for (const symbol of group) {
              const data = bySymbol[symbol] ?? {};
              marketauxCache.set(symbol, { expiresAt: now + marketauxTtlMs(), data });
              result[symbol] = data;
            }
          } catch (err) {
            console.error(`[marketaux-provider] fetch error for [${group.join(",")}]:`, err);
            for (const symbol of group) {
              marketauxCache.set(symbol, { expiresAt: now + marketauxNegativeTtlMs(), data: {} });
              result[symbol] = {};
            }
          }
        })
      );
    }

    // Single bounded audit row for the whole call, never per-headline — only written when the
    // filter actually dropped something this run (audit_events is a hash-chained log; a prior
    // production incident from an unbounded per-event audit payload is documented in
    // audit-bounded-run.ts, so this stays a small aggregate, not a row per drop).
    if (droppedForRelevance > 0) {
      audit("news_relevance.dropped", { provider: this.name, droppedCount: droppedForRelevance, minScore: resolveSourceNumber("NEWS_RELEVANCE_MIN_SCORE") }, "local");
    }

    return result;
  }

  private async fetchArticles(symbols: string[]): Promise<MarketauxArticle[]> {
    const params = new URLSearchParams({
      api_token: this.apiKey,
      symbols: symbols.join(","),
      filter_entities: "true",
      language: "en",
      limit: String(marketauxArticleLimit())
    });
    const url = `${MARKETAUX_BASE_URL}/news/all?${params.toString()}`;
    const response = await fetchWithRetry(
      url,
      { cache: "no-store" },
      { service: "marketaux", keySource: "env", apiKey: this.apiKey }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return extractMarketauxArticles(await response.json());
  }
}
