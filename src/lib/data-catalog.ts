/**
 * Static inventory of every market/RAG data kind the app uses, and which sources
 * can theoretically or actually supply each field — for admin UX and agent triage.
 *
 * This is intentionally declarative (not derived only from runtime registration):
 * retired providers stay listed so agents don't re-discover "why is FMP missing?"
 * Live completeness is layered on top in data-completeness.ts.
 */

export type DataCategory =
  | "quote"
  | "fundamental"
  | "analyst"
  | "sentiment_news"
  | "ownership_insider"
  | "congress_alt"
  | "options"
  | "rag_corpus"
  | "macro"
  | "derived";

export type SourceStatus = "active" | "retired" | "opt_in" | "scarce" | "keyless" | "computed" | "peer";

export interface CatalogSource {
  id: string;
  label: string;
  status: SourceStatus;
  /** Short note: rate limits, retirement, ToS, etc. */
  notes?: string;
}

export interface CatalogFieldSource {
  sourceId: string;
  /** Field-specific note (e.g. ratios path 404s). */
  notes?: string;
  /** Prefer this source when cascade first-wins. */
  preferred?: boolean;
}

export interface CatalogField {
  id: string;
  label: string;
  category: DataCategory;
  /** How the value is stored / shown. */
  valueKind: "number" | "string" | "string[]" | "text_chunks" | "object";
  description: string;
  /** Always require per-observation stamps (as_of + fetched_at + source). */
  provenanceRequired: true;
  /** LLM surface (prompt key) when applicable. */
  llmKey?: string;
  sources: CatalogFieldSource[];
}

