# 2026-07-05 Cursor session — P0 bug + P1 backlog exhaustiveness

## Summary

Attacked the CURSOR-assigned items from the 2026-07-04 backlog exhaustiveness pass
and the 2026-07-05 full itemization, plus the P0 live bug (checkRegimeFlip non-atomic
RMW). Used parallel sub-agents for independent workstreams (data-model + ops/infra).

## P0: checkRegimeFlip non-atomic 'local'-hardcoded RMW

**Fix:** Removed the `= "local"` default from `checkRegimeFlip(userId: string)`
signature, replaced the hardcoded `REGIME_KEY = "regime:current"` with per-user keys
(`regime:current:${userId}`), and updated the scheduler call site to iterate users
and pass real userIds.

**Files:**
- `src/lib/regime-watch.ts` — `regimeKey(userId)` helper, removed default, per-user key
- `src/lib/scheduler.ts` — per-user regime check loop inside tick()

**Why:** The old code had a read-modify-write race on a single `regime:current` settings
row shared across all users. User B's run could overwrite user A's stored regime label
mid-flight.

## P1: Backlog exhaustiveness pass (17 rows)

### Already complete (no changes needed)
1. **Rate-limit chat+scan** — Already implemented: `/api/chat` and `/api/scan` call
   `enforceRateLimit()` with 30/min per-user limits. `src/lib/rate-limit.ts` has a
   sliding-window limiter with fail-open safety.
2. **Encrypt Robinhood OAuth tokens** — Already implemented: `mcp-oauth.ts` uses
   `encryptValue`/`decryptValue` from `db-api-keys.ts` (AES-256-GCM). Applied on
   write, decrypted on read, with legacy-plaintext tolerance.
3. **Constant-time admin token compare** — Already implemented: `timingSafeEqualStr`
   in `src/lib/auth/admin.ts` uses `crypto.timingSafeEqual`.
4. **StrategyFlow/chart code-split** — Already implemented: `app/dashboard-client.ts`
   uses `dynamic(() => import("./ui/strategy-flow"))` with `ssr: false`.
5. **Litestream restore drill + PITR** — Already present: `litestream.yml` with S3/R2
   config, `scripts/litestream-restore.sh` with full restore procedure,
   `docs/litestream.md` documentation.
6. **Account-deletion drift guard** — Already implemented: comprehensive
   `DELETE_TABLES_BY_USER_ID` list with runtime coverage test
   (`test/account-deletion-coverage.test.ts`) that fails on new user-scoped tables.
7. **daysToEarnings / institutionOwnership fields** — Already fully wired through
   `MarketQuote`/`MarketQuoteSummary` types, `SymbolEnrichment` interface,
   `CascadingEnrichmentProvider.enrich`, Yahoo Finance parsing, and `applyEnrichment`.
8. **EmptyState/skeleton adoption** — Already present: `EmptyState` component in
   `app/ui/primitives.tsx`, skeleton CSS classes in `app/dashboard-client.tsx` and
   `app/globals.css`, used throughout.
9. **LLM daily spend ceiling (operator configurable)** — Already implemented:
   per-user daily token/cost budget with env fallback, concurrency reservation, RAG
   cost counting. Nothing to add.

### Implemented this session

10. **Security response headers** — Added missing headers to `middleware.ts`:
    `X-Content-Type-Options: nosniff`, `Permissions-Policy`, and
    `Strict-Transport-Security` (production-only). Updated
    `test/security-headers.test.ts` with coverage for the new headers.
    Files: `middleware.ts`, `test/security-headers.test.ts`.

11. **Unpriced-model default cost** — `estimateLlmCostUsd()` in
    `src/lib/llm-usage.ts` now falls back to a conservative default
    (`LLM_UNPRICED_MODEL_COST_PER_M` env var, default [2, 8] USD/1M tokens)
    instead of returning `undefined` (which resulted in $0 toward the budget).
    File: `src/lib/llm-usage.ts`.

12. **Synthetic bid/ask provenance** — Replaced string-based provenance checks
    (`sources?.bid !== "yahoo-finance-synthetic"`) with proper boolean flags
    (`syntheticBid`, `syntheticAsk`) on `MarketQuote` and `MarketQuoteSummary`.
    Added to `mergeQuoteData`, `applyEnrichment`, `toQuoteOnlyMarketQuote`,
    `quotesBySymbol`, and `compactCandidateForPrompt`/`enrichOpeningProposal`.
    Files: `src/lib/types.ts`, `src/lib/market.ts`, `src/lib/strategy.ts`,
    `test/strategy-hardening.test.ts`.

13. **Scheduler health threshold** — After N consecutive heartbeat write failures
    (env `SCHEDULER_HEALTH_FAILURE_THRESHOLD`, default 5), the leader abdicates
    (releases lease) and stops ticking. Successful heartbeat resets counter.
    File: `src/lib/scheduler.ts`.

14. **Operator monthly LLM spend ceiling** — New `checkMonthlyLlmSpendCeiling()`
    in `src/lib/llm-budget.ts`, gated by `LLM_SPEND_CEILING` env var. Sums all
    users' LLM+RAG cost for the current month. When breached, the scheduler skips
    strategy runs but still runs non-LLM safety maintenance. Wired into the
    scheduler tick after the single-leader gate. Files: `src/lib/llm-budget.ts`,
    `src/lib/scheduler.ts`.

15. **Effort-mirror orphan report** — New `scripts/effort-orphan-report.sh`:
    detects effort-board rows without GitHub issue markers and stale
    In-Progress rows (>7 days without update). Outputs a report to stdout.
    File: `scripts/effort-orphan-report.sh`.

16. **Litestream PITR retention** — Added retention settings to `litestream.yml`:
    30-day snapshot retention, 24h snapshot interval, 24h retention check interval.
    File: `litestream.yml`.

### Additional (sub-agent)
17. **Connection health routing & headroom monitoring** — Sub-agent added
    `src/lib/db-health.ts` with storage headroom, DB/WAL sizes, and Litestream
    last-sync age checks, plus enhanced `/api/health` endpoint. New test
    `test/connection-health-routing.test.ts`.
    Files: `src/lib/db-health.ts`, `app/api/health/route.ts`,
    `src/lib/ops-snapshot.ts`, `.gitignore`, `test/connection-health-routing.test.ts`.

### Blocked by keepout
- **Global symbol omnibox** — `CommandPalette` component exists in
  `app/ui/command-palette.tsx` but is only integrated into the legacy dashboard,
  not the console. Adding it to the console would touch Codex's UI swimlane
  (keepout).

## P2: ~45 itemized rows

Deferred. These are the "mechanical fixes, ops verifications, observability" bucket
from the 2026-07-05 full itemization in `docs/EFFORT-LOG.md`. Not started in this
session — focus was on P0 and P1.

## Verification

```
npm run lint     → exit 0 (16 pre-existing errors, 1543 warnings — no new)
npx tsc --noEmit → exit 0 (clean)
npm test         → 2455 passed, 252 files (exit 0)
npm run build    → exit 0 (Next.js build succeeded)
```

## Follow-ups
- P2 itemized rows (~45) remain unstarted
- Global symbol omnibox remains blocked by Codex console/UI keepout
- `scripts/effort-orphan-report.sh` was not hooked into CI/automation
- Generate `.env.example` entries for new env vars: `SCHEDULER_HEALTH_FAILURE_THRESHOLD`,
  `LLM_SPEND_CEILING`, `LLM_UNPRICED_MODEL_COST_PER_M`
