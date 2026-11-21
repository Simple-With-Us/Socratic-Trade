# Backend performance audit — 2026-11-21 (ZC)

Tree: `/mnt/fleet-extra/apps/lanes/Socratic-Trade/zc-ios-ux-perf-audit` @ `006f9f00` (read-only lane).  Report-only: no code changed, no builds or tests run, no external APIs called.  Evidence is file:line in this tree; query plans verified on scratch SQLite replicas of the prod schema (`EXPLAIN QUERY PLAN`, 1.4M-row synthetic table for the audit-chain check).

Scope: SQLite hygiene (`src/lib/db.ts`, `db-*.ts`), hot request paths (`app/api/**`, `src/lib/dashboard.ts`), the scan/enrichment cascade (`src/lib/market.ts`, `src/lib/data-providers.ts`, `quotes-cascade.ts`), schedulers/loops (`scheduler.ts`, `strategy.ts`, `db-health.ts`, `db-notifications.ts`), memory, middleware.  Prior baseline read first: `docs/reviews/2026-08-31-grok-full-stack-audit.md` (backend sections).  Production context: single 8 vCPU box shared with Congress.Trade OCR workers and Usage-Monitor; SQLite (better-sqlite3, synchronous) on the persistent volume with Litestream to R2.

## Prioritized findings