/** All known upstreams (active, scarce, retired, computed). */
export const CATALOG_SOURCES: CatalogSource[] = [
  { id: "alpaca-snapshot", label: "Alpaca snapshots", status: "active", notes: "IEX real-time when key present; user any Alpaca account → market data." },
  { id: "alpaca-news", label: "Alpaca Benzinga news", status: "active", notes: "Headlines/sentiment batch; free with Alpaca key." },
  { id: "broker-gateway", label: "Active + other connected brokers", status: "active", notes: "Quotes from every connected broker for the user (multi-broker fan-in); only active account is fill-venue authoritative." },
  { id: "yahoo-finance", label: "Yahoo Finance quoteSummary", status: "keyless", notes: "Keyless floor; crumb + pacing; datacenter 429s possible." },
  { id: "nasdaq-quote", label: "Nasdaq.com public quote API", status: "keyless", notes: "Free-wave redundancy beside Yahoo." },
  { id: "nasdaq-calendar", label: "Nasdaq earnings calendar", status: "keyless", notes: "daysToEarnings market-wide." },
  { id: "nasdaq-delayed-screener", label: "NASDAQ delayed screener", status: "keyless", notes: "Universe scan price/change; not full fundamentals." },
  { id: "finnhub", label: "Finnhub", status: "active", notes: "Keyed Wave B (free-tier key, ~60/min). Not a paid Finnhub plan." },
  { id: "roic", label: "ROIC.ai", status: "active", notes: "Profile reliable; some ratios paths 404; 10k/day paid quota; also history + transcripts + multiyear financials RAG." },
  { id: "tiingo", label: "Tiingo", status: "active", notes: "Hourly/day quotas tight — admit top-N only." },
  { id: "twelvedata", label: "Twelve Data", status: "scarce", notes: "Credits/min; batch quote." },
  { id: "alpha-vantage", label: "Alpha Vantage", status: "scarce", notes: "~25/day native keys; earnings calendar market-wide; often skipped when Alpaca news covers sentiment." },
  { id: "sec-xbrl", label: "SEC EDGAR XBRL", status: "keyless", notes: "Authoritative D/E, shares outstanding; slow." },
  { id: "sec-edgar-form4", label: "SEC Form 4 / insider web signals", status: "keyless", notes: "insiderSentiment overlay from cached web sources." },
  { id: "sec-edgar-13f", label: "SEC 13F-HR superinvestor holdings", status: "keyless", notes: "Official EDGAR 13F books for a curated filer set. Observe only." },
  { id: "ark-funds-holdings", label: "ARK official daily holdings CSVs", status: "keyless", notes: "ARKK/Q/W/G/F/X from assets.ark-funds.com. Observe only." },
  { id: "sec-filings-rag", label: "SEC 10-K/10-Q/8-K ingest → vector DB", status: "active", notes: "RAG corpus; presented as retrievedFinancialContext (not full corpus dump)." },
  { id: "filingapi", label: "FilingAPI.dev", status: "scarce", notes: "Optional key; ~50/day; skip on missing/401. Sector/earnings/insider." },
  { id: "congress.trade", label: "Congress.Trade peer", status: "peer", notes: "Disclosures/analytics default ON; fundamentals peer default OFF." },
  { id: "congress-web", label: "Congressional trade web cache", status: "active", notes: "senateTrades / congress composite from local web-source cache." },
  { id: "finra", label: "FINRA short volume", status: "keyless", notes: "Short volume ratio signals." },
  { id: "massive", label: "Massive (short interest secondary)", status: "opt_in", notes: "shortPercentOfFloatSecondary only." },
  { id: "marketaux", label: "Marketaux", status: "scarce", notes: "100/day free; real article sentiment." },
  { id: "fintechstudios", label: "Fintech Studios", status: "opt_in", notes: "News when keyed." },
  { id: "simfin", label: "SimFin", status: "opt_in", notes: "Fundamentals second opinion." },
  { id: "wisesheets", label: "Wisesheets", status: "scarce", notes: "New; monthly cap." },
  { id: "rapidapi-*", label: "RapidAPI failover suite", status: "scarce", notes: "Mboum, YH15, AV-RAPID, Insiders, TwelveData-RAPID, etc. Wave C only." },
  { id: "fmp", label: "Financial Modeling Prep", status: "retired", notes: "Direct ST access retired 2026-08-04; do not re-enable." },
  { id: "quiverquant", label: "QuiverQuant", status: "retired", notes: "Direct ST access retired; congress via Congress.Trade." },
  { id: "unusual-whales", label: "Unusual Whales", status: "retired", notes: "Direct ST access retired." },
  { id: "robinhood-fundamentals", label: "Robinhood MCP fundamentals", status: "opt_in", notes: "ROBINHOOD_ENRICHMENT_ENABLED." },
  { id: "robinhood-options", label: "Robinhood options chain", status: "opt_in", notes: "IV / put-call; default OFF." },
  { id: "webull-unofficial", label: "Webull unofficial", status: "opt_in", notes: "Flag-gated." },
  { id: "symbol_field_latest", label: "Durable field store (SQLite)", status: "active", notes: "Latest value per symbol×field with as_of + fetched_at; shared; seed for interactive scan." },
  { id: "derived-metrics", label: "In-house derived metrics", status: "computed", notes: "PEG, earnYld, payout, dollarVolM, Graham, etc. from inputs." },
  { id: "fmp-transcripts", label: "FMP earnings transcripts (rights-gated)", status: "opt_in", notes: "RAG only when rights claim active." },
  { id: "roic-transcripts", label: "ROIC earnings transcripts", status: "opt_in", notes: "RAG ingest path." },
  { id: "roic-financials", label: "ROIC multi-year financials", status: "opt_in", notes: "RAG multi-year doc, not table columns." },
  { id: "earningscalls", label: "EarningsCalls.dev", status: "opt_in", notes: "Transcript path when enabled." }
];

const src = (sourceId: string, notes?: string, preferred?: boolean): CatalogFieldSource => ({
  sourceId,
  notes,
  preferred
});

