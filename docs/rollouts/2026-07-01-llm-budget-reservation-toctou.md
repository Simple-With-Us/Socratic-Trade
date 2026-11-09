# 2026-07-01 — Per-user LLM budget reservation (TOCTOU admission control)

Branch `claude/audit-work-split-f-g-o67jj2` (PR #293). Closes the deferred follow-up from
`2026-07-01-fg-codex-review-fixes.md` item 13 ("budget reservation across concurrent same-user runs").

## Summary

Added a per-USER LLM budget **reservation** so the daily token/cost ceiling is hard under concurrent
multi-account scheduling — not just a read-of-the-ledger check that two in-flight runs can both pass.

New primitives in `src/lib/llm-budget.ts`:

- `reserveLlmBudget(userId, estTokens, estCostUsd, now?, connectedAccountId?)` — CAS-atomic reserve of a
  worst-case estimate against today's ledger + other live reservations. `{ok:false, reason}` when a
  finite limit would be met/exceeded; `{ok:true}` with **no** `reservationId` when no ceiling is
  configured (default-OFF preserved); fail-closed to `{ok:false}` on DB error.
- `reserveLlmRunBudget(userId, connectedAccountId?, now?)` — convenience wrapper using the env-tunable
  per-run estimate (`LLM_RUN_RESERVATION_TOKENS` default 80_000 / `LLM_RUN_RESERVATION_COST_USD` default 1).
- `releaseLlmReservation(userId, reservationId, now?)` — removes the hold (deletes the row when empty);
  runs in a `finally`, never throws.
- `reservedLlmSpend(userId, now?)` — sum of live (non-expired) reservations, for tests/diagnostics.

Storage: the existing `settings` KV table, key `llm_budget_reservation:${userId}`, value
`{reservations: [{id, tokens, costUsd, reservedAt, expiresAt}]}`. **No migration** — CAS'd inside
`db.transaction(...).immediate()` exactly like `acquireStrategyLock`. TTL 5 min (pinned to the strategy
lock's staleMs, so a live run's reservation can't expire mid-run); expired holds are dropped on every
read (crash-safe — a run that dies without releasing frees its hold after the TTL).

Wired into `src/lib/strategy.ts` `runStrategyOnce`: at the budget gate (right after `checkLlmDailyBudget`,
still AFTER the non-LLM risk breakers), a reserve is taken; on `!ok` the run sets `skipLlmDueToBudget`
(audited as `strategy_run_suppressed_budget_reservation`) and completes normally without LLM spend. The
`reservationId` is released in the run's `finally`, before `releaseStrategyLock`, so a queued same-user
run reclaims the headroom immediately.

## Why

Per-user is the correct key because the ledger ceiling is per-user (usage summed across all the user's
accounts). A same-user, multi-account scheduler fan-out (concurrency cap 3) could previously launch runs
that each read "under budget" before any recorded spend, overshooting by up to the in-flight runs'
worst-case spend. The reservation serializes admission: the first run's hold is visible to the others'
reserve, so they skip LLM rather than double-commit. Reserve failure degrades to "skip LLM" (like the
existing over-budget and score-threshold skips), never a failed run — a cost cap must not manufacture
run failures.

## Files

- `src/lib/llm-budget.ts` — new reservation primitives + `resolveLlmLimits`/`sumLedgerUsage`/
  `runReservationEstimate` helpers (shared ledger-sum + limit-resolve logic with `checkLlmDailyBudget`);
  new imports `randomUUID`, `getDb`.
- `src/lib/strategy.ts` — reserve at the budget gate, `let llmReservationId` holder, release in `finally`;
  updated the stale "known limitation / deferred" comment to describe the two-part admission control.
- `test/llm-budget-enforcement.test.ts` — 7 new reservation tests (default-OFF no-id, concurrent-refuse,
  release-frees-headroom, ledger+estimate trip, cost-dimension, TTL reclaim, unknown-id no-op,
  env-tunable run estimate) + `afterEach` now clears the two `LLM_RUN_RESERVATION_*` env vars.

## Verification (all run in `~/apps/trading-conflict-fix`)

- `npx vitest run test/llm-budget-enforcement.test.ts` — 18 passed (11 existing + 7 new).
- `npx vitest run test/strategy-money-path-f-g.test.ts test/run-budget-and-live-guard.test.ts test/token-budget-ceiling.test.ts` — 13 passed.
- `npm test` — 2064 passed / 209 files (one run flaked on the known `approval-lock` broker-path timing
  test — passes 4/4 in isolation and green on the immediate re-run; unrelated to this change, which is a
  no-op on the lock path when no reservation id is set).
- `npm run build` — success.
- `npx tsc --noEmit` — exit 0 (after the build regenerated `.next/types`; the pre-build stale
  `how-it-works/page.js` type errors are the known `.next/types` staleness, not source errors).
- `npm run lint` — 0 errors (279 grandfathered warnings, none in touched files).

## Codex review round (7 P2s, all fixed in one batch)

After #316 was opened, Codex posted 7 substantive P2s. All addressed:

1. **Reject-below-estimate regression (llm-budget.ts).** The admission check summed the run's OWN estimate
   (`ledger + reserved + est >= limit`), so any budget below the 80k-token / $1 estimate refused even the
   FIRST run at zero usage — a modest UI budget would skip LLM all day. Fixed: the first run is admitted
   whenever the committed ledger is under the limit (its own estimate never refuses it; per-spend
   `assertWithinLlmBudget` still caps real spend); the estimate-inclusive check now applies ONLY when a
   CONCURRENT reservation exists (that's the real serialization). Added a regression test.
2. **TTL could expire mid-run (llm-budget.ts).** The fixed 5-min TTL matched the strategy lock but a long
   run (Bull+Bear+per-proposal Red Team+RAG) can exceed it, freeing the hold mid-run. Bumped to a
   configurable `LLM_RESERVATION_TTL_MS`, default 15min (backstop for a crashed run only; the normal path
   releases explicitly).
3. **RAG not gated on reservation-deny (strategy.ts).** A reservation-denied run still ran the RAG block
   (`retrieveContextDetailed` checks only the committed ledger), spending Voyage/Pinecone budget a
   concurrent run held. Gated the RAG block on `!skipLlmDueToBudget` (it's advisory context for the
   now-skipped proposal step anyway).
4. **Reflection ran / outlived the hold (strategy.ts).** The fire-and-forget post-mortem `generateReflectionSummary`
   (a) ran even when the run was budget/reservation-suppressed, and (b) spent LLM after the finally released
   the reservation. Now skipped when `skipLlmDueToBudget`, and the finally holds the reservation until the
   reflection promise settles (releasing the strategy lock promptly, without awaiting).
5. **Auto-tune outside any reservation (auto-tune-scheduler.ts).** The scheduler chains `maybeAutoTuneWeights`
   after `runStrategyOnce` releases its hold, so its tuning LLM call saw only the committed ledger. It now
   takes its OWN per-user reservation (reserve before marking cadence so a stand-down retries next run;
   release in a finally).
6. **Reservation row not purged on account deletion (account-deletion.ts).** Added `llm_budget_reservation:<user>`
   to both the settings-row count (`countUserSettingsRows`) and the delete sweep. Added a purge test.

Verify after fixes: tsc 0, `npm test` **2176 passed**, build 0, lint 0 errors.

## Follow-ups

- The reservation estimate is a fixed worst-case guard, not per-run modeling. Tune `LLM_RUN_RESERVATION_TOKENS` /
  `LLM_RUN_RESERVATION_COST_USD` if real per-run spend diverges materially from 80k tokens / $1.
- Reservation covers `runStrategyOnce` + its post-mortem reflection + scheduler auto-tune. Other LLM entry
  points (chat, ad-hoc) still rely on the ledger read; they aren't part of the concurrent-scheduler overshoot.
- The 15-min TTL is a static backstop, not renewal; a run exceeding 15min (well beyond current timeouts)
  could still expire mid-run. Renewal-while-active remains a possible future enhancement.
