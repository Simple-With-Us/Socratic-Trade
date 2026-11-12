// Short-TTL cache for successful provider field reads (symbol + field granularity).
// Used when a lane is rate-limited so enrichment can serve the last good value instead of
// burning the cascade on repeated 429s.  In-memory only — same posture as enrichment caches.

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 50_000;

type CacheEntry = { expiresAt: number; value: unknown };
type SymbolFieldEntry = { provider: string; expiresAt: number; value: unknown };

const cache = new Map<string, CacheEntry>();
// O(1) last-good lookup.  The primary map stays the eviction order.
const bySymbolField = new Map<string, SymbolFieldEntry>();

export function providerFieldCacheKey(provider: string, symbol: string, field: string): string {
  return `${provider}|${symbol}|${field}`;
}

function symbolFieldKey(symbol: string, field: string): string {
  return `${symbol}|${field}`;
}

function forgetSymbolField(provider: string, symbol: string, field: string, expiresAt: number): void {
  const key = symbolFieldKey(symbol, field);
  const current = bySymbolField.get(key);
  if (current && current.provider === provider && current.expiresAt === expiresAt) {
    bySymbolField.delete(key);
  }
}

function evictOverflow(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    const parts = oldest.split("|");
    if (!entry || parts.length < 3) continue;
    const provider = parts[0] ?? "";
    const field = parts[parts.length - 1] ?? "";
    const symbol = parts.slice(1, -1).join("|");
    forgetSymbolField(provider, symbol, field, entry.expiresAt);
  }
}

export function readProviderFieldCache<T>(
  provider: string,
  symbol: string,
  field: string,
  now = Date.now()
): T | undefined {
  const key = providerFieldCacheKey(provider, symbol, field);
  const hit = cache.get(key);
  if (!hit || hit.expiresAt <= now) {
    if (hit) {
      cache.delete(key);
      forgetSymbolField(provider, symbol, field, hit.expiresAt);
    }
    return undefined;
  }
  return hit.value as T;
}

export function writeProviderFieldCache(
  provider: string,
  symbol: string,
  field: string,
  value: unknown,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now()
): void {
  const key = providerFieldCacheKey(provider, symbol, field);
  const expiresAt = now + ttlMs;
  // Delete first so a refresh moves to the newest insertion slot.
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { expiresAt, value });
  const sfKey = symbolFieldKey(symbol, field);
  const prev = bySymbolField.get(sfKey);
  if (!prev || expiresAt >= prev.expiresAt) {
    bySymbolField.set(sfKey, { provider, expiresAt, value });
  }
  evictOverflow();
}

/** Last good value for a symbol+field from any provider lane (used after 429 / rotation). */
export function readProviderFieldCacheForSymbol<T>(
  symbol: string,
  field: string,
  now = Date.now()
): { provider: string; value: T } | undefined {
  const key = symbolFieldKey(symbol, field);
  const entry = bySymbolField.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) bySymbolField.delete(key);
    return undefined;
  }
  return { provider: entry.provider, value: entry.value as T };
}

export function clearProviderFieldCacheForTests(): void {
  cache.clear();
  bySymbolField.clear();
}