/** Core catalog — numerical/table fields + RAG corpus kinds + web signals. */
export const CATALOG_FIELDS: CatalogField[] = [
  // Quotes
  {
    id: "price",
    label: "Last price",
    category: "quote",
    valueKind: "number",
    description: "Last trade / mark used for scoring and display.",
    provenanceRequired: true,
    llmKey: "px",
    sources: [
      src("broker-gateway", "Any connected broker; active may be venue-delayed", true),
      src("alpaca-snapshot", undefined, true),
      src("yahoo-finance"),
      src("nasdaq-quote"),
      src("nasdaq-delayed-screener", "Scan universe first pass"),
      src("roic", "Profile price; delayed"),
      src("symbol_field_latest", "Last stored if live miss")
    ]
  },
  {
    id: "volume",
    label: "Volume",
    category: "quote",
    valueKind: "number",
    description: "Session share volume.",
    provenanceRequired: true,
    llmKey: "vol",
    sources: [
      src("broker-gateway"),
      src("alpaca-snapshot", undefined, true),
      src("yahoo-finance"),
      src("finnhub"),
      src("symbol_field_latest")
    ]
  },
  {
    id: "marketCap",
    label: "Market cap",
    category: "quote",
    valueKind: "number",
    description: "Total market capitalization in USD.",
    provenanceRequired: true,
    llmKey: "mktCap",
    sources: [
      src("nasdaq-delayed-screener", "Scan universe first pass", true),
      src("yahoo-finance"),
      src("symbol_field_latest")
    ]
  },
  {
    id: "bid",
    label: "Bid",
    category: "quote",
    valueKind: "number",
    description: "Best bid; synthetic bid never sent to LLM as real.",
    provenanceRequired: true,
    llmKey: "bid",
    sources: [src("broker-gateway", undefined, true), src("alpaca-snapshot"), src("yahoo-finance", "Often synthetic")]
  },
  {
    id: "ask",
    label: "Ask",
    category: "quote",
    valueKind: "number",
    description: "Best ask.",
    provenanceRequired: true,
    llmKey: "ask",
    sources: [src("broker-gateway", undefined, true), src("alpaca-snapshot"), src("yahoo-finance", "Often synthetic")]
  },
  {
    id: "intradayChangePct",
    label: "Intraday change %",
    category: "quote",
    valueKind: "number",
    description: "Day move vs prior close.",
    provenanceRequired: true,
    llmKey: "chgPct",
    sources: [src("nasdaq-delayed-screener", undefined, true), src("alpaca-snapshot"), src("yahoo-finance"), src("broker-gateway")]
  },
  // Fundamentals
  {
    id: "peRatio",
    label: "P/E ratio",
    category: "fundamental",
    valueKind: "number",
    description: "Trailing P/E; n/a when eps≤0.",
    provenanceRequired: true,
    llmKey: "pe",
    sources: [
      src("yahoo-finance", undefined, true),
      src("finnhub"),
      src("roic", "Ratios endpoint may 404"),
      src("nasdaq-quote"),
      src("simfin"),
      src("rapidapi-*"),
      src("fmp", "RETIRED"),
      src("symbol_field_latest")
    ]
  },
  {
    id: "eps",
    label: "EPS",
    category: "fundamental",
    valueKind: "number",
    description: "Trailing EPS.",
    provenanceRequired: true,
    llmKey: "eps",
    sources: [src("yahoo-finance", undefined, true), src("finnhub"), src("roic"), src("symbol_field_latest")]
  },
  {
    id: "epsGrowth",
    label: "EPS growth",
    category: "fundamental",
    valueKind: "number",
    description: "YoY earnings growth fraction.",
    provenanceRequired: true,
    llmKey: "epsGr",
    sources: [src("yahoo-finance", "financialData.earningsGrowth", true), src("fmp", "RETIRED"), src("symbol_field_latest")]
  },
  {
    id: "dividendYield",
    label: "Dividend yield %",
    category: "fundamental",
    valueKind: "number",
    description: "Trailing yield in percentage points.",
    provenanceRequired: true,
    llmKey: "div",
    sources: [src("yahoo-finance", undefined, true), src("roic"), src("finnhub"), src("symbol_field_latest")]
  },
  {
    id: "debtToEquity",
    label: "Debt / equity",
    category: "fundamental",
    valueKind: "number",
    description: "Leverage ratio.",
    provenanceRequired: true,
    llmKey: "de",
    sources: [src("sec-xbrl", "Authoritative", true), src("yahoo-finance"), src("roic"), src("symbol_field_latest")]
  },
  {
    id: "fcfYield",
    label: "FCF yield %",
    category: "fundamental",
    valueKind: "number",
    description: "Free cash flow / market cap.",
    provenanceRequired: true,
    llmKey: "fcf",
    sources: [src("yahoo-finance", "Computed from freeCashflow + marketCap", true), src("fmp", "RETIRED"), src("symbol_field_latest")]
  },
  {
    id: "sector",
    label: "Sector",
    category: "fundamental",
    valueKind: "string",
    description: "GICS-like sector label.",
    provenanceRequired: true,
    llmKey: "sec",
    sources: [src("yahoo-finance", undefined, true), src("roic"), src("filingapi"), src("sec-xbrl"), src("symbol_field_latest")]
  },
  {
    id: "industry",
    label: "Industry",
    category: "fundamental",
    valueKind: "string",
    description: "Industry classification.",
    provenanceRequired: true,
    llmKey: "ind",
    sources: [src("yahoo-finance", undefined, true), src("roic"), src("filingapi"), src("symbol_field_latest")]
  },
  {
    id: "pbRatio",
    label: "Price / book",
    category: "fundamental",
    valueKind: "number",
    description: "Price-to-book.",
    provenanceRequired: true,
    llmKey: "pb",
    sources: [src("yahoo-finance", undefined, true), src("roic"), src("symbol_field_latest")]
  },
  {
    id: "shortPercentOfFloat",
    label: "Short % of float",
    category: "ownership_insider",
    valueKind: "number",
    description: "Short interest as % of float.",
    provenanceRequired: true,
    llmKey: "shortFloat",
    sources: [src("yahoo-finance", undefined, true), src("massive", "Secondary cross-check"), src("roic"), src("symbol_field_latest")]
  },
  {
    id: "institutionOwnershipPct",
    label: "Institutional ownership %",
    category: "ownership_insider",
    valueKind: "number",
    description: "Institutions percent held.",
    provenanceRequired: true,
    llmKey: "instOwn",
    sources: [src("yahoo-finance", undefined, true), src("nasdaq-quote"), src("roic"), src("symbol_field_latest")]
  },
  {
    id: "insiderSentiment",
    label: "Insider sentiment",
    category: "ownership_insider",
    valueKind: "number",
    description: "0–100 from Form 4 / insider feeds.",
    provenanceRequired: true,
    llmKey: "insiderSent",
    sources: [
      src("sec-edgar-form4", "Web-source overlay", true),
      src("filingapi", "Scarce"),
      src("rapidapi-*", "insiders-rapidapi"),
      src("symbol_field_latest")
    ]
  },
  {
    id: "thirteenFHoldings",
    label: "13F superinvestor holdings",
    category: "ownership_insider",
    valueKind: "string",
    description: "Tracked 13F-HR holders and QoQ adds/exits.",
    provenanceRequired: true,
    llmKey: "smartMoney",
    sources: [src("sec-edgar-13f", "Official EDGAR", true)]
  },
  {
    id: "arkHoldings",
    label: "ARK daily holdings",
    category: "ownership_insider",
    valueKind: "string",
    description: "Official ARK ETF weight and day-over-day adds/exits.",
    provenanceRequired: true,
    llmKey: "smartMoney",
    sources: [src("ark-funds-holdings", "Official ARK CSV", true)]
  },
  // Analyst / news
  {
    id: "analystRating",
    label: "Analyst rating",
    category: "analyst",
    valueKind: "string",
    description: "Blended Strong Buy…Strong Sell.",
    provenanceRequired: true,
    llmKey: "rating",
    sources: [src("yahoo-finance", "recommendationMean", true), src("finnhub", "stock/recommendation"), src("congress.trade", "If fundamentals peer ON"), src("symbol_field_latest")]
  },
  {
    id: "sentiment",
    label: "News sentiment",
    category: "sentiment_news",
    valueKind: "number",
    description: "0–100 keyword or model score; LLM told to prefer raw headlines.",
    provenanceRequired: true,
    llmKey: "newsSent",
    sources: [src("alpaca-news", undefined, true), src("finnhub"), src("alpha-vantage"), src("marketaux"), src("symbol_field_latest")]
  },
  {
    id: "headlines",
    label: "Headlines",
    category: "sentiment_news",
    valueKind: "string[]",
    description: "Raw titles for LLM; not numerical.",
    provenanceRequired: true,
    llmKey: "news",
    sources: [src("alpaca-news", undefined, true), src("finnhub"), src("alpha-vantage"), src("marketaux"), src("fintechstudios"), src("symbol_field_latest")]
  },
  {
    id: "daysToEarnings",
    label: "Days to earnings",
    category: "fundamental",
    valueKind: "number",
    description: "Calendar days to next report.",
    provenanceRequired: true,
    llmKey: "earnIn",
    sources: [src("yahoo-finance"), src("nasdaq-calendar", undefined, true), src("alpha-vantage", "Market-wide CSV"), src("finnhub"), src("filingapi"), src("symbol_field_latest")]
  },
  {
    id: "senateTrades",
    label: "Congress net signal",
    category: "congress_alt",
    valueKind: "number",
    description: "Congressional disclosure net score.",
    provenanceRequired: true,
    llmKey: "senateNet",
    sources: [src("congress.trade", undefined, true), src("congress-web"), src("quiverquant", "RETIRED direct")]
  },
  {
    id: "nearTheMoneyIv",
    label: "Near-the-money IV",
    category: "options",
    valueKind: "number",
    description: "Option IV; sparse.",
    provenanceRequired: true,
    llmKey: "iv",
    sources: [src("robinhood-options", "Opt-in MCP"), src("unusual-whales", "RETIRED")]
  },
  // RAG corpus (non-numerical completeness)
  {
    id: "rag:10-k",
    label: "RAG: 10-K filings",
    category: "rag_corpus",
    valueKind: "text_chunks",
    description: "Annual reports chunked into vector DB. LLM sees retrieved snippets in retrievedFinancialContext (bounded), not full 10-K dump.",
    provenanceRequired: true,
    llmKey: "retrievedFinancialContext",
    sources: [src("sec-filings-rag", "Primary ingest", true), src("roic-financials", "Multi-year summary docs")]
  },
  {
    id: "rag:10-q",
    label: "RAG: 10-Q filings",
    category: "rag_corpus",
    valueKind: "text_chunks",
    description: "Quarterly reports in vector corpus.",
    provenanceRequired: true,
    llmKey: "retrievedFinancialContext",
    sources: [src("sec-filings-rag", undefined, true)]
  },
  {
    id: "rag:8-k",
    label: "RAG: 8-K material events",
    category: "rag_corpus",
    valueKind: "text_chunks",
    description: "Current reports; ledger incomplete for empty-corpus receipt (retrieval-only).",
    provenanceRequired: true,
    llmKey: "retrievedFinancialContext",
    sources: [src("sec-filings-rag", "Summary path; full-body opt-in")]
  },
  {
    id: "rag:earnings-transcript",
    label: "RAG: earnings transcripts",
    category: "rag_corpus",
    valueKind: "text_chunks",
    description: "Call transcripts when rights/producers enabled.",
    provenanceRequired: true,
    llmKey: "retrievedFinancialContext",
    sources: [
      src("fmp-transcripts", "Rights-gated"),
      src("roic-transcripts"),
      src("earningscalls", "Opt-in")
    ]
  },
  // Derived
  {
    id: "derived:peg",
    label: "PEG (derived)",
    category: "derived",
    valueKind: "number",
    description: "P/E ÷ EPS growth %; omitted when inputs missing.",
    provenanceRequired: true,
    llmKey: "peg",
    sources: [src("derived-metrics", "Needs peRatio + epsGrowth")]
  },
  {
    id: "derived:weekly-screens",
    label: "Weekly value + momentum screens",
    category: "derived",
    valueKind: "object",
    description:
      "Native large-cap value (trailing P/E ≤ 10, within 10% of the 52-week low) and 5-day momentum screens from the account scan tape.  Missing fields exclude the name.  Advisory only.",
    provenanceRequired: true,
    llmKey: "weeklyScreens",
    sources: [
      src("nasdaq-delayed-screener", "Universe + live price / volume / cap"),
      src("symbol_field_latest", "P/E and 52-week low when the interactive scan skipped enrichment"),
      src("derived-metrics", "ROC / RSI / SMA from daily bars")
    ]
  }
];

export function catalogSourceById(id: string): CatalogSource | undefined {
  return CATALOG_SOURCES.find((s) => s.id === id);
}

export function catalogFieldsByCategory(): Record<DataCategory, CatalogField[]> {
  const out = {} as Record<DataCategory, CatalogField[]>;
  for (const f of CATALOG_FIELDS) {
    (out[f.category] ??= []).push(f);
  }
  return out;
}

export function catalogCategories(): DataCategory[] {
  return [
    "quote",
    "fundamental",
    "analyst",
    "sentiment_news",
    "ownership_insider",
    "congress_alt",
    "options",
    "rag_corpus",
    "macro",
    "derived"
  ];
}

export const CATEGORY_LABELS: Record<DataCategory, string> = {
  quote: "Quotes & tape",
  fundamental: "Fundamentals",
  analyst: "Analyst ratings / targets",
  sentiment_news: "News & sentiment",
  ownership_insider: "Ownership & insiders",
  congress_alt: "Congress & alternative",
  options: "Options",
  rag_corpus: "RAG / filings corpus (non-numeric)",
  macro: "Macro",
  derived: "Derived metrics"
};
