// Short-TTL cache for successful provider field reads (symbol + field granularity).
// Used when a lane is rate-limited so enrichment can serve the last good value instead of
// burning the cascade on repeated 429s.  In-memory only — same posture as enrichment caches.

const DEFAULT_TTL_MS = 6 * 60 * 60_000;

type CacheEntry = { expiresAt: number; value: unknown };

const cache = new Map<string, CacheEntry>();

export function providerFieldCacheKey(provider: string, symbol: string, field: string): string {
  return `${provider}|${symbol}|${field}`;
}

export function readProviderFieldCache<T>(
  provider: string,
  symbol: string,
  field: string,
  now = Date.now()
): T | undefined {
  const hit = cache.get(providerFieldCacheKey(provider, symbol, field));
  if (!hit || hit.expiresAt <= now) return undefined;
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
  cache.set(providerFieldCacheKey(provider, symbol, field), { expiresAt: now + ttlMs, value });
}

/** Last good value for a symbol+field from any provider lane (used after 429 / rotation). */
export function readProviderFieldCacheForSymbol<T>(
  symbol: string,
  field: string,
  now = Date.now()
): { provider: string; value: T } | undefined {
  const suffix = `|${symbol}|${field}`;
  let best: { provider: string; value: T; expiresAt: number } | undefined;
  for (const [key, entry] of cache) {
    if (!key.endsWith(suffix) || entry.expiresAt <= now) continue;
    const provider = key.slice(0, key.length - suffix.length);
    if (!best || entry.expiresAt > best.expiresAt) {
      best = { provider, value: entry.value as T, expiresAt: entry.expiresAt };
    }
  }
  return best ? { provider: best.provider, value: best.value } : undefined;
}

export function clearProviderFieldCacheForTests(): void {
  cache.clear();
}
