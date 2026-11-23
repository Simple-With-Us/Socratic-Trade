# ST-4641 / ST-4643 / ST-4644 / ST-4640 — Backend performance audit fixes (ZC)

## 1. Context & Objective

Implements the backend findings of `docs/audits/2026-11-21-zc-backend-perf.md` (F1–F7) as four Linear issues.  The audit measured a production SQLite box shared with two other apps where the whole-universe market scan payload (avg 600 KB, p90 2.8 MB) was written to `audit_events` by every interactive scan and every scheduler freshness pass, then re-read and `JSON.parse`d up to four times per request; where the daily-cap read walked an account's entire order history on every dashboard compute and every pre-trade cap check; where the headline first-seen recorder issued one SELECT plus one UPDATE/INSERT per headline per candidate per strategy run; where `api_health_log` had grown to ~1.8M rows with no retention path; and where the mobile snapshot shipped an unbounded fill ledger on every SSE-triggered reload.

Owner authorization for the retention decision: "implement all improvements identified" (2026-11-23), which unblocks ST-4644. That authorization covers `api_health_log` only.  The other insert-only observability tables (`llm_usage`, `rag_usage`, `provider_usage_outbox`, `provider_dispatch_attempts`, `headline_first_seen`) are deliberately left untouched — their retention is a separate owner decision.

## 2. Changes Made

### B1 — ST-4641 (audit F1): bounded `market_scan` audits + a durable `market_scan_latest` tape

- **`src/lib/db-market-scan.ts` (new):** owns the `market_scan_latest` table — one row per `(user_id, scope_key)`, where `scope_key` is the connected account id or the empty string for the user-wide scope.  `upsertLatestMarketScan` REPLACES the row on every scan (so the table is bounded by users x scopes, not by scan count), and `getLatestMarketScanRow` reads it with the account-scoped row preferred and the newest row at any scope as the fallback (mirroring the old `latestAuditByKind(kind, userId, connectedAccountId) ?? latestAuditByKind(kind, userId)` audit lookup, which had no account filter on the fallback).
- **`src/lib/market-scan-latest.ts` (new):** the single shared reader.  `isUsableMarketScan` and `extractScan` moved here from `market-scan-freshness.ts` so every consumer agrees on what counts as a usable tape.  `legacyMarketScanAudit` / `legacyStrategyRunAudit` read the pre-ST-4641 audit payloads that still carry a full tape, and the legacy market-scan row is BACKFILLED into `market_scan_latest` once, so the last-good fallback survives the deploy boundary without every request re-parsing a multi-MB payload.
- **`src/lib/audit-bounded-run.ts`:** unchanged; `summarizeMarketScanForAudit` is now applied to `market_scan` audits as well as `strategy_run` audits.  The `market_scan` audit row drops from a multi-MB tape to a few hundred bytes (`{ omitted: true, source, generatedAt, scannedSymbols, returnedQuotes, candidateCount, topSymbols }`).
- **`app/api/scan/route.ts`:** the interactive scan writes the bounded audit row plus the full tape to `market_scan_latest`.  The scan seed now comes from the tape (`getLatestMarketScanRow` + `marketScanQuotesFromScan`) instead of audit payloads, and the single-flight key still tracks the newest audit row id via the STAMP-only `latestAuditStampByKind` (no payload parse).  The HTTP response is capped to candidates + held symbols.
- **`src/lib/market-scan-freshness.ts`:** the scheduler freshness lane writes the bounded audit row plus the tape.  `newestPersistedMarketScan` reads the durable row first, then falls back to the legacy audit comparison (the newer of the `market_scan` / `strategy_run` kinds wins, exactly as before ST-4641).
- **`src/lib/dashboard.ts`:** the console's standalone (last-good) scan now reads `market_scan_latest` instead of the `market_scan` audit payload.
- **`src/lib/scan-singleflight.ts`:** `marketScanQuotesFromScan(scan, createdAt, now)` extracted from `marketScanQuotesFromAudit` so both the audit path and the tape path share one validation + freshness-window implementation.
- **`src/lib/dashboard-snapshot-projection.ts`:** `capMarketScanQuotesForResponse(scan, extraSymbols)` projects `quotesBySymbol` down to the ranked candidates plus held positions, reusing the existing `projectMarketScanForClient` helper.
- **`src/lib/db.ts`:** `audit()` now returns the new row's id (it was `void`; every existing caller ignores the return value).  New `market_scan_latest` table and its index in `migrate()`.
- **The tape upsert, the bounded audit row and the audit-id link run inside ONE transaction** (`persistLatestMarketScan` owns it in one place, so the interactive scan route and the scheduler freshness lane cannot drift apart).  The atomicity is load-bearing in both directions: `recentFailureForUser` reads the newest `market_scan` audit row to decide that a quote outage has ended, so a successful audit with a failed tape write behind it would suppress the outage de-duplication and log a fresh `market_scan_failed` row on every tick; and a failed audit write must not leave a tape that replaces the PREVIOUS good last-good scan.  One transaction gives both: a failed tape write rolls the audit row back, and a failed audit write rolls the tape write back.

