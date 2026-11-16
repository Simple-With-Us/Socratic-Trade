# CURSOR full itemization — individual-row materialization + P0/P1 sweeps

**Date:** 2026-07-06 · **Agent:** CURSOR (DeepSeek v4 Pro) · **Branch:** `cursor/full-itemization-pass`

## Summary
Two-phase task: (1) extract all CURSOR-assignable findings from the six review docs and write
individual rows to the effort log — previously only existed as a ~45-row lane-count claim in the
board summary, never materialized as discrete items. (2) Verify which items were already done
(vs. the ~45 "claimed" count) and implement the highest-impact remaining gaps.

## What changed

### Phase 1: Extraction + enumeration

Read six source docs (expert design review 147 findings, composite review, Socratic review,
improvement audit, learning-loop/RAG expansion backlogs) and wrote **27 individual CURSOR rows** to
both:
- `docs/EFFORT-LOG.md` ("2026-07-05 full itemization > CURSOR individual rows" subsection)
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (summary with per-priority size tags)

Items classified: P0 Security 5, P1 Mechanical 9, P2 Ops 9, P3 Observability 4. Each row has
priority/size/source-doc references. Respects all keepouts (no CLAUDE RAG/memory, no MONET risk,
no CODEX console/UI, no AG data providers).

### Phase 2: Verification + implementation

**Already done before this session (verified):**
- P0-1: Rate-limit /api/chat and /api/scan — `RATE_LIMITS.chat`/`scan` entries exist, both routes call `enforceRateLimit`
- P0-2: Encrypt Robinhood OAuth tokens at rest — `encryptStoredTokens`/`decryptStoredTokens` in `mcp-oauth.ts` already route through `encryptValue`/`decryptValue`
- P0-3: Constant-time admin-token compare — `timingSafeEqualStr` in `auth/admin.ts`, both reindex routes use `requireAdmin({ requireTokenInProd: true })`
- P1-3: Cap buildUnifiedFeed output — `UNIFIED_FEED_MAX_GROUPS = 60`, cap logic in buildUnifiedFeed
- P1-4: better-sqlite3 cache_size/mmap_size pragmas — `db.ts:34-35`
- P1-7: Durable due-jobs substrate — `due_jobs` table + full CRUD in `db-jobs.ts`
- P2-4: Account-deletion table sync test — `test/account-deletion-coverage.test.ts` exists, list includes `due_jobs`
- P2-5: Disk/WAL growth monitoring — `/api/health` has full storage monitoring (disk free, WAL size, Litestream freshness, degradation alerts)
- P2-9: Playwright CI `.next/cache` restore — `actions/cache@v4` step in `.github/workflows/e2e.yml`

**Implemented in this session:**
- P1-5: Socratic case-write failure → audit receipt — `strategy.ts` `recordSocraticDecision` catch block now calls `audit("socratic_case_write_failed", …)` in addition to `console.warn`
- P1-6: Crashed-run status sweep — new `markStaleRunningRuns()` in `db-execution.ts`, called at top of each scheduler tick in `scheduler.ts`, marks runs stale >10min as failed with audit receipt

**Documented (no code change needed):**
- P2-3: Litestream restore verification — `docs/litestream.md` already has a detailed runbook; restore still unexercised, remains an operator step

## Files touched
- `docs/EFFORT-LOG.md` — added "CURSOR individual rows" subsection (27 rows)
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — mirrored summary
- `src/lib/db-execution.ts` — added `markStaleRunningRuns()`
- `src/lib/scheduler.ts` — import + call `markStaleRunningRuns()` at top of tick
- `src/lib/strategy.ts` — `recordSocraticDecision` catch: added `audit("socratic_case_write_failed")`
- `docs/rollouts/2026-07-06-cursor-full-itemization.md` — this note

## Verification
```bash
npm run lint    # 0 errors, 357 warnings (all pre-existing)
npx tsc --noEmit # clean
npm test         # 283 files, 2843 tests all pass
npm run build    # clean
```

## 2026-07-08 review follow-up (PR #1003)
Addressed the three Copilot review threads so the PR can merge:
- `db-execution.ts` `markStaleRunningRuns`: the sweep now only receipts/counts rows the guarded
  UPDATE actually transitioned (`res.changes > 0`) — a concurrent scheduler instance repairing the
  row first no longer produces a duplicate `strategy_run_crashed` audit or inflates `count`. The
  receipt is also account-scoped now (passes the run's `connected_account_id` to `audit`).
- Added `test/stale-running-runs.test.ts`: focused coverage that a stale run is marked failed with
  exactly one account-scoped receipt, a fresh run is untouched, and re-running the sweep is
  idempotent (no double-receipt).
- `STATUS.md`: corrected the entry's branch label from `main` to `cursor/full-itemization-pass`.
- Touched files: `src/lib/db-execution.ts`, `test/stale-running-runs.test.ts`, `STATUS.md`, this note.

## Follow-ups (16 unstarted remaining items)
- P0-4: Tamper-evident audit chain (M)
- P0-5: Key-handling residuals — flip decryptValue to reject plaintext (S)
- P1-1: Collapse redundant listFillEvents fetch (M)
- P1-2: Batch proposal point-queries (M)
- P1-8: Agent-not-running receipts (M)
- P1-9: Money-path concurrency/property/fault-injection tests (M)
- P2-1: Verify drawdown kill-switch wiring (S)
- P2-2: Verify correlation cluster gate (S)
- P2-6: Automated self-reporting restore drill (M)
- P2-7: Mac sleep keep-awake posture + protection-gap receipts (S)
- P2-8: Account deletion Pinecone propagation (S — borderline CLAUDE)
- P3-1: Langfuse prompt-version + Bear-veto stamps (M)
- P3-2: Audit trail queryable by decision fields (M)
- P3-3: Run-level trace tree + online eval-in-prod (L)
- P3-4: Periodic broker-truth reconciliation receipt (M)
