# 2026-06-25 — Credential-Scoped Health Lanes

## Summary

Extended the API Connections Health Panel (landed same day) to track health rows per
`(service, key_source)` credential lane. Previously all calls for a service (env key and
user key) shared a single health card, causing false STOPPED alerts when one user's key
failed but the env key was healthy.

## Why

Codex P2 review finding: env-key calls and user-key calls were co-mingled in the same
service card. A user with a bad API key would trigger "last 5 consecutive calls all failed"
on the shared lane, hiding the fact that the env key was fine.

## What changed

### Schema additions (`src/lib/db.ts`)
- `api_health_log` — added `key_source TEXT` and `user_id TEXT` columns (CREATE TABLE already
  had them; added ALTER TABLE migrations for existing DBs that pre-date credential scoping)
- `api_health_error_patterns` — added `key_source TEXT` column; UNIQUE constraint upgraded to
  `(service, fingerprint, key_source)` in CREATE TABLE
- `idx_api_health_log_service_key ON api_health_log (service, key_source, ts DESC)` — new index
  (also added via ALTER TABLE migration for existing DBs)
- ALTER TABLE migration block added (guarded by PRAGMA table_info) to upgrade pre-existing DBs

### db-health.ts (`src/lib/db-health.ts`)
- `ServiceHealthSummary` now includes `keySource: string | null`
- `HealthLogRow` and `ErrorPatternRow` now include `key_source: string | null`
- `logApiHealth` — `keySource` and `userId` are stored in the new columns; FIFO cap and
  error pattern upsert are scoped to `(service, key_source)` using `key_source IS ?`
- `listHealthLanes()` — returns `{ service, key_source }[]` pairs (one entry per distinct lane)
- `getServiceHealthSummaries()` — iterates lanes; all queries scoped to `(service, key_source)`
- `getAllErrorPatterns()` — keys result by `"service:keySource"` composite string

### Provider constructors (`src/lib/data-providers.ts`)
All remaining 8 provider classes that were missing `private readonly keySource: ApiKeySource`
were updated: FinnhubEnrichmentProvider, FmpEnrichmentProvider, AlphaVantageEnrichmentProvider,
FintechStudiosEnrichmentProvider, IntrinioEnrichmentProvider, TiingoEnrichmentProvider,
TwelveDataEnrichmentProvider. (AlpacaNews/AlpacaSnapshot were already done in the first pass.)

### fetchWithRetry call sites (`src/lib/data-providers.ts`)
All 9 keyed-provider call sites updated to pass `keySource: this.keySource, userId: this.userId`:
- Finnhub `getJson`
- FMP `getJson`
- AlphaVantage direct call + explicit `logApiHealth` call (200-but-error case)
- FintechStudios direct call
- Intrinio `getJson`
- Tiingo `getJson`
- TwelveData direct call
Yahoo Finance (public API, no key) intentionally left without keySource — logs as `key_source = NULL`.

### Admin API route (`app/api/admin/connections-health/route.ts`)
- Accepts `?keySource=` query param; passes it to `getServiceHealthLog` so the detail panel
  fetches only the rows for the selected credential lane

### Admin client (`app/admin/connections/connections-health-client.tsx`)
- `ServiceHealthSummary` and `ErrorPatternRow` interfaces updated with `keySource`/`key_source`
- Lane key `"service:keySource"` used as React key and selection state (was just `service`)
- `ServiceCard` displays `(env)` / `(user)` label after service name when keySource is set
- `ServiceDetail` header shows the same credential lane label
- Log fetch URL includes `&keySource=<value>` (empty string for NULL = public APIs)
- Error pattern lookup uses the composite lane key `"service:keySource"`
- Sort is stable: stopped-first → alphabetical by service → alphabetical by keySource

## Files touched
- `src/lib/db.ts` — ALTER TABLE migrations for key_source/user_id; error_message column on trade_proposals
- `src/lib/db-health.ts` — keySource threading throughout
- `src/lib/db-proposals.ts` — updateProposalStatus error_message param; listRecentProposals includes error_message
- `src/lib/data-providers.ts` — 8 constructors + 9 call sites; TwelveData 200-but-error fix
- `src/lib/types.ts` — RecentProposal.errorMessage field
- `src/lib/strategy.ts` — 3 placing_failed sites pass error message
- `app/api/admin/connections-health/route.ts` — keySource param
- `app/admin/connections/connections-health-client.tsx` — lane-aware UI
- `app/dashboard-client.tsx` — error message banner in proposal cards
- `STATUS.md` — updated
- `docs/rollouts/2026-06-25-credential-scoped-health-lanes.md` — this file

