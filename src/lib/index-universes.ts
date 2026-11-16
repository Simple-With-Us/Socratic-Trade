import { normalizeSymbol } from "./money";
import { SP500_SYMBOLS } from "./sp500";
import type { IndexUniverse, TradingPolicy } from "./types";

type IndexExclusiveGroup = "sp" | "nasdaq";
type DynamicUniverseSource = "blackrock-holdings" | "nasdaq-exchange" | "nasdaq-screener";

interface IndexUniverseConfig {
  label: string;
  symbols: readonly string[];
  estimatedSymbols?: number;
  exclusiveGroup?: IndexExclusiveGroup;
  dynamicSource?: DynamicUniverseSource;
  exchange?: "nasdaq" | "nyse";
}

export const NASDAQ100_SYMBOLS = [
  "NVDA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "GOOG",
  "AVGO",
  "TSLA",
  "META",
  "MU",
  "WMT",
  "AMD",
  "ASML",
  "INTC",
  "AMAT",
  "LRCX",
  "CSCO",
  "ARM",
  "COST",
  "KLAC",
  "NFLX",
  "SNDK",
  "PLTR",
  "TXN",
  "MRVL",
  "WDC",
  "STX",
  "QCOM",
  "LIN",
  "PANW",
  "ADI",
  "TMUS",
  "PEP",
  "AMGN",
  "CRWD",
  "APP",
  "GILD",
  "HON",
  "ISRG",
  "SHOP",
  "BKNG",
  "SBUX",
  "VRTX",
  "PDD",
  "CDNS",
  "FTNT",
  "MAR",
  "CEG",
  "MNST",
  "ADP",
  "SNPS",
  "CSX",
  "ABNB",
  "MELI",
  "CMCSA",
  "DDOG",
  "NXPI",
  "ADBE",
  "MDLZ",
  "MPWR",
  "DASH",
  "ROST",
  "INTU",
  "ORLY",
  "AEP",
  "CTAS",
  "LITE",
  "WBD",
  "REGN",
  "PCAR",
  "BKR",
  "MCHP",
  "FAST",
  "FANG",
  "EA",
  "FER",
  "XEL",
  "EXC",
  "ODFL",
  "TTWO",
  "IDXX",
  "CCEP",
  "KDP",
  "ADSK",
  "MSTR",
  "PYPL",
  "ALNY",
  "PAYX",
  "TRI",
  "AXON",
  "ROP",
  "WDAY",
  "GEHC",
  "CPRT",
  "DXCM",
  "KHC",
  "VRSK",
  "INSM",
  "CTSH",
  "ZS",
  "CHTR"
] as const;

export const DOW30_SYMBOLS = [
  "GS",
  "CAT",
  "UNH",
  "MSFT",
  "AXP",
  "AMGN",
  "HD",
  "V",
  "JPM",
  "SHW",
  "TRV",
  "AAPL",
  "MCD",
  "IBM",
  "AMZN",
  "HON",
  "JNJ",
  "BA",
  "NVDA",
  "CVX",
  "MMM",
  "CRM",
  "PG",
  "CSCO",
  "WMT",
  "MRK",
  "DIS",
  "KO",
  "VZ",
  "NKE"
] as const;

export const INDEX_UNIVERSES: Record<IndexUniverse, IndexUniverseConfig> = {
  sp100: {
    label: "S&P 100",
    symbols: [],
    estimatedSymbols: 101,
    exclusiveGroup: "sp",
    dynamicSource: "blackrock-holdings"
  },
  sp500: {
    label: "S&P 500",
    symbols: SP500_SYMBOLS,
    exclusiveGroup: "sp"
  },
  nasdaq100: {
    label: "Nasdaq 100",
    symbols: NASDAQ100_SYMBOLS,
    exclusiveGroup: "nasdaq"
  },
  nasdaqComposite: {
    label: "Nasdaq Composite",
    symbols: [],
    estimatedSymbols: 4100,
    exclusiveGroup: "nasdaq",
    dynamicSource: "nasdaq-exchange",
    exchange: "nasdaq"
  },
  dow30: { label: "Dow 30", symbols: DOW30_SYMBOLS },
  russell2000: {
    label: "Russell 2000",
    symbols: [],
    estimatedSymbols: 2000,
    dynamicSource: "blackrock-holdings"
  },
  nyseComposite: {
    label: "NYSE Composite",
    symbols: [],
    estimatedSymbols: 2700,
    dynamicSource: "nasdaq-exchange",
    exchange: "nyse"
  },
  ftWilshire5000: {
    label: "FT Wilshire 5000",
    symbols: [],
    estimatedSymbols: 5000,
    dynamicSource: "nasdaq-screener"
  }
};

export const SUPPORTED_INDEX_UNIVERSES = Object.keys(INDEX_UNIVERSES) as IndexUniverse[];

