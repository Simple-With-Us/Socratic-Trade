# 2026-11-09 - screener proxy-gate priority + freshness backoff (ST-3999)

## Summary

- URGENT prod fix for autopilot failing with "Quotes were unavailable for this universe" (ST-3999; Yahoo side owned by another seat under ST-4591).
- Root cause: every proxied request waits FIFO for one of 4 proxy-gate slots, but caller timers start before the gate wait. The per-minute market-scan-freshness failures re-priced the whole ~500-name allowed set from Yahoo, saturating the gate, so the screener request starved past its 15s budget, which re-triggered the Yahoo fallback: a self-sustaining loop.
- (a) The Nasdaq screener now takes a priority lane on the proxy gate (queue-jump + one reserved slot above the cap), its 15s per-attempt budget excludes gate queue wait, and after both proxied attempts fail it makes one final direct-egress attempt (same 15s bound; never on parent abort, never under `fail_closed`, never when no proxy is configured). Both `fetchNasdaqScreenerResponse` services (`nasdaq-delayed-screener`, `congress-nasdaq-screener`) get this.
- (b) The freshness lane now passes `allowWholeSetYahooFallback: false` (seed fallback still applies; without a seed the scan reports quotes unavailable as before) and backs off per user after consecutive screener/quote-outage failures (1m doubling to a 15m cap, reset on success/fresh), logging one line per skipped tick.

## Why

- Prod evidence 2026-11-09: `nasdaq-delayed-screener` failed 172/172 with "Nasdaq delayed screener timed out waiting for api.nasdaq.com." while the same URL answered 200 (1.4MB) in 1.7s via proxy and 6.8s direct; Yahoo v7 chunks logged AbortError (8s timer) ~3,800x instead of the direct-measured 401. The gate, not the upstreams, was the bottleneck.

## Files

- `src/lib/proxy-fetch.ts` — `ProxyConcurrencyGate.acquire(signal, { priority })`; priority waiters granted first and may use one reserved slot above the cap (cap+1 max); `createProxiedFetch` `priority` option.
- `src/lib/data-source-fetch.ts` — `DataSourceFetchOpts` (`proxyPriority`, `bypassProxy`, `onProxyQueueWait`); bypass path goes direct with watchdog fallback entry, refused under `fail_closed`.
- `src/lib/data-providers.ts` — `fetchWithRetry` accepts and forwards the three options to `dataSourceFetch`.
- `src/lib/nasdaq-screener-fetch.ts` — screener attempts use `proxyPriority`, extend the 15s deadline by measured queue wait, and fall back to one final `bypassProxy` attempt on timeout/abort/proxy-leg failure (parent-abort, no-proxy, and `fail_closed` skip it; warns via `warnProxyFallback`).
- `src/lib/types.ts` — `MarketDataProviderOptions.allowWholeSetYahooFallback`.
- `src/lib/market.ts` — `scanMarket` threads the flag through `nasdaqDelayedProvider.scan` into `recoverQuotesWhenScreenerEmpty` (seed still wins; `false` skips only the Yahoo whole-set leg).
- `src/lib/market-scan-freshness.ts` — freshness scans pass `allowWholeSetYahooFallback: false`; per-user quote-outage backoff (`FRESHNESS_QUOTE_OUTAGE_BASE_BACKOFF_MS` 1m / `MAX` 15m, `freshnessQuoteOutageForTests` hook, reset in `resetFreshnessGateForTests`).
- `test/proxy-concurrency-gate.test.ts` — priority lane: queue-jump + normal FIFO, reserved-slot-only-for-priority, cap+1 under load, priority abort-while-queued.
- `test/data-source-fetch.test.ts` — bypass goes direct, refused under `fail_closed`, fallback telemetry entry.
- `test/scan-empty-screener.test.ts` — screener rides the reserved slot under saturation; 15s budget excludes queue wait; final direct succeeds on hung proxy (1 direct call); `fail_closed` skips; parent abort never retries/bypasses; flag skips Yahoo whole-set but keeps seed; existing timeout test now advances 3x15s.
- `test/market-scan-freshness.test.ts` — flag forwarded; 1m backoff + log line; doubling to 15m cap + reset on success; no backoff on generic failures; screener-shaped and zero-quote failures back off.

## Verification

- `npx tsc --noEmit -p .` clean.
- `npx eslint` on all 11 changed files: 0 errors (10 pre-existing warnings).
- Focused suites: `test/proxy-concurrency-gate.test.ts` + `test/data-source-fetch.test.ts` 49/49; `test/scan-empty-screener.test.ts` + `test/market-scan-freshness.test.ts` 74/74; regression sweep (`yahoo-quote-fallback`, `quotes-cascade`, `proxy-fetch`, `proxy-use-log`, `proxy-use-route`, `nasdaq-screener-fallback-cache`, `nasdaq-screener-schema`, `nasdaq-universe-fallback`, `nasdaq-calendar-provider`, `nasdaq-quote-enrichment`, `user-proxy-settings`) 137/137.
- Full `npx vitest run`: PENDING (running at commit time; see STATUS.md).

## Follow-ups

- ST-4591 (other seat, `src/lib/yahoo-finance.ts` untouched here) owns the Yahoo v7 side.
- After deploy: confirm `nasdaq-delayed-screener` api_health_log recovers, freshness `backing off` lines appear only during real outages, and proxy-use `fallbacks` stay near zero.
- Consider whether the interactive `/api/scan` path wants the same whole-set opt-out under sustained outage (left default-true per spec).

## Blockers

- None. Committed on `fix/st-3999-screener-gate-priority`, not pushed, no PR (per task rules). Linear/Zulip untouched (no posting from this session).
