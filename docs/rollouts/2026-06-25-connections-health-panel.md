# 2026-06-25 — API Connections Health Panel

## Summary

Built a full-stack admin panel at `/admin/connections` for monitoring the health of every
API provider the app calls. Shows last success/failure times, call frequency, latency, error
patterns, and highlights when a service has stopped working.

## Why

The app uses 11 external API providers (3 data enrichment tiers, 3 specialized feeds, congress
source, robinhood, alpaca) but had no visibility into which keys were working, how often they
were called, or when they broke. A previous build added a congress.trade health display; this
extends that pattern to every provider.

## What changed

### New database tables (`src/lib/db.ts`)
Two tables added inside `migrate()` before the closing backtick (line 598):
- `api_health_log` — one row per API call: service, ts, ok (0/1), latency_ms, error_text.
  SHA-256-fingerprinted, FIFO capped at 500 rows per service.
- `api_health_error_patterns` — deduplicated error patterns per service with first/last seen
  and count. Keyed on `(service, fingerprint)` with `ON CONFLICT DO UPDATE`.
- `export * from "./db-health"` added to the barrel exports.

### New module (`src/lib/db-health.ts`)
- `logApiHealth(opts)` — synchronous (better-sqlite3), wrapped in a transaction, never throws.
  On failure rows, also upserts the error pattern table.
- `getServiceHealthSummaries()` — returns `ServiceHealthSummary[]` for all recorded services,
  including "stopped working" detection: last 5 all-fail OR active in past hour with no recent
  success.
- `getServiceHealthLog(service, limit, offset)` — paginated raw log.
- `getServiceErrorPatterns(service)` — all error patterns for a service.
- `getAllErrorPatterns()` — all patterns grouped by service.
- `listHealthServices()` — distinct service names.

### fetchWithRetry patched (`src/lib/data-providers.ts`)
Added `service?: string` to options. When set, wraps the inner loop with try/catch:
- On success/non-success response: logs `ok`, HTTP status error text if not ok, latency.
- On network error (throw): logs ok=false with error message, re-throws.

All 10 provider call sites wired with `service: this.name`:
- `alpaca-news` (line 776)
- `alpaca-snapshot` (line 880)
- `yahoo-finance` (line 1030)
- `finnhub` getJson (line 1268)
- `fmp` getJson (line 1408)
- `alpha-vantage` direct (line 1457)
- `fintechstudios` direct (line 1625)
- `intrinio` getJson (line 1817)
- `tiingo` getJson (line 1945)
- `twelvedata` direct (line 1999)

### congress-trade-client.ts instrumented
`getJson` now calls `logApiHealth` for service `"congress.trade"` on success and on error.
Import added for `logApiHealth`.

### New API route (`app/api/admin/connections-health/route.ts`)
- `requireAdmin(request)` guard + `export const dynamic = "force-dynamic"`
- GET with no params: returns `{ services, errorPatterns, asOf }`
- GET with `?service=X`: returns paginated raw log

### New admin pages
- `app/admin/layout.tsx` — minimal wrapper
- `app/admin/connections/page.tsx` — server component, exports metadata
- `app/admin/connections/connections-health-client.tsx` — full client component:
  - Polls `/api/admin/connections-health` every 30s
  - Service cards sorted stopped-first, then alphabetical
  - `Dot` health indicator (up/down/warn/neutral), STOPPED chip with pulse animation
  - Clicking a card opens a detail panel (sticky on desktop)
  - Detail panel: Tabs "Raw Log" / "Error Patterns"
  - Raw log fetched lazily on tab switch
  - Responsive grid: single column → side-by-side on lg

### Dashboard nav link (`app/dashboard-client.tsx`)
"View Status →" link added after `<ApiKeysSection />` in the `section === "connections"` block.

## Files touched
- `src/lib/db.ts` — two new tables + barrel export
- `src/lib/db-health.ts` — NEW
- `src/lib/data-providers.ts` — fetchWithRetry + 10 call sites
- `src/lib/congress-trade-client.ts` — getJson instrumented
- `app/api/admin/connections-health/route.ts` — NEW
- `app/admin/layout.tsx` — NEW
- `app/admin/connections/page.tsx` — NEW
- `app/admin/connections/connections-health-client.tsx` — NEW
- `app/dashboard-client.tsx` — nav link
- `STATUS.md` — updated
- `docs/rollouts/2026-06-25-connections-health-panel.md` — this file

## Verification
```bash
npx tsc --noEmit    # clean
npm test            # 1066/1067 (1 pre-existing cache-provenance date flake)
npm run build       # clean
```

## Follow-ups / known gaps
- The `robinhood-fundamentals` provider (line 653) calls its own internal cache layer and
  doesn't use `fetchWithRetry` — health logging not wired there yet (would require a different
  instrumentation point in the Robinhood quotes fetcher).
- No alerting/notification on "stopped working" — currently only visible in the admin page.
- The `/admin/connections` page uses `requireAdmin` (env-token gate) — fine for the current
  single-user deployment.
