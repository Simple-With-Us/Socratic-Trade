# 2026-06-21 — Deferred-task sweep: P0 safety re-application + IC backtest + buying-power gate

## Summary
Worked through the backlog of deferred items from the financial-expert panel review, in the
isolated `~/apps/trading-claude` worktree on `agent/claude` (see "Why here" below). Three
committed chunks, each tsc-clean and fully tested.

## Why here (worktree coordination)
The prior P0 safety work was done in the **main integration worktree** (`~/Code/Agentic Trading`)
while it was being actively rewritten by concurrent PR merges — it was wiped twice (uncommitted).
Moved to the dedicated, isolated `~/apps/trading-claude` (branch `agent/claude`, insulated from the
Cursor checkout) per the repo's multi-agent rule, and committed each chunk so nothing can be wiped.
Hand off to `main` via a deliberate merge of `agent/claude`.

## What landed (commits on agent/claude)

1. **`bddaa35` — P0 safety slice** (re-applied; was wiped from main):
   - A: `policy.ts` hard-rejects a size-less sell/cover; `strategy.ts applyDeterministicSizing`
     resolves a size-less exit to the FULL position (no silent 0-qty phantom-fill stop).
   - B: `red-team.ts` `available` flag + 45s `AbortSignal` timeout; a required high-conviction
     review that can't run routes the trade to a human (`requiresHumanReview` in `strategy.ts`).
   - C: both autonomous + approval placement paths persist an idempotency-keyed `placing` intent
     row BEFORE the broker call, isolate each placement in try/catch, persist `ref_id`
     (`updateProposalStatus` extended), and a run-start sweep (`flagStalePlacingIntents` +
     `listStalePlacingProposals`) surfaces stale intents for crash recovery.
   - D: account-level drawdown/daily-loss circuit breaker (`src/lib/risk-breaker.ts`, new
     `RiskRules.maxDrawdownPct`/`maxDailyLossNotional`) → forces `close_only` + `kill_switch`
     notification on breach.
   - E: real `/api/health` probe (DB + scheduler heartbeat); `scheduler.ts` persists
     `scheduler:lastTick`.
   - F: SSE stream filters events by resolved subscriber `userId` (tenant isolation).
   - +12 tests (`test/p0-safety-fixes.test.ts`).

2. **`4ea77a8` — IC backtest harness** (the "factor weights are unvalidated / no backtest"
   critical finding): `src/lib/backtest.ts` computes each scan sub-score's information coefficient
   (tie-corrected cross-sectional Spearman vs forward N-business-day return) over persisted
   `signal_snapshot` audits, and derives a suggested `ScoringWeights` (advisory only). Exposed
   read-only via dev-gated `GET /api/admin/backtest-ic`. +10 tests. Never fabricates a price.

3. **`71698a5` — buying-power affordability gate**: blocks an opening buy/short whose notional
   exceeds available buying power (broker-accurate for live/paper, cash for Test; unknown/<=0 never
   blocks). Closing orders never gated. +4 tests.

## Verification
- `npx tsc --noEmit` clean after each chunk.
- `npm test` — **441 tests** green (P0 +12, backtest +10, buying-power +4 on top of the prior 415).

## Also this session (in the main worktree, already committed there)
- Market Scan default columns reduced 18 → 8 (2-agent review), Score moved to far-right, storage
  key bumped to take effect; "Load failed" banner softened (WebKit fetch-reject message + subtle
  note when data is present).

## Follow-ups (remaining deferred items, NOT yet done — staged)
- **Cost model** in P&L + sizing (spread/impact at fill) — biggest "does the edge survive costs"
  lever; high P&L-fixture churn, needs a default-off rollout.
- **PDT/Reg-T gate** using the new `AccountCapabilities` (marginEnabled, daytrade_count plumbing).
- **Atomic placement completion**: `clientOrderId` onto `EquityOrder` (alpaca/robinhood) →
  broker-truth-first auto-reconcile of stale `placing` intents (today they're surfaced, not
  auto-matched).
- **Native Alpaca brackets** for live entries; **Robinhood pending-fill reconciler** on the
  scheduler tick; **run-lock the approval path** (cap double-spend TOCTOU).
- **Factor orthogonalization** (collapse collinear momentum/technical/52w); **real macro feed** vs
  static fallback; **sample-aware learning** gates.
- **Robinhood fundamentals**: enable behind the existing `ROBINHOOD_ENRICHMENT_ENABLED` gate after
  validating field units via `/api/admin/robinhood-probe` (needs a live connection).
- **Versioned migration ledger**; **db.ts split**; **Litestream operationalization**.
- **Pin the Score column** (sticky) for robustness if many columns are toggled on.
- **P3**: deterministic not-advice stamping, real SEC EDGAR UA default, `deterministicTemperature`
  rename, prompt-caching implement-or-delete.

## Handoff
Merge `agent/claude` → `main` deliberately (do not let an automated reset wipe it). Then run the
full `tsc` + `npm test` + `npm run build` trio in the integration worktree before any deploy.
