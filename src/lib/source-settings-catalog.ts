/**
 * Declarative catalog of source / data-plane knobs that used to live only in Infisical/env.
 * Exposed in Settings so each user can select values; runtime resolve uses user override then env.
 *
 * Scope (owner 2026-08-06): FMP product modules + SEC/RAG/web-source/transcript knobs that
 * affect what data the app pulls. LLM model choice stays on Strategy. Infra secrets stay env-only.
 */

export type SourceSettingType = "boolean" | "number" | "string";

export type SourceSettingGroup =
  | "sec"
  | "web_sources"
  | "rag"
  | "transcripts"
  | "enrichment";

export interface SourceSettingSpec {
  /** Stable id — usually the env var name for 1:1 mapping. */
  id: string;
  group: SourceSettingGroup;
  label: string;
  description: string;
  type: SourceSettingType;
  /** Default when neither user override nor env is set. */
  defaultValue: boolean | number | string;
  /** Optional min/max for numbers. */
  min?: number;
  max?: number;
  /** When true, only primary/local operator should change (shown as advanced). */
  advanced?: boolean;
  /** Honest product note (e.g. retired network path). */
  caveat?: string;
}

export const SOURCE_SETTING_GROUPS: Record<
  SourceSettingGroup,
  { title: string; blurb: string }
> = {
  sec: {
    title: "SEC EDGAR & filings RAG",
    blurb: "10-K/10-Q ingest cadence, 8-K depth, rate limits, and background backfill worker."
  },
  web_sources: {
    title: "Web sources",
    blurb: "Congress, insider Form 4, 13F, ARK holdings, FINRA short volume, technicals — on/off and windows."
  },
  rag: {
    title: "RAG / retrieval",
    blurb: "Disclosure embed, multi-query, HyDE, candidate-pool diagnostics, run budget."
  },
  transcripts: {
    title: "Earnings transcripts",
    blurb: "ROIC and EarningsCalls.dev transcript producers (quotas + entitlement)."
  },
  enrichment: {
    title: "Enrichment cascade",
    blurb: "Optional fundamentals/history sources beyond the free floors."
  }
};