export function isIndexUniverse(value: string): value is IndexUniverse {
  return value in INDEX_UNIVERSES;
}

export function indexUniverseLabel(index: IndexUniverse): string {
  return INDEX_UNIVERSES[index].label;
}

/** User-facing label for a stored/API slug.  Unknown values stay off the label
 *  so camelCase ids like `sp500` never print as copy. */
export function indexUniverseDisplayLabel(value: string): string {
  const trimmed = value.trim();
  return isIndexUniverse(trimmed) ? indexUniverseLabel(trimmed) : "";
}

export function formatIndexUniverseLabels(values: readonly string[] | undefined): string[] {
  return (values ?? []).map(indexUniverseDisplayLabel).filter((label) => label.length > 0);
}

/** Joined selected-set copy for Guardrails / Desk / policy-diff.  Empty → "none". */
export function formatIndexUniverseList(values: readonly string[] | undefined): string {
  const labels = formatIndexUniverseLabels(values);
  return labels.length > 0 ? labels.join(", ") : "none";
}

export function indexUniverseSymbolCount(index: IndexUniverse): number {
  return INDEX_UNIVERSES[index].estimatedSymbols ?? INDEX_UNIVERSES[index].symbols.length;
}

export function isDynamicIndexUniverse(index: IndexUniverse): boolean {
  return Boolean(INDEX_UNIVERSES[index]?.dynamicSource);
}

export function dynamicIndexUniversesForPolicy(policy: Pick<TradingPolicy, "includedIndices">): IndexUniverse[] {
  return normalizeIncludedIndices(policy.includedIndices || []).filter(isDynamicIndexUniverse);
}

export function normalizeIncludedIndices(indices: readonly IndexUniverse[]): IndexUniverse[] {
  const selected = new Set<IndexUniverse>();
  for (const index of indices) {
    if (!isIndexUniverse(index)) continue;
    const exclusiveGroup = INDEX_UNIVERSES[index].exclusiveGroup;
    if (exclusiveGroup) {
      for (const item of Array.from(selected)) {
        if (INDEX_UNIVERSES[item].exclusiveGroup === exclusiveGroup) selected.delete(item);
      }
    }
    selected.add(index);
  }
  return SUPPORTED_INDEX_UNIVERSES.filter((item) => selected.has(item));
}

export function toggleIncludedIndex(
  current: readonly IndexUniverse[],
  index: IndexUniverse,
  checked: boolean
): IndexUniverse[] {
  if (!checked) return SUPPORTED_INDEX_UNIVERSES.filter((item) => item !== index && current.includes(item));
  return normalizeIncludedIndices([...current.filter((item) => item !== index), index]);
}

export function symbolsForPolicyUniverse(policy: Pick<TradingPolicy, "includedIndices" | "additionalSymbols" | "blocklist">): string[] {
  const symbols = new Set<string>();
  for (const index of normalizeIncludedIndices(policy.includedIndices || [])) {
    INDEX_UNIVERSES[index]?.symbols.forEach((symbol) => symbols.add(symbol));
  }
  for (const symbol of policy.additionalSymbols || []) {
    const normalized = normalizeSymbol(symbol);
    if (normalized) symbols.add(normalized);
  }
  for (const symbol of policy.blocklist || []) {
    symbols.delete(normalizeSymbol(symbol));
  }
  return Array.from(symbols);
}

export function policyUniverseSymbolCount(policy: Pick<TradingPolicy, "includedIndices" | "additionalSymbols" | "blocklist">): { count: number; approximate: boolean } {
  const exactSymbols = symbolsForPolicyUniverse(policy);
  const dynamicCount = dynamicIndexUniversesForPolicy(policy)
    .reduce((sum, index) => sum + indexUniverseSymbolCount(index), 0);
  const blocklist = new Set((policy.blocklist || []).map(normalizeSymbol).filter(Boolean));
  const dynamicBlocklistAdjustment = dynamicCount > 0
    ? Math.min(blocklist.size, dynamicCount)
    : 0;
  return {
    count: Math.max(0, exactSymbols.length + dynamicCount - dynamicBlocklistAdjustment),
    approximate: dynamicCount > 0
  };
}

const INDEX_MEMBER_SYMBOLS = new Set<string>([
  ...SP500_SYMBOLS,
  ...NASDAQ100_SYMBOLS,
  ...DOW30_SYMBOLS
]);

export function isIndexMemberSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  return INDEX_MEMBER_SYMBOLS.has(normalized);
}

export function isValidAppSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  // Additional Watchlist supports custom U.S. equity/ETF tickers such as SPCX
  // even when they are not members of the embedded index snapshots.
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(normalized) && !normalized.includes("..") && !normalized.endsWith(".");
}
