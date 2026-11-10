import { normalizeSymbol } from "./money";
import type { IndexUniverse } from "./types";

const BLACKROCK_HOLDING_FUNDS = {
  sp100: {
    label: "iShares S&P 100 ETF",
    provider: "blackrock-oef-holdings",
    portfolioId: "239723"
  },
  russell2000: {
    label: "iShares Russell 2000 ETF",
    provider: "blackrock-iwm-holdings",
    portfolioId: "239710"
  }
} satisfies Partial<Record<IndexUniverse, { label: string; provider: string; portfolioId: string }>>;

type BlackRockHoldingUniverse = keyof typeof BLACKROCK_HOLDING_FUNDS;

const SYMBOL_OVERRIDES: Record<string, string> = {
  BRKA: "BRK-A",
  BRKB: "BRK-B",
  BFA: "BF-A",
  BFB: "BF-B"
};

let holdingsCache = new Map<BlackRockHoldingUniverse, { expiresAt: number; symbols: string[] }>();

export function isBlackRockHoldingUniverse(index: IndexUniverse): index is BlackRockHoldingUniverse {
  return index in BLACKROCK_HOLDING_FUNDS;
}

export function blackRockHoldingProvider(index: BlackRockHoldingUniverse): string {
  return BLACKROCK_HOLDING_FUNDS[index].provider;
}

export async function fetchBlackRockHoldingSymbols(
  index: BlackRockHoldingUniverse,
  ttlMs: number,
  signal?: AbortSignal
): Promise<{ symbols: string[]; cached: boolean; provider: string; label: string }> {
  const now = Date.now();
  const cached = holdingsCache.get(index);
  if (cached && cached.expiresAt > now) {
    return {
      symbols: cached.symbols,
      cached: true,
      provider: BLACKROCK_HOLDING_FUNDS[index].provider,
      label: BLACKROCK_HOLDING_FUNDS[index].label
    };
  }

  const fund = BLACKROCK_HOLDING_FUNDS[index];
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(blackRockFundDownloadUrl(fund.portfolioId), {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.ms-excel,text/xml,*/*",
        "user-agent": "Mozilla/5.0"
      }
    });
    if (!response.ok) throw new Error(`${fund.label} holdings request failed with ${response.status}.`);

    const xml = await response.text();
    const symbols = parseBlackRockSpreadsheetSymbols(xml);
    if (symbols.length === 0) throw new Error(`${fund.label} holdings returned no equity symbols.`);
    holdingsCache.set(index, { symbols, expiresAt: now + ttlMs });
    return { symbols, cached: false, provider: fund.provider, label: fund.label };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function clearFundHoldingsCache(): void {
  holdingsCache = new Map();
}

export function parseBlackRockSpreadsheetSymbols(xml: string): string[] {
  const rows = xml.match(/<ss:Row\b[\s\S]*?<\/ss:Row>/g) ?? [];
  let tickerColumn = -1;
  let assetClassColumn = -1;
  let currencyColumn = -1;
  const symbols: string[] = [];

  for (const row of rows) {
    const cells = parseSpreadsheetRow(row);
    if (tickerColumn < 0) {
      const normalizedHeaders = cells.map((cell) => cell.trim().toLowerCase());
      const nextTickerColumn = normalizedHeaders.indexOf("ticker");
      if (nextTickerColumn >= 0) {
        tickerColumn = nextTickerColumn;
        assetClassColumn = normalizedHeaders.indexOf("asset class");
        currencyColumn = normalizedHeaders.indexOf("currency");
      }
      continue;
    }

    const assetClass = assetClassColumn >= 0 ? cells[assetClassColumn]?.trim().toLowerCase() : "";
    if (assetClass && assetClass !== "equity") continue;
    const currency = currencyColumn >= 0 ? cells[currencyColumn]?.trim().toUpperCase() : "";
    if (currency && currency !== "USD") continue;
    const symbol = normalizeHoldingSymbol(cells[tickerColumn] ?? "");
    if (!symbol) continue;
    symbols.push(symbol);
  }

  return Array.from(new Set(symbols));
}

function blackRockFundDownloadUrl(portfolioId: string): string {
  const url = new URL("https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document");
  url.searchParams.set("appSubType", "ISHARES");
  url.searchParams.set("appType", "PRODUCT_PAGE");
  url.searchParams.set("component", "fundDownload");
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("portfolioId", portfolioId);
  url.searchParams.set("targetSite", "us-ishares");
  url.searchParams.set("userType", "individual");
  return url.toString();
}

function normalizeHoldingSymbol(value: string): string {
  const raw = normalizeSymbol(decodeXml(value));
  if (!raw || raw === "--" || raw.includes(" ")) return "";
  const normalized = SYMBOL_OVERRIDES[raw] ?? raw.replace(/\//g, "-");
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized) ? normalized : "";
}

function parseSpreadsheetRow(row: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<ss:Cell\b([^>]*)>([\s\S]*?)<\/ss:Cell>/g;
  let currentColumn = 0;
  let match: RegExpExecArray | null;

  while ((match = cellRegex.exec(row))) {
    const indexMatch = match[1]?.match(/ss:Index="(\d+)"/);
    if (indexMatch) currentColumn = Number(indexMatch[1]) - 1;
    const dataMatch = match[2]?.match(/<ss:Data\b[^>]*>([\s\S]*?)<\/ss:Data>/);
    cells[currentColumn] = decodeXml(dataMatch?.[1] ?? "");
    currentColumn += 1;
  }

  return cells;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .trim();
}