## Verification
```bash
npx tsc --noEmit    # clean
npm test            # 1066/1067 (1 pre-existing cache-provenance date flake)
npm run build       # clean
```

## Codex P2 fixes (follow-up commits)

### commit 88c6aa7 — four findings from Codex P2 first pass
1. **Empty keySource → null lane** — route.ts mapped `?keySource=` to `""` which matched `key_source IS ''`
   instead of `IS NULL`. Fixed: `ks === "" ? null : ks`.
2. **NULL dedup in error patterns** — SQLite NULLs don't collide in UNIQUE. Fixed: `api_health_error_patterns.key_source`
   uses `""` sentinel (NOT NULL DEFAULT ''). Schema + logApiHealth updated to use `keySource ?? ""`.
3. **Old UNIQUE constraint not rebuilt** — ALTER TABLE only added column; old `UNIQUE(service, fingerprint)` remained.
   Fixed: table recreation via INSERT-SELECT-DROP-RENAME when `notnull === 0`.
4. **429s not logged before retry** — Added `logApiHealth(ok: false, "HTTP 429 (rate limited, retrying)")` before sleep.

### commit 5aeb840 — COALESCE crash on missing column
When `api_health_error_patterns` exists but has NO `key_source` column (pre-credential DB),
`COALESCE(key_source, '')` raises "no such column". Fixed: `const ksExpr = ksCol ? "COALESCE(key_source, '')" : "''"`.

### commit e6d2429 — AlphaVantage 200-but-error logged as healthy
Alpha Vantage returns HTTP 200 with error payloads (`Note`/`Information`/`Error Message`). Previously
`fetchWithRetry` auto-logged `ok: true` at HTTP 200, then AlphaVantage wrote a second `ok: false` row —
net effect: false-positive success row before the error. Fixed: added `deferSuccessLog?: boolean` option
to `fetchWithRetry`; when set, the success log is deferred to the caller. AlphaVantage passes
`deferSuccessLog: true` and logs success explicitly after body validates (no Note/Information/ErrorMessage
fields present). HTTP errors and network errors still auto-logged in `fetchWithRetry` regardless of flag.

### commit f323f95 — Index migration ordering + TwelveData 200-but-error
Two fixes:
1. `idx_api_health_log_service_key` moved out of the main `database.exec(...)` block (where `CREATE TABLE IF NOT EXISTS` is a no-op on existing DBs so the index ran before ALTER TABLE added `key_source`) and placed unconditionally AFTER the ALTER TABLE migration block. `IF NOT EXISTS` keeps it idempotent.
2. TwelveData returns HTTP 200 with `status: "error"` / `message` for invalid key / quota exhaustion. Applied `deferSuccessLog: true`; added top-level `rawObj.status === "error"` guard that logs failure and continues.

### commit (HEAD) — Trade placement error persistence
Broker and network errors on failed order placement are now persisted and surfaced.
- `trade_proposals` schema: added `error_message TEXT` column (CREATE TABLE + ALTER TABLE migration for existing DBs).
- `db-proposals.ts` `updateProposalStatus`: added `errorMessage?: string` parameter; stored via `COALESCE(?, error_message)` so the first error message is preserved (subsequent status updates without an error don't overwrite).
- `db-proposals.ts` `listRecentProposals`: SELECT and map include `error_message`.
- `types.ts` `RecentProposal`: added `errorMessage?: string` field.
- `strategy.ts`: all three `placing_failed` call sites pass the caught error message (two broker-error catch blocks, one stale-placing reconciliation path with a fixed descriptive note).
- `dashboard-client.tsx`: `DecisionLedgerItem` carries `errorMessage`; proposal cards render an amber "Order error: ..." banner when the field is set.

## Known deferred items
- **Per-user lane isolation**: `key_source` values are `"env" | "user"` (not per-user-ID). Multiple tenants
  sharing `key_source = "user"` are merged into one lane — one user's bad key can mark all user-key calls
  stopped. `user_id` is stored in the log; full per-user lanes would require including user_id in the lane
  key and UI. Deferred — env/user split is the biggest operational win.
- `robinhood-fundamentals` provider still not instrumented (uses internal cache layer, not fetchWithRetry).
