# Ops snapshot performance + account-activity broker handling

## Context & Objective

Production `GET /api/ops/snapshot` took **~84.7s** (2026-10-14 ~2:59pm CT) on a **16.5 GB** SQLite DB with a **415 MB** pending WAL.  Background health checks averaged ~1.4s but peaked at 76–79s.  `GET /api/ops/account-activity` was fast for Alpaca (~0.84s) but returned **400 in ~0.5s** for Tradier Sandbox because the route only supported Alpaca.  This change speeds hot paths where possible, adds **per-section `timingsMs`** and per-user **latest scan** summaries for ops, and returns a structured **422** for unsupported brokers instead of a misleading 400.

## Changes Made

- **`buildOpsSnapshot` is async** with a **45s TTL single-flight cache** (`getOrBuildOpsSnapshot`); `buildMeta.cacheHit` / `cacheTtlSeconds` on the response.
- **`timingsMs`** sections: `total`, `scheduler`, `users`, `dependencies`, `enrichmentCoverage`, `roicArchive`, `storage`, `taskJournal`, `pineconeIngest`.
- Per user: **`marketScan`** via `opsMarketScanRecordSummary` (`generatedAt`, `stale`, source record kind).
- Strategy runs query: drop expensive `LEFT JOIN` + `GROUP BY`; separate proposal-count map.
- Coverage: read last persisted report only (no full `resolveEnrichmentCoverageReport()` on every snapshot).
- Task journal: `getTaskJournalSummary(..., { skipLastStatus: true })` to avoid per-lane N+1.
- Litestream age: depth-capped directory walk + 60s cache.
- **`yieldEventLoop()`** after each user in the users loop.
- Migration **v95**: index `idx_strategy_runs_user_started ON strategy_runs (user_id, started_at DESC)`.
- **Account activity**: unsupported broker → **422** with `supported: false`, `supportedBrokers`, `connectedAccountId`; missing credentials → **422** (was 400).
- **`WH`** added to Alpaca non-trade fallback activity types.

**Files touched**

- `src/lib/ops-snapshot.ts`
- `src/lib/market-scan-freshness.ts`
- `src/lib/db.ts`
- `src/lib/db-task-journal.ts`
- `src/lib/ops-account-activity.ts`
- `src/lib/alpaca-account-insights.ts`
- `app/api/ops/snapshot/route.ts`
- `app/api/ops/account-activity/route.ts`
- `test/ops-snapshot.test.ts`, `test/ops-account-activity.test.ts`, `test/ops-market-scan-summary.test.ts`, `test/ops-snapshot-strategy-runs.test.ts`, `test/event-loop-stall-hot-path.test.ts`, `test/autonomy-halt-cause.test.ts`, `test/persistence-hardening.test.ts`, `test/alpaca-activity-ledger.test.ts`

## Decisions & Trade-offs

- **5s target** on prod-scale DB is aspirational; cache + query fixes help but **16.5 GB + large WAL** may still need further audit/run pagination or DBA-style maintenance.  Cache makes repeated polls cheap within 45s.
- Tradier (and other non-Alpaca) accounts get an explicit unsupported response rather than implementing Tradier ledger parity in this PR.
- Orders attachment on snapshot (`?orders=1`) stays outside the cached build.  Each cache return copies `users` and `accounts` first, so `attachOpsOrderSummaries` cannot write `account.orders` onto the cached object.
- Cold `buildOpsSnapshot` still does several queries per user.  This PR keeps that shape and relies on the 45s single-flight cache plus `yieldEventLoop()`.  A cross-user `GROUP BY` over `audit_events` json extracts on the 16.5 GB database is a follow-up, not this change.
- `opsMarketScanRecordSummary` reads `$.marketScan.omitted` as well as `$.scan.omitted`.  Bounded `strategy_run` rows store `marketScan` at the payload root.

## Verification State

```bash
npm run lint          # 0 errors, 866 warnings (grandfathered)
npx tsc --noEmit      # ok
npm test              # 9303 passed, 51 skipped, 1 failed
npm run build         # ok
```

`npm test` failure: `test/egress-guard.test.ts` "uses real DNS by default" expects `https://discord.com/...` to validate.  This sandbox does not resolve that host as a public webhook target.  The same case was already called out on earlier lanes as sandbox DNS, and it is outside this diff.  Hosted CI has public DNS.

Review follow-up also re-ran the touched files: `test/ops-market-scan-summary.test.ts`, `test/ops-snapshot.test.ts`, `test/alpaca-activity-ledger.test.ts`, `test/persistence-hardening.test.ts` — 50 passed.  Schema expectations moved 94 → 95 with migration v95.  Migration numbers were not renumbered.

**Timings (before / after)**

| Surface | Before (prod, owner) | After (expected) |
|--------|----------------------|------------------|
| `GET /api/ops/snapshot` | ~84.7s wall | Lower on cold build (fewer sync heavy resolves); **≤45s amortized** on cache hit within TTL; use `timingsMs` + `buildMeta.cacheHit` to profile post-deploy |
| `GET /api/ops/account-activity` (Tradier) | 400 ~0.5s | **422** ~0.5s with structured unsupported body (no Alpaca HTTP) |
| `GET /api/ops/account-activity` (Alpaca) | ~0.84s | unchanged |

Re-verify on production after deploy: `bash scripts/fetch-prod-ops-snapshot.sh` and inspect `timingsMs`, `users[].marketScan`.

## Next Steps & Blockers

- 2026-10-15: four `origin/main` merges on this branch (through #4716 iOS CI hygiene / ST-2916 and #4695 Congress push receipt / ST-3846) — all no-conflict; re-run `verify` after push when GitHub Actions queues stall.
- Post-deploy: compare `timingsMs.users` vs other sections on prod; if `users` still dominates, add audit/run indexes or tighter default `auditPerUser` / `runsPerUser` caps for the diagnostic token.
- Optional: WAL checkpoint / maintenance runbook for 400MB+ pending WAL (ops, not app code).
- Linear team ST: track deploy note when merged.

## Zero-Code Findings

- Scheduler was **120s** old at the snapshot moment — separate from snapshot build time but worth correlating with autonomy ticks in the same ops pull.

## Review autofix rounds

- 2026-10-15 (`[codex-autofix]` round 1): fixed the kody-ai thread on `STATUS.md:5-6` — the ops entry had drifted into two near-duplicate `**What.**` paragraphs, one saying "three times" with four parenthetical items and the other saying "again".  Folded into a single paragraph reading "four times", folding `e3ba1507` into the parenthetical, and kept the "ops diff still absent from `main`" note the bot's suggested replacement would have dropped.  Rollout bullet at line 66 updated "third" -> "fourth" to match.  Docs-only; no runtime behavior touched.
