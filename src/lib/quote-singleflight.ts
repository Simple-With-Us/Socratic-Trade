import type { SymbolEnrichment } from "./data-providers";

/** Keep a timed-out on-demand cascade useful to later opens instead of starting
 * another full provider fan-out for the same user and symbol. A bounded lease
 * prevents a permanently hung provider from poisoning that key until restart. */
const DEFAULT_QUOTE_SINGLEFLIGHT_TTL_MS = 30_000;
const activeQuotes = new Map<string, {
  promise: Promise<SymbolEnrichment>;
  timer: ReturnType<typeof setTimeout>;
}>();

export function runQuoteEnrichmentSingleFlight(
  key: string,
  factory: () => Promise<SymbolEnrichment>,
  ttlMs = DEFAULT_QUOTE_SINGLEFLIGHT_TTL_MS
): Promise<SymbolEnrichment> {
  const existing = activeQuotes.get(key);
  if (existing) return existing.promise;

  const pending = Promise.resolve().then(factory);
  const timer = setTimeout(() => {
    if (activeQuotes.get(key)?.promise === pending) activeQuotes.delete(key);
  }, Math.max(1, ttlMs));
  timer.unref?.();
  activeQuotes.set(key, { promise: pending, timer });
  const clear = () => {
    const current = activeQuotes.get(key);
    if (current?.promise !== pending) return;
    clearTimeout(current.timer);
    activeQuotes.delete(key);
  };
  void pending.then(clear, clear);
  return pending;
}

export function resetQuoteSingleFlightForTests(): void {
  for (const entry of activeQuotes.values()) clearTimeout(entry.timer);
  activeQuotes.clear();
}