| # | Finding | Impact | Effort | Evidence (file:line) | Status | Concrete fix |
|---|---|---|---|---|---|---|
| F1 | Full-universe `MarketScan` payload (the "5k-row `quotesBySymbol` map") is written to `audit_events` by every interactive scan AND the scheduler freshness pass, then re-read and `JSON.parse`d up to 4× per scan request; same payload class measured avg 600 KB / p90 2.8 MB in prod (audit-bounded-run's own 2026-08-01 finding, for `strategy_run`) | H | M | `app/api/scan/route.ts:60,121-130`; `src/lib/market-scan-freshness.ts:458`; `src/lib/market.ts:862`; `src/lib/db-learning.ts:76-96`; `src/lib/audit-bounded-run.ts:1-9`; `src/lib/mobile-scan.ts:5` | new (strategy_run half known-fixed 2026-08-01) | Apply `summarizeMarketScanForAudit` to `market_scan` audits too; move the full-tape consumers (`newestPersistedMarketScan` last-good, `marketScanQuotesFromAudit` seed) to a single-row-per-account `market_scan_latest` upsert table in the same SQLite DB; cap the `/api/scan` HTTP response to candidates+held (mirror `compactMobileMarketScan`) |
| F2 | Insert-only observability tables grow forever under the 2026-10-15 keep-everything policy; `api_health_log` already ~1.8M rows (2026-11-16) and its one un-indexed query shape froze the event loop 15.9-18.8s and got the container watchdog-restarted (ST-4635); `llm_usage`, `rag_usage`, `provider_usage_outbox`, `provider_dispatch_attempts`, `headline_first_seen` have no retention path at all | H | S (once approved) | `src/lib/db-health.ts:739-748` (the 1.8M-row + 15.9-18.8s comment); `src/lib/audit-prune.ts:1-8` (owner policy removed all age deletes); `grep -r "DELETE FROM llm_usage\|DELETE FROM rag_usage\|DELETE FROM provider_usage_outbox"` → none | known-open (systemic; ST-4635 fixed one query shape, growth driver untouched) | **Needs owner decision** (conflicts with the 2026-10-15 keep-forever policy): FIFO retention for `api_health_log` only (30-90d) is technically safe now — durable hard-streak state was deliberately moved out of the table and the code comments already anticipate "api_health_log FIFO".  Growth compounds disk, index-maintenance cost, and Litestream R2 volume on a box shared with two other apps |
| F3 | `dailyExecutionStats` wraps both time columns in `datetime(coalesce(placed_at, created_at))`, defeating every time index; the account's ENTIRE proposal history is walked (index scan + per-row table fetch for `placed_at`) on every dashboard compute (10s TTL) and every pre-trade daily-cap check | M | S | `src/lib/db-execution.ts:53-68`; called from `src/lib/dashboard.ts:1085-1087`; EXPLAIN on a scratch replica with the prod indexes confirms `SEARCH ...idx_trade_proposals_user_account_status_created` with no time bound | new | Rewrite as two sargable branches `(placed_at >= :day) OR (placed_at IS NULL AND created_at >= :day)` + add the index below; or keep a per-day counters row |
| F4 | Headline-first-seen N+1: one SELECT + one UPDATE/INSERT per headline per candidate per strategy run (candidates × ~3-6 headlines = ~150-600 autocommit statement pairs), statements recompiled per call | M | S | `src/lib/strategy.ts:1867-1876`; `src/lib/headline-first-seen.ts:28-56` | new | Batch: one `SELECT ...  WHERE user_id = ?  AND fingerprint IN (...)`, then one `db.transaction(...)` for the UPDATEs+INSERTs with statements prepared once.  Retention stays per owner policy (kept forever — documented at `headline-first-seen.ts:58`) |
| F5 | Per-flag source settings are uncached point-SELECTs: every `resolveSourceBool/Number/String` does a fresh `getUserSetting` SELECT + `JSON.parse` of the whole `source_settings` map; `getEnrichmentProvider` is reconstructed per scan and per `/api/quote` request (~15-20 providers), several consulting knobs in constructor/enrich; 44 call sites total.  The sibling server-knob reader IS TTL-cached — the user map is not | M | S | `src/lib/source-settings.ts:24-37`; `src/lib/data-providers.ts:1234-1353`; cached contrast: `src/lib/server-knobs.ts` (`overridesMap` TTL) | new | TTL-cache (2-5s) the per-user resolved map exactly like `serverKnobOverride`, invalidated on `setUserSourceSettingsMap` |
| F6 | Enrichment in-memory `cache` Map has no hard cap: the >2000 sweep deletes only already-expired entries, so a window of live 6h TTLs grows unbounded (multi-scope keys per user).  Realistic size today is modest (scan pool ~100-500 symbols × a few prefixes) | L | S | `src/lib/data-providers.ts:530-540` | new | In the existing `cache.set` override, also drop oldest-inserted entries above a hard cap (Map insertion order is LRU-ready) |
| F7 | `listChatTurns` SELECTs every turn of the user then slices in Node (per-row `JSON.parse` of citations).  Bounded in practice by the write-side FIFO cap of 100 (`trimChatTurns`), so cosmetic today | L | S | `src/lib/db-api-keys.ts:2003-2016`; cap at `src/lib/chat-history.ts:68` (`MAX_TURNS = 100`) | new | Push `LIMIT` into SQL with the newest-DESC-subquery pattern `listFillEvents` already uses (`src/lib/db-fills.ts:436-468`) |
| F8 | `audit()` chain-tip lookup (`ORDER BY rowid DESC LIMIT 1` over the user's rows) is planner-dependent: dominant writer → backward table scan (0.02 ms measured on a 1.4M-row replica); sparse user → index + TEMP B-TREE over that user's total rows.  Any formerly-active-now-quiet user pays O(their lifetime rows) per audit write, and rows are kept forever | L today / M over years | S-M | `src/lib/db.ts:3940-3946`; measured plans on scratch replica (both shapes reproduced) | new | When next touched: carry the per-user tip hash in a tiny `chain_tip(user_id PRIMARY KEY, chain_hash)` table updated inside the same INSERT transaction; point-lookup read replaces the scan |

## Verified known-fixed (do not re-file)

Checked in this tree, fixed since the 2026-08-31 Grok audit or earlier:

- **Oldest-500 fills bug (`79daff38`)** — fixed by PR #2955: `listFillEvents` bounded mode returns the NEWEST N in chronological order (`src/lib/db-fills.ts:419-468`).
- **Unbounded whole-ledger fills load per 15s poll** — now deliberate and documented: fetched once per snapshot and threaded into every consumer with a single FIFO P&L walk (`src/lib/dashboard.ts:1089-1104`); the unbounded default is required by FIFO lot replay and indexed.
- **Sequential ~24-46s dashboard broker chain** — now one `Promise.all` over independent groups with a 20s overall budget, 10s TTL snapshot cache, and 8s coalescing single-flight (`src/lib/dashboard.ts:693-760`, `dashboard-snapshot-cache.ts:13`, `dashboard-coalesce.ts:19`).
- **Interactive scan cascade cost** — 35s budget + single-flight + `enrichmentMode: "skip"` + durable field-store seeds + last-good stale fallback (`app/api/scan/route.ts:26,164-181`); screener cached ~5 min with background refresh (`market.ts:1577-1634`).
- **Quote route cascade stall** — budget/abort + Yahoo floor + overlay grace + single-flight + rate limit (`app/api/quote/route.ts:70-215`).
- **`/api/live`** — process-only, no DB/disk/network (the 2026-08-17 Traefik-unhealthy class).
- **`/api/health`** — 2s memory snapshot TTL, section TTLs, single-flight, per-request budget (`app/api/health/route.ts:116,399,793-798`).
- **Scheduler overlap/wedges** — leader lease, tick generation counters, 15s watchdog with lease renewal, phase-boundary yields; ST-4635 moved health/receipt queries off the event loop (`src/lib/scheduler.ts:83,573-677,925-960`).
- **SQLite pragmas** — WAL, `busy_timeout` 60s, `synchronous = NORMAL`, `cache_size = -20000`, `mmap_size = 256 MB` (`src/lib/db.ts:98-114`).
- **Rate limiter** — bounded buckets (10k cap) with expiry sweep, fail-open (`src/lib/rate-limit.ts:40-56`).
- **Notification tables** — bounded sweeps (`SWEEP_BATCH_LIMIT = 200`, age-cutoff) and indexed reads (`src/lib/db-notifications.ts:32,362-409`).
- **Red-team LLM fan-out** — bounded pool of 3 (`src/lib/strategy.ts:2815-2823`); LLM runtime keys correctly not env-seeded.

## Quick wins (≤1 day, no owner decision needed)

1. **F5** — TTL-cache the resolved `source_settings` map (clone the `server-knobs` pattern).  Removes tens of point-SELECT+JSON.parse calls from every scan/quote request.  Effort S.
2. **F3** — Sargable rewrite of the `dailyExecutionStats` predicate + the one new index below.  Turns an account-lifetime walk into a same-day index range.  Effort S.
3. **F4** — Batch `getOrRecordHeadlineFirstSeen` into one SELECT + one transaction per run.  Effort S.
4. **F1 (partial, response side only)** — Cap `quotesBySymbol` in the `/api/scan` HTTP response to candidates+held (the console table and drilldown only look up candidate symbols; iOS already receives the compacted form).  Cuts multi-MB JSON responses to the browser without touching persistence.  Effort S.  The audit-payload half of F1 (bounded summary + `market_scan_latest` table) is the M-effort remainder.
5. **F6 / F7** — Hard cap on the enrichment Map; `LIMIT` inside `listChatTurns` SQL.  Effort S each.

## Index candidates

Only one new index is warranted today; everything else hot is already covered by the extensive `idx_*` set in `db.ts` (`fill_events`, `trade_proposals`, `portfolio_snapshots`, `audit_events`, `api_health_log`, `llm_usage`, `notification_events` all have matching composite indexes).

```sql
-- Serves: dailyExecutionStats (src/lib/db-execution.ts:53) after the sargable rewrite
-- Query: SELECT ... FROM trade_proposals
--        WHERE user_id = ? AND account_number = ? AND status IN ('placed','filled','paper','placing')
--          AND (placed_at >= :dayStart OR (placed_at IS NULL AND created_at >= :dayStart))
CREATE INDEX IF NOT EXISTS idx_trade_proposals_user_account_status_placed
  ON trade_proposals (user_id, account_number, status, placed_at);
```

Notes on non-candidates checked with EXPLAIN on scratch replicas:

- `audit()` chain tip (`db.ts:3940`) cannot be served by an index as written (`ORDER BY rowid`); the fix is the `chain_tip` table in F8, not an index.
- `api_health_log` lane queries are served by `idx_api_health_log_service_ts` and `idx_api_health_log_service_key` (added in the ST-4635 round); the exposure there is retention (F2), not a missing index.
- `latestAuditByKind` is served by `idx_audit_events_kind_user_created`; its cost is payload size (F1), not plan shape.

## Environment / non-findings

- Middleware (`middleware.ts`) runs on everything except Next static assets; per-request cost is one HMAC session-JWT verify (`jose`) plus header stamping — no JWKS network fetch on the hot path (CF Access assertion verification only when that header is present).  No finding.
- The mobile gateway (`app/api/mobile/*`) rides the coalesced dashboard snapshot and compacts the scan for iOS; SSE events route is in-process pub/sub with 25s heartbeats.  No finding.
- `MOCK_METRICS` / `mockEnrichmentProvider` still exist in `src/lib/data-providers.ts:545,1521` but are no longer registered in `getEnrichmentProvider` — dead code worth deleting on the next pass over that file (hygiene, not perf).
- Statement-per-call `getDb().prepare(...)` is the house style everywhere; better-sqlite3 has no statement cache, so hot loops pay recompile cost.  Only flagged where it multiplies (F4); a repo-wide prepared-statement helper would be a larger refactor with modest payoff at current traffic.
