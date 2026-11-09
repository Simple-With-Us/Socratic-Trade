import { isIndexMemberSymbol, isValidAppSymbol } from "./index-universes";
import { normalizeSymbol } from "./money";
import { fetchYahooFinanceQuote } from "./yahoo-finance";

export function normalizePolicySymbolList(raw: unknown, fallback: string[]): string[] {
  return Array.from(new Set(
    (Array.isArray(raw) ? raw.map(String) : fallback)
      .map(normalizeSymbol)
      .filter(Boolean)
  ));
}

export function sanitizePolicySymbolList(source: string[]): string[] {
  return source.filter((symbol): symbol is string => typeof symbol === "string" && isValidAppSymbol(symbol));
}

export function newlyAddedInvalidSymbols(next: string[], current: string[]): string[] {
  const currentSet = new Set(current.map(normalizeSymbol).filter(Boolean));
  return Array.from(new Set(next.filter((symbol) => !currentSet.has(symbol) && !isValidAppSymbol(symbol))));
}

export function invalidSymbolMessage(symbols: string[]): string {
  const label = symbols.length === 1 ? "symbol" : "symbols";
  return `Invalid ${label}: ${symbols.join(", ")}. Use a U.S. equity/ETF ticker: 1-10 letters, numbers, or dots, starting with a letter.`;
}

export async function validateNewCustomPolicySymbols(next: string[], current: string[]): Promise<string | undefined> {
  const currentSet = new Set(current.map(normalizeSymbol).filter(Boolean));
  const custom = next.filter((symbol) => !currentSet.has(symbol) && !isIndexMemberSymbol(symbol));
  if (custom.length === 0) return undefined;

  const unresolved: string[] = [];
  await Promise.all(custom.map(async (symbol) => {
    const quote = await fetchYahooFinanceQuote(symbol);
    if (!quote) unresolved.push(symbol);
  }));

  if (unresolved.length === 0) return undefined;
  const label = unresolved.length === 1 ? "ticker" : "tickers";
  return `Could not add ${unresolved.join(", ")}: no current U.S. equity/ETF quote was available for ${label}. Check the ticker or try again if the market data provider is temporarily unavailable.`;
}
