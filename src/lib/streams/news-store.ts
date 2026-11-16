// Push-fed news store. The Alpaca news WebSocket worker writes here as articles arrive; the
// enrichment provider reads here FIRST and falls back to the REST poll when a symbol has no
// fresh streamed news. globalThis-pinned for the same Next.js module-duplication reason as the
// SSE event bus (see src/lib/events.ts).

import { fromAlpacaSymbol } from "../money";

interface StoredNews {
  headlines: string[];
  updatedAt: number;
  seen: Set<string>; // article ids/headlines already recorded (dedup)
}

const MAX_HEADLINES = 5;
const SEEN_CAP = 200;

const globalForNews = globalThis as unknown as { __newsStore?: Map<string, StoredNews> };
const store: Map<string, StoredNews> = globalForNews.__newsStore ?? (globalForNews.__newsStore = new Map());

/** Record a streamed article against each of its tickers. Idempotent per (symbol, article id). */
export function recordStreamedArticle(symbols: string[], headline: string, id: string): void {
  const clean = headline.trim();
  if (!clean) return;
  const dedup = id || clean;
  const now = Date.now();
  for (const raw of symbols) {
    // Alpaca tags streamed articles with its own dot notation (BRK.B) — store under our
    // hyphenated internal format (BRK-B) so getStreamedHeadlines lookups actually match.
    const symbol = fromAlpacaSymbol(String(raw));
    if (!symbol) continue;
    let entry = store.get(symbol);
    if (!entry) {
      entry = { headlines: [], updatedAt: now, seen: new Set() };
      store.set(symbol, entry);
    }
    if (entry.seen.has(dedup)) continue;
    entry.seen.add(dedup);
    entry.headlines.unshift(clean);
    if (entry.headlines.length > MAX_HEADLINES) entry.headlines.length = MAX_HEADLINES;
    if (entry.seen.size > SEEN_CAP) entry.seen = new Set(Array.from(entry.seen).slice(-Math.floor(SEEN_CAP / 2)));
    entry.updatedAt = now;
  }
}

/** Fresh streamed headlines for a symbol, or undefined when absent/stale. */
export function getStreamedHeadlines(symbol: string, maxAgeMs: number): string[] | undefined {
  const entry = store.get(String(symbol).trim().toUpperCase());
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > maxAgeMs) return undefined;
  return entry.headlines.length > 0 ? [...entry.headlines] : undefined;
}

export function newsStoreSize(): number {
  return store.size;
}
