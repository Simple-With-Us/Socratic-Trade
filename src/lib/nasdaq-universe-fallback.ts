import { z } from "zod";
import { BROWSER_UA } from "./web-sources/http";
import type { NasdaqScreenerRow } from "./nasdaq-screener-schema";
import { normalizeSymbol } from "./money";

// SEC company_tickers_exchange.json.  `.strict()` so a drifted envelope is not
// indexed.  A schema miss yields no titles (Nasdaq Trader rows still stand);
// it does not throw the whole universe away.
const SecExchangeCell = z.union([z.string(), z.number(), z.null()]);
export const SecExchangeSchema = z
  .object({
    fields: z.array(z.string()).optional(),
    data: z.array(z.array(SecExchangeCell)).optional()
  })
  .strict();

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
  const out = new Map<string, string>();
  if (!text.trim()) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  const parsed = SecExchangeSchema.safeParse(raw);
  if (!parsed.success) return out;
  const fields = parsed.data.fields ?? [];
  const tickerIdx = fields.indexOf("ticker");
  // The published file uses `name`.  Fixtures and older notes say `title`.
  const titleIdx = fields.includes("title") ? fields.indexOf("title") : fields.indexOf("name");
  if (tickerIdx < 0) return out;
  for (const row of parsed.data.data ?? []) {
    const ticker = normalizeSymbol(String(row[tickerIdx] ?? ""));
    if (!ticker) continue;
    const title = titleIdx >= 0 ? String(row[titleIdx] ?? "").trim() : "";
    out.set(ticker, title || ticker);
  }
  return out;
}

/** Keyless universe when api.nasdaq.com screener is down — SEC exchange map + Nasdaq Trader symbol dirs. */
export async function fetchFallbackUniverseRows(signal?: AbortSignal): Promise<NasdaqScreenerRow[]> {
  // One dead source (SEC 429, a single Nasdaq Trader 5xx) must not drop the other two.
  const settled = await Promise.allSettled([
    fetchText(SEC_COMPANY_TICKERS_EXCHANGE_URL, signal),
    fetchText(NASDAQ_LISTED_URL, signal),
    fetchText(OTHER_LISTED_URL, signal)
  ]);
  const textAt = (index: number): string =>
    settled[index]?.status === "fulfilled" ? settled[index].value : "";
  const secTitles = parseSecExchangeJson(textAt(0));
  const pipeRows = [...parseNasdaqTraderPipe(textAt(1)), ...parseNasdaqTraderPipe(textAt(2))];
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
  if (bySymbol.size === 0) {
    const reasons = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => (entry.reason instanceof Error ? entry.reason.message : String(entry.reason)));
    throw new Error(
      `keyless universe fallback failed${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`
    );
  }
  return [...bySymbol.values()].sort((a, b) => (a.symbol ?? "").localeCompare(b.symbol ?? ""));
}