### B2 — ST-4643 (audit F3, F4, F5): three small fixes

- **F5, source-settings TTL cache (`src/lib/source-settings.ts`):** the resolved per-user `source_settings` map is cached for 3 seconds (per user) and invalidated on every write through `setUserSourceSettingsMap` (which `patchUserSourceSettings` also goes through).  This removes a point-SELECT plus a `JSON.parse` of the whole map from every one of the 44 resolver call sites, several of which sit inside provider `enrich()` calls on the scan and quote hot paths.  The cache mirrors `server-knobs.ts`'s `overridesMap` TTL pattern.
- **F3, sargable daily-cap read (`src/lib/db-execution.ts`):** `dailyExecutionStats` no longer wraps both time columns in `datetime(coalesce(placed_at, created_at))`.  The same predicate is now written as two sargable branches — `placed_at >= :dayStart` and `placed_at IS NULL AND created_at >= :dayStart` — with the audit's exact index `idx_trade_proposals_user_account_status_placed (user_id, account_number, status, placed_at)` added in `db.ts`'s `migrate()`.
- **F4, batched headline first-seen (`src/lib/headline-first-seen.ts`, `src/lib/strategy.ts`):** `recordHeadlineFirstSeenBatch` does ONE `SELECT ...  WHERE user_id = ?  AND fingerprint IN (...)` (chunked at 400 to stay inside SQLite's bound-parameter limit) and then ONE `db.transaction(...)` for all the UPDATEs and INSERTs, with the statements prepared once.  The single-headline helper is now a one-item batch, so there is exactly one implementation of the semantics.  The strategy run collects its headlines first and then issues one batch call.  Retention stays per owner policy (kept forever).

### B3 — ST-4644 (audit F2): bounded FIFO retention for `api_health_log`

- **`src/lib/db-health-retention.ts` (new):** `sweepApiHealthLogBatch` deletes ONE bounded batch (2,000 rows) of the oldest rows by `ts`, selecting the rowids through the new `idx_api_health_log_ts (ts ASC)` index.  `sweepApiHealthLogRetention` loops up to 20 batches (40k rows per pass) and YIELDS the event loop between batches.  The window is 30 days by default and configurable through `API_HEALTH_LOG_RETENTION_DAYS` (`0` disables the sweep).  The sweep is cadence-gated to once every 10 minutes.
- **`src/lib/scheduler.ts`:** a new leader-only `api-health-log-retention` journal lane runs the sweep, next to the other bounded sweeps.
- **`src/lib/db.ts`:** the `idx_api_health_log_ts` index.

### B4 — ST-4640 (server half): a MOBILE-scoped fill bound

- **`src/lib/mobile-fills.ts` (new):** `boundMobileFills` keeps the newest 50 fills and reports `fillsTruncated`; `withMobileFillsBound` bounds the performance summary's display fill list on the mobile wire only.
- **`app/api/mobile/snapshot/route.ts`:** the mobile snapshot now ships `fills` (the newest 50, chronological) and `fillsTruncated` (true when the ledger holds more fills than were returned), and its `performance.fills` list is bounded the same way.

### B5 — Audit F6 / F7

- **F6 (`src/lib/data-providers.ts`):** the enrichment cache now has a HARD cap (4,000 entries).  The existing sweep only removed already-expired entries, so a window of live 6h TTLs could grow the Map without bound.  The eviction takes the entries with the EARLIEST `expiresAt` (every entry carries the same 6h TTL and the expiry is refreshed on each write, so the earliest expiry is the least recently refreshed entry).  Map insertion order is NOT LRU here, because re-setting an existing key keeps its original position.  The victim selection is ONE linear pass that keeps only the `excess` earliest-expiry entries, so the insert path does not copy and sort the whole map.  The existing sweep only removed already-expired entries, so a window of live 6h TTLs could grow the Map without bound; the oldest-inserted entries are now evicted from the head of the Map (insertion order is LRU-ready).
- **F7 (`src/lib/db-api-keys.ts`):** `listChatTurns` pushes the `LIMIT` into SQL with the newest-DESC-subquery pattern `listFillEvents` already uses, instead of selecting every turn and slicing in Node.

### Touched files

- `src/lib/db.ts`
- `src/lib/db-market-scan.ts` (new)
- `src/lib/market-scan-latest.ts` (new)
- `src/lib/market-scan-freshness.ts`
- `src/lib/scan-singleflight.ts`
- `src/lib/dashboard.ts`
- `src/lib/dashboard-snapshot-projection.ts`
- `src/lib/source-settings.ts`
- `src/lib/db-execution.ts`
- `src/lib/headline-first-seen.ts`
- `src/lib/strategy.ts`
- `src/lib/db-health-retention.ts` (new)
- `src/lib/scheduler.ts`
- `src/lib/mobile-fills.ts` (new)
- `src/lib/data-providers.ts`
- `src/lib/db-api-keys.ts`
- `app/api/scan/route.ts`
- `app/api/mobile/snapshot/route.ts`
- `test/daily-execution-stats.test.ts` (new)
- `test/source-settings-cache.test.ts` (new)
- `test/api-health-log-retention.test.ts` (new)
- `test/market-scan-latest.test.ts` (new)
- `test/mobile-fills.test.ts` (new)
- `test/headline-first-seen.test.ts`
- `test/market-scan-freshness.test.ts`
- `docs/rollouts/2026-11-23-zc-backend-perf.md`

## 3. Decisions & Trade-offs

- **The `market_scan` audit row now stores a bounded summary, so the tape lives in its own table.**  The alternative (keeping the full tape in the audit and only capping the HTTP response) would have left the multi-MB write and the repeated re-parse in place, which is the bulk of the measured cost.  The audit keeps the forensic shape (counts, source, ranked head); the tape keeps the data.  The table is bounded by users x scopes because every scan REPLACES its row.
- **The legacy audit comparison is preserved.**  `newestPersistedMarketScan` still lets the newer of the `market_scan` / `strategy_run` audit kinds win when no durable row exists yet, so the pre-ST-4641 behavior (and its regression tests) still hold.  Once a user has a `market_scan_latest` row, the durable row wins and no audit payload is parsed at all.
- **F3 is written as a UNION ALL, not a plain `OR`.**  The audit prescribed `(placed_at >= :day) OR (placed_at IS NULL AND created_at >= :day)`, but `EXPLAIN QUERY PLAN` on the real index set shows that SQLite's MULTI-INDEX OR — the plan that turns each OR branch into its own index range seek — is DISABLED when the same query also filters `status IN (...)`.  The plain OR form degrades to a single `SEARCH ... (user_id=?  AND account_number=?  AND status=?)` with NO time bound, i.e. exactly the unbounded walk the audit reported.  The UNION ALL of the two branches (mutually exclusive, so no row is duplicated or dropped) produces two bounded seeks.  The returned numbers are unchanged, and `test/daily-execution-stats.test.ts` asserts both the row set against the pre-rewrite predicate and the query plan.
- **The `api_health_log` health-lane cache is NOT invalidated by the sweep.**  The lane list is a superset of "services with recent rows"; dropping the cache would make a lane vanish from the panel the moment its last old row was deleted.  The cache's own TTL reloads it in the background, which is the safe path.
- **The retention window defaults to 30 days** (the audit's conservative low end) and is configurable through `API_HEALTH_LOG_RETENTION_DAYS`.  The sweep never runs one big DELETE: it deletes in 2,000-row batches and yields the event loop between them, the constraint the ST-4635 incident imposed.
- **The console's fill ledger is untouched.**  The unbounded `listFillEvents` default and the FIFO lot replay it feeds are required for correct realized P&L, open lots, tax and win rate.  The bound is applied only on the mobile wire.
- **The mobile fill contract is `fills` + `fillsTruncated`.**  The parallel iOS lane implements the client side and must work whether or not these fields exist (the mobile lane may merge later), so both are optional on the client.  `fillsTruncated` is exact: the input window is the server's newest-100 display list and the mobile cap is 50, so "the window holds more than 50 entries" is exactly "the ledger holds more than 50 fills".
- **`audit()` now returns the new row id.**  It was `void`; every existing caller ignores the return value, so this is source-compatible.  The `market_scan_latest` row stores that id, which lets the freshness lane's fast gate keep comparing against `latestAuditStampByKind` ids.
- **A Kody/sentry review ran on the first head and found eight issues; all eight are fixed** (commit `3e5ace71`): the tape-before-audit write order, the console's missing legacy fallback, the enrichment cache's non-LRU eviction, the retention watermark written before the sweep, the source-settings cache not pinned on `globalThis`, the cached settings map handed out by reference, a differential test without a control assertion, and a test suite that did not restore the `DATABASE_URL` it mutated.  The findings and the replies are on the PR.
- **A second Kody round ran on `3e5ace71` and found three more issues; all three are fixed** (commit `301e4c5b`): the enrichment cache's full sort on every insert (now one linear pass), the tape upsert preserving the previous scan's `audit_id` (now cleared on the write and set by the link step in the same transaction), and the tape row surviving a failed audit write (now rolled back with it).  The second round's write-ORDER finding was resolved by making the two writes atomic rather than by reordering them, because reordering would have destroyed the previous good tape on the audit-failure path.

## 4. Verification State

- `npm run lint` — passed (0 errors; the grandfathered warning backlog is unchanged).
- `npx tsc --noEmit` — passed (0 type errors).
- `npm test` — passed.  New suites: `test/daily-execution-stats.test.ts` (4), `test/source-settings-cache.test.ts` (3), `test/api-health-log-retention.test.ts` (8), `test/market-scan-latest.test.ts` (9), `test/mobile-fills.test.ts` (4), plus four new cases in `test/headline-first-seen.test.ts`.  `test/market-scan-freshness.test.ts` gained one line (the new `market_scan_latest` table is reset with the audit table between cases).
- `npm run build` — passed.

The F3 value identity is asserted directly: the rewritten predicate and the pre-rewrite predicate are run over the same fixture set and must select the same row ids, and the daily-cap counts/notional are asserted against hand-computed values.

A Kody code review ran on the first head (`fde232ca`) and returned eight findings, all of which are fixed and replied to on the PR with a technical reason; the threads are resolved.  A re-review was requested against the new head (`3e5ace71`).
A second round on `3e5ace71` returned three findings, all fixed and replied to on the PR in `301e4c5b`; a third review was requested against `301e4c5b`.

## 5. Next Steps & Blockers

- **The parent session merges this PR.**  No merge is attempted from this lane.
- **Cross-lane contract (the iOS lane, ST-4640 client side):** the mobile snapshot now carries `fills` (newest 50 fills, chronological) and `fillsTruncated` (boolean).  The client must treat both as optional.
- **Owner decisions still open:** retention for `llm_usage`, `rag_usage`, `provider_usage_outbox`, `provider_dispatch_attempts` and `headline_first_seen` is NOT implemented here — it needs a separate owner decision.  The `API_HEALTH_LOG_RETENTION_DAYS` knob (default 30, `0` disables) is the only retention knob added.
- **Observability to watch after merge:** the `market_scan_latest` table's row size (one full tape per user+scope), the `api-health-log-retention` lane's `deleted=` summary in the scheduler journal, and the freshness lane's `refreshed=` counts (the lane's fast gate now compares the `market_scan_latest` row's audit id).

## 6. Zero-Code Findings

- **The `/api/scan` console claim was verified in code before relying on it.**  `app/console/scan/page.tsx` renders `scan.topCandidates` only; `app/console/ui/symbol-drilldown.tsx` and `app/console/ui/orders/lib.ts` look a symbol up individually (`quotesBySymbol[symbol]`, with a linear fallback).  No console code iterates the whole quote map.  iOS already receives the compacted scan (`compactMobileMarketScan`).  So capping the response to candidates + held loses nothing the console reads.
- **`sqlite_master` shows the `market_scan_latest` table is bounded.**  One row per (user, scope) and every scan replaces its own row, so the table cannot grow with scan count — only the number of users and connected accounts.
- **The `market_scan` audit kind was the ONLY remaining full-tape writer.**  `strategy_run` audits have stored a bounded summary since 2026-08-01 (`audit-bounded-run.ts`), which is why the audit's own 2026-08-01 finding named that kind "known-fixed" and this one "new".
- **The `headline_first_seen` table's PRIMARY KEY is `(user_id, fingerprint)`.**  That is what makes the batched INSERT safe, and it is why a repeated fingerprint inside one batch must take the UPDATE path rather than the INSERT path — the batch implementation handles that explicitly.