/** All knobs the Settings UI may show and the API may write. */
export const SOURCE_SETTINGS_CATALOG: readonly SourceSettingSpec[] = [
  // ── SEC ───────────────────────────────────────────────────────────────────
  {
    id: "WEB_SOURCE_SEC8K",
    group: "sec",
    label: "SEC 8-K connector",
    description: "Index recent 8-K filings (summaries always; full body gated separately).",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_SEC8K_FULL_BODY",
    group: "sec",
    label: "8-K full-body ingest",
    description: "Embed full 8-K HTML bodies into RAG. Bounded per cycle (limit + wall-time budget + adaptive FTS batching).",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "WEB_SOURCE_SEC8K_FULL_BODY_LIMIT",
    group: "sec",
    label: "8-K full-body limit / cycle",
    description: "Max fresh 8-Ks that get full-body ingest per refresh.",
    type: "number",
    defaultValue: 5,
    min: 0,
    max: 100
  },
  {
    id: "WEB_SOURCE_SEC8K_RAG_LIMIT",
    group: "sec",
    label: "8-K RAG docs / refresh",
    description: "Cap on 8-K docs sent to embed per refresh cycle.",
    type: "number",
    defaultValue: 16,
    min: 1,
    max: 200
  },
  {
    id: "WEB_SOURCE_SEC8K_WINDOW_DAYS",
    group: "sec",
    label: "8-K lookback window (days)",
    description: "How far back to pull 8-Ks from EDGAR.",
    type: "number",
    defaultValue: 7,
    min: 1,
    max: 90
  },
  {
    // min 0, not 1: an explicit 0 is the documented site-protective pause (see
    // maxFilingsPerRunFromEnv in web-sources/sec-filings.ts) — clamping it to 1 would silently
    // un-pause.  Also a SERVER knob (Admin > Operations); precedence user > server > env > default.
    id: "SEC_FILING_RAG_MAX_PER_RUN",
    group: "sec",
    label: "10-K/10-Q filings per run",
    description: "Max full 10-K/10-Q bodies to ingest per scheduler tick (paid Voyage).",
    type: "number",
    defaultValue: 25,
    min: 0,
    max: 5000
  },
  {
    id: "SEC_FILING_INGEST_TTL_HOURS",
    group: "sec",
    label: "Filing ingest recheck TTL (hours)",
    description:
      "How often the scheduler re-scans for new 10-K/10-Q filings. 24h is the paid OpenRouter/bge-m3 cadence; 168 was the old Voyage-free weekly pin. Values like 87600 are an emergency pause, not a product default.",
    type: "number",
    defaultValue: 24,
    min: 1,
    max: 720
  },
  // SEC_INGEST_WORKER_ENABLED was removed from this catalog 2026-08-13: the worker never
  // consulted the per-user tier (boot gate read env only), so the entry here was a fake toggle.
  // It is now a real SERVER knob — Admin > Operations (src/lib/server-knobs.ts).
  {
    id: "SEC_RATE_LIMIT",
    group: "sec",
    label: "SEC requests / second",
    description: "Polite EDGAR rate limit (SEC asks for identification + pacing).",
    type: "number",
    defaultValue: 4,
    min: 1,
    max: 10,
    advanced: true
  },
  {
    id: "SEC_XBRL_ENRICHMENT_ENABLED",
    group: "enrichment",
    label: "SEC XBRL fundamentals enrichment",
    description:
      "Parse companyfacts XBRL from the nightly SQLite cache (sec_facts) into the fundamentals cascade. EDGAR fetches run off the scan path.",
    type: "boolean",
    defaultValue: true
  },

  // ── Web sources ───────────────────────────────────────────────────────────
  {
    id: "WEB_SOURCE_CONGRESS",
    group: "web_sources",
    label: "Congressional trade feed",
    description: "House/Senate trade disclosures into the evidence stack.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_INSIDER",
    group: "web_sources",
    label: "SEC Form 4 insider feed",
    description: "Insider transaction rapid filings.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_INSIDER_WATCHLIST",
    group: "web_sources",
    label: "Form 4 watchlist targeting",
    description: "Also pull Form 4s for tickers on your watchlists, not only the current EDGAR feed.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_INSIDER_WINDOW_DAYS",
    group: "web_sources",
    label: "Form 4 window (days)",
    description: "How long an open-market Form 4 stays in the dollar-weighted sentiment window.",
    type: "number",
    defaultValue: 90,
    min: 7,
    max: 180
  },
  {
    id: "WEB_SOURCE_INSIDER_MAX_FILINGS",
    group: "web_sources",
    label: "Form 4 filings per refresh",
    description: "Cap on atom-feed ownership XMLs. 0 means no cap. Quarterly bulk rows are never capped.",
    type: "number",
    defaultValue: 0,
    min: 0,
    max: 200,
    advanced: true
  },
  {
    id: "WEB_SOURCE_13F",
    group: "web_sources",
    label: "SEC 13F superinvestor holdings",
    description: "Official 13F-HR books for a curated filer set (Berkshire, Pershing, Burry, and others).  Observe only.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_13F_TTL_MS",
    group: "web_sources",
    label: "13F refresh interval (ms)",
    description: "How often to re-pull latest 13F-HR filings.  Default weekly.",
    type: "number",
    defaultValue: 604800000,
    min: 86400000,
    advanced: true
  },
  {
    id: "WEB_SOURCE_ARK",
    group: "web_sources",
    label: "ARK official daily holdings",
    description: "ARKK/ARKQ/ARKW/ARKG/ARKF/ARKX holdings from ARK's published CSVs.  Observe only.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_ARK_TTL_MS",
    group: "web_sources",
    label: "ARK refresh interval (ms)",
    description: "How often to re-pull ARK fund CSVs.  Default daily.",
    type: "number",
    defaultValue: 86400000,
    min: 3600000,
    advanced: true
  },
  {
    id: "WEB_SOURCE_FINRA",
    group: "web_sources",
    label: "FINRA short volume",
    description: "Short-sale volume series.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "WEB_SOURCE_TECHNICAL",
    group: "web_sources",
    label: "Computed technicals",
    description: "Local OHLC-derived technical indicators for scan candidates.",
    type: "boolean",
    defaultValue: true
  },

  // ── RAG ───────────────────────────────────────────────────────────────────
  {
    id: "RAG_EMBED_DISCLOSURES",
    group: "rag",
    label: "Embed disclosure / Form 4 narratives",
    description: "Send congressional/insider disclosure text into the vector corpus.",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "RAG_MULTIQUERY",
    group: "rag",
    label: "Multi-query retrieval",
    description: "Facet sub-queries per filings pass (more embeds).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "RAG_HYDE",
    group: "rag",
    label: "HyDE passages",
    description: "Draft hypothetical filing snippets via LLM (requires multi-query).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "RAG_PERSIST_CANDIDATE_POOL",
    group: "rag",
    label: "Persist candidate-pool diagnostics",
    description: "Audit rows for retrieval candidate pools (DB growth).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "VECTOR_EMBED_CLEAN_TEXT",
    group: "rag",
    label: "Clean-text embedding revision",
    description: "Stamp embed_rev=2 cleaned text (reindex before treating corpus as one space).",
    type: "boolean",
    defaultValue: false,
    advanced: true
  },
  {
    id: "RAG_RUN_BUDGET_ENABLED",
    group: "rag",
    label: "Per-run RAG operation budget",
    description:
      "When on, a rolling-window cap slows extra rerank work after too many calls.  Core search still runs.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "RAG_RUN_BUDGET_CEILING",
    group: "rag",
    label: "RAG operations per window",
    description: "Embed + rerank calls allowed in the rolling window before retrieval degrades.",
    type: "number",
    defaultValue: 5000,
    min: 1,
    max: 1_000_000
  },
  {
    id: "RAG_RUN_BUDGET_WINDOW_MS",
    group: "rag",
    label: "RAG budget window (ms)",
    description: "Rolling window for the per-run RAG operation cap.  Default one hour.",
    type: "number",
    defaultValue: 3_600_000,
    min: 1_000,
    max: 86_400_000,
    advanced: true
  },

  // ── Transcripts ───────────────────────────────────────────────────────────
  {
    id: "ROIC_TRANSCRIPTS_DISABLED",
    group: "transcripts",
    label: "Disable ROIC transcripts",
    description: "Kill-switch for ROIC earnings-call ingest (key can stay).",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "ROIC_TRANSCRIPTS_MAX_PER_RUN",
    group: "transcripts",
    label: "ROIC transcripts per run",
    description:
      "Max transcript fetches per scheduler pass.  Free ROIC is 5 req/min (keep this small).  Individual is 300/min and 20 quarters of history — 80 is the paid default so the universe can actually fill.",
    type: "number",
    defaultValue: 80,
    min: 1,
    max: 300
  },
  {
    id: "PUBLIC_EXECUTION_ENABLED",
    group: "enrichment",
    label: "Public.com order execution",
    description:
      "Allow placing orders on the connected Public.com account.  Leave off until that account is funded.  Quotes and history still use the connection.",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "ROIC_HISTORY_ENABLED",
    group: "enrichment",
    label: "ROIC price history",
    description: "Use ROIC in the OHLC history cascade when key is present.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "EARNINGSCALLS_DISABLED",
    group: "transcripts",
    label: "Disable EarningsCalls.dev",
    description: "Kill-switch for EarningsCalls producer + retrieval.",
    type: "boolean",
    defaultValue: false
  },
  {
    id: "EARNINGSCALLS_DAILY_TARGET_TRANSCRIPTS",
    group: "transcripts",
    label: "EarningsCalls daily target",
    description:
      "New full transcripts to fetch on an ordinary day.  The RapidAPI free-shaped plan is ~200 requests/month (~100 transcripts).  The monthly budget knob is the real cap; this is only the daily sip.",
    type: "number",
    defaultValue: 12,
    min: 0,
    max: 100
  },
  {
    id: "EARNINGSCALLS_BURST_MAX_TRANSCRIPTS",
    group: "transcripts",
    label: "EarningsCalls burst max",
    description: "Ceiling when a one-shot burst is armed.",
    type: "number",
    defaultValue: 25,
    min: 1,
    max: 100
  },
  {
    id: "EARNINGSCALLS_MONTHLY_BUDGET",
    group: "transcripts",
    label: "EarningsCalls monthly request budget",
    description:
      "Soft UTC-month request cap (default 180, headroom under a 200/month plan).  Raise this only if the RapidAPI/EarningsCalls plan is actually larger.",
    type: "number",
    defaultValue: 180,
    min: 0,
    max: 10_000,
    advanced: true
  },
  {
    id: "EARNINGSCALLS_ROLLING_WINDOW_BUDGET",
    group: "transcripts",
    label: "EarningsCalls rolling 31-day budget",
    description:
      "Harder rolling-window cap (default 195 of 200).  Maps to the provider anniversary window, not the calendar month.",
    type: "number",
    defaultValue: 195,
    min: 0,
    max: 10_000,
    advanced: true
  },

  // ── News relevance gating (DSA lesson: providers' own relevance scores were parsed then
  // thrown away, and providers with no native score attributed every headline that merely named
  // a symbol/company — even an ambiguous common word like "Apple" or "Target" with nothing
  // finance-related in the sentence). See src/lib/news-relevance.ts. ─────────────────────────
  {
    id: "NEWS_RELEVANCE_FILTER",
    group: "enrichment",
    label: "News relevance filter",
    description:
      "Keep only headlines/sentiment a provider (or, lacking a provider score, this app's own headline-text rubric) scores as actually about the symbol.  Off restores every headline a provider tags to the symbol, including ambiguous common-word company name matches.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "NEWS_RELEVANCE_MIN_SCORE",
    group: "enrichment",
    label: "News relevance minimum score",
    description:
      "Minimum 0-1 relevance score a headline must clear to count toward a symbol's news/sentiment.  Applies to provider-native scores (Alpha Vantage relevance_score, Marketaux match_score) and to this app's own headline-text rubric alike.",
    type: "number",
    defaultValue: 0.35,
    min: 0,
    max: 1
  },

  // ── Polymarket prediction-market context (keyless — Gamma API needs no API key; see
  // src/lib/polymarket-provider.ts). Prompt-time only: fetched for the candidates entering the
  // strategist prompt, gated through the same news-relevance.ts rubric as every other keyless
  // provider. ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "POLYMARKET_CONTEXT",
    group: "enrichment",
    label: "Polymarket prediction-market context",
    description:
      "Inject up to 3 currently-active, company-relevant Polymarket markets (question, implied probability, volume) into the strategist prompt per candidate.  Keyless — no credential required.  Off restores the pre-Polymarket prompt byte-for-byte.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "POLYMARKET_MIN_RELEVANCE",
    group: "enrichment",
    label: "Polymarket relevance minimum score",
    description:
      "Minimum 0-1 relevance score (this app's headline-text rubric, applied to the market question) a Polymarket market must clear to be shown for a symbol.",
    type: "number",
    defaultValue: 0.5,
    min: 0,
    max: 1
  },
  {
    id: "POLYMARKET_THEME_CONTEXT",
    group: "enrichment",
    label: "Polymarket sector and theme books",
    description:
      "Attach curated sector/theme Polymarket books (semiconductors, AI, energy, finance, defense) to matching scan candidates.  Still keyless.  Off leaves only company-name markets.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "POLYMARKET_MACRO_CONTEXT",
    group: "enrichment",
    label: "Polymarket macro books",
    description:
      "Inject run-level US recession, Fed, CPI, and WTI books next to Kalshi event markets.  Real-money odds, not a quote.  Off omits the block.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "POLYMARKET_MAX_THEME_QUERIES",
    group: "enrichment",
    label: "Polymarket theme query cap",
    description: "Maximum distinct theme searches per strategy run.  Cached 10 minutes.",
    type: "number",
    defaultValue: 6,
    min: 0,
    max: 20
  },

  // ── Kalshi event-market macro context (public GET /markets; KALSHI_ENV
  // enables the data client. Trading is a separate default-off module.) ──
  {
    id: "KALSHI_CONTEXT",
    group: "enrichment",
    label: "Kalshi macro event markets",
    description:
      "Inject curated Kalshi event-contract probabilities (Fed, CPI, recession, NFP, GDP) into the strategist prompt as macro context.  Public market data — KALSHI_ENV=demo or prod enables the fetcher.  Off omits the block.",
    type: "boolean",
    defaultValue: true
  },
  {
    id: "KALSHI_MACRO_SERIES",
    group: "enrichment",
    label: "Kalshi series tickers",
    description:
      "Comma-separated Kalshi series tickers to fetch.  Blank uses Fed decision, CPI YoY, NBER recession, NFP, and GDP.",
    type: "string",
    defaultValue: ""
  },
  {
    id: "KALSHI_MAX_MARKETS_PER_SERIES",
    group: "enrichment",
    label: "Kalshi markets per series",
    description: "Cap on open markets kept per series, most-liquid first.",
    type: "number",
    defaultValue: 4,
    min: 1,
    max: 12
  },
  {
    id: "KALSHI_INCLUDE_ELECTIONS",
    group: "enrichment",
    label: "Include Kalshi election series",
    description: "Also fetch presidential / Senate / House series.  Default off — elections are noisier as equity-regime evidence.",
    type: "boolean",
    defaultValue: false
  }
] as const;

export function sourceSettingById(id: string): SourceSettingSpec | undefined {
  return SOURCE_SETTINGS_CATALOG.find((s) => s.id === id);
}

export function sourceSettingsByGroup(group: SourceSettingGroup): SourceSettingSpec[] {
  return SOURCE_SETTINGS_CATALOG.filter((s) => s.group === group);
}
