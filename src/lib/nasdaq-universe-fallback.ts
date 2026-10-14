import { BROWSER_UA } from "./web-sources/http";
import type { NasdaqScreenerRow } from "./nasdaq-screener-schema";
import { normalizeSymbol } from "./money";

export const SEC_COMPANY_TICKERS_EXCHANGE_URL =
  "https://www.sec.gov/files/company_tickers_exchange.json";
export const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt";
export const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt";

const SEC_UA = `${BROWSER_UA} (contact: data@socratictrade.com)`;

async function fetchText(url: string, signal?: AbortSignal, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController();
  const unlink = signal
    ? (() => {
        if (signal.aborted) controller.abort(signal.reason);
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", onAbort);
        return () => signal.removeEventListener("abort", onAbort);
      })()
    : () => {};
  const timeout = setTimeout(() => controller.abort(new Error("universe fallback fetch timeout")), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "*/*", "user-agent": url.includes("sec.gov") ? SEC_UA : BROWSER_UA }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}

function parseNasdaqTraderPipe(text: string): NasdaqScreenerRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const rows: NasdaqScreenerRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("File Creation Time")) break;
    const parts = line.split("|");
    const symbol = normalizeSymbol(parts[0] ?? "");
    const name = (parts[1] ?? "").trim();
    if (!symbol || symbol.includes("File")) continue;
    const testIssue = (parts[3] ?? "").trim().toUpperCase();
    if (testIssue === "Y") continue;
    rows.push({ symbol, name });
  }
  return rows;
}

function parseSecExchangeJson(text: string): Map<string, string> {
  const payload = JSON.parse(text) as { fields?: string[]; data?: Array<Array<string | number | null>> };
  const fields = payload.fields ?? [];
  const tickerIdx = fields.indexOf("ticker");
  const titleIdx = fields.indexOf("title");
  const out = new Map<string, string>();
  if (tickerIdx < 0) return out;
  for (const row of payload.data ?? []) {
    const ticker = normalizeSymbol(String(row[tickerIdx] ?? ""));
    if (!ticker) continue;
    const title = titleIdx >= 0 ? String(row[titleIdx] ?? "").trim() : "";
    out.set(ticker, title || ticker);
  }
  return out;
}

/** Keyless universe when api.nasdaq.com screener is down — SEC exchange map + Nasdaq Trader symbol dirs. */
export async function fetchFallbackUniverseRows(signal?: AbortSignal): Promise<NasdaqScreenerRow[]> {
  const [secText, nasdaqText, otherText] = await Promise.all([
    fetchText(SEC_COMPANY_TICKERS_EXCHANGE_URL, signal),
    fetchText(NASDAQ_LISTED_URL, signal),
    fetchText(OTHER_LISTED_URL, signal)
  ]);
  const secTitles = parseSecExchangeJson(secText);
  const pipeRows = [...parseNasdaqTraderPipe(nasdaqText), ...parseNasdaqTraderPipe(otherText)];
  const bySymbol = new Map<string, NasdaqScreenerRow>();
  for (const row of pipeRows) {
    const title = secTitles.get(row.symbol ?? "") ?? row.name;
    bySymbol.set(row.symbol ?? "", { symbol: row.symbol, name: title || row.symbol });
  }
  for (const [symbol, title] of secTitles) {
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, { symbol, name: title });
    }
  }
  return [...bySymbol.values()].sort((a, b) => (a.symbol ?? "").localeCompare(b.symbol ?? ""));
}
