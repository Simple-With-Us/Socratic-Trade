# 2026-07-10 — Activity-audit item 10: account-attribution sweep (`strategy.ts` + `synthetic-stops.ts`)

**Agent:** CLAUDE, branch `claude/audit-item10-attribution`, built in a fresh detached
worktree off `origin/main`. Picked up the reserved item-10 row per
`docs/EFFORT-LOG.md` ("RESERVED 2026-07-10 for a second owner-directed session, split out
of MONET's P1 batch"). Recon confirmed zero prior commits/branches/Slack claims and a clean
worktree before starting.

## Summary

Threaded `connectedAccountId` into every `audit()` call site in `src/lib/strategy.ts` and
`src/lib/synthetic-stops.ts` that had it available in scope but omitted it — 54 sites total
(41 in `strategy.ts`, 13 in `synthetic-stops.ts`; the report's own count was "~54"/"~42"/"12"
— see Follow-ups for the reconciliation of the small deltas). Every attribution kind called
out in `docs/reviews/2026-07-09-activity-feed-audit.md` §1.10 is now attributed:
`fill_reconciled`, `order_placement_uncertain`, `strategy_bull_truncated` (already fixed —
excluded, see below), `order_blocked_live_preflight`, `synthetic_stop_error`, and every
sibling kind in the same two files.

**Zero behavior changes to trading logic.** This is purely the 4th positional arg
(`connectedAccountId`) on existing `audit(kind, payload, userId, connectedAccountId?)` calls,
plus two new *optional*, trailing function parameters so the value could reach two internal
helpers. No gate, no order-placement path, no sizing math, no policy decision touched.

## What changed, by pattern

- **`runStrategyOnce`** (the largest block): the function already computes a local
  `connectedAccountId` const at the top (`targetAccountId ?? getPolicy(userId).connectedAccountId`).
  Added it as the 4th arg to every in-scope `audit()` call that was missing it (14 sites):
  `run_skipped_market_closed`, `congress_gate_applied`, `policy_violation_drawdown` (both
  branches), `policy_violation_vol_panic`, `strategy_run_suppressed_budget_reservation`,
  `strategy_run_suppressed_budget` (both the mid-run and pre-generation sites),
  `run_skipped_score_threshold`, `proposal_skipped_negative_ev`,
  `strategy_rationale_collapse_gated`, `order_blocked_live_preflight`,
  `order_placement_uncertain`, `order_rejected_by_broker`.
- **Functions that already take a full `policy: TradingPolicy` parameter** (
  `resolveScanScoringWeights`, `applyCorrelationClusterGate`, `applyEarningsBlackoutTag`,
  `applyRiskReceipts`, `applyDeterministicSizing`, `executeProposal`,
  `runSyntheticStopMonitor`): added `policy.connectedAccountId` as the 4th arg to every
  in-scope `audit()` call missing it — no signature change needed, the value was already
  reachable. Covers `missed_opportunity_nudge`, `proposal_skipped_correlation`,
  `proposal_tagged_earnings_blackout`, `correlation_receipt`, `stress_receipt`,
  `sizing_vol_target_applied`, `sizing_fractional_kelly_applied`,
  `sizing_heat_budget_applied`, 7 `proposal_approved`/`order_*` sites in `executeProposal`,
  and all 13 `audit()` sites in `synthetic-stops.ts`.
- **`autoRevertOnCapBreach`** already receives `connectedAccountId` as a parameter (used for
  its `setPolicy` call) but its own `policy_violation_cap_exceeded` audit call didn't use it
  — one-line fix, no signature change.
- **`proposeTrades`**: both `strategy_llm_failover` sites now pass
  `input.policy.connectedAccountId` (the function already closes over `input.policy`).
- **`recordLlmOutcome`**: added an optional `connectedAccountId` field to its `ctx` parameter
  and threaded it into all 3 of its `audit()` calls (`llm_call_latency`, `llm_late_response`,
  `llm_late_response_capture_error`); its sole call site (inside `proposeTrades`) now passes
  `input.policy.connectedAccountId`.
- **`reconcilePendingFills`** and **`flagStalePlacingIntents`**: both gained a new *optional*
  trailing `connectedAccountId?: string` parameter and thread it into their `fill_reconciled` /
  `order_placement_uncertain` / `order_placement_recovered` audit calls. Only the two call
  sites inside `runStrategyOnce` (which already has `connectedAccountId` in scope) were
  updated to pass it — see Follow-ups for the other callers left untouched.

## Excluded (already fixed elsewhere, intentionally not re-touched)

- `strategy_bull_truncated` — fixed by the P1 batch (PR #1314); left as-is (already carries
  `input.policy.connectedAccountId`).
- `src/lib/post-mortem.ts` (`post_mortem_reflection`) and the `setUserSetting` no-audit flag —
  also P1-batch scope, not this file pair.
- `src/lib/broker-protective-stops.ts` (8+1 latent sites) — a separate P3-batch item on the
  board, not item 10.

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — clean.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/strategy.ts src/lib/synthetic-stops.ts`
  — 0 errors, 9 pre-existing grandfathered warnings (unrelated unused-var/import warnings,
  untouched by this change).
- Focused Vitest run (node@24, `better-sqlite3` ABI-sensitive): 46 test files / 523 tests,
  all passing — every `strategy-*`, `synthetic-stops`, `reconciliation-risk`,
  `run-strategy-offline`, `usage-budget-strategy-integration`, sizing/gate/veto/wash-sale
  suites that exercise these two files, plus `llm-usage-per-account`, `ops-snapshot`,
  `per-account-policy-isolation`, `persistence-notification`, `post-mortem`,
  `dashboard-feed`/`dashboard-fill-batching`, and `scheduler-cadence`/`scheduler-lease` (in
  case the new optional params on `reconcilePendingFills` broke a scheduler-side caller — they
  did not, since the new param is trailing and optional).
- Did NOT run the full suite / `npm run build` / `land.sh` — per the Build-phase instruction,
  the full gate runs in the serialized Land phase.

## Files

- `src/lib/strategy.ts` — 41 `audit()` sites attributed; `recordLlmOutcome` ctx,
  `reconcilePendingFills`, `flagStalePlacingIntents` signatures gained an optional
  `connectedAccountId` parameter.
- `src/lib/synthetic-stops.ts` — all 13 `audit()` sites in `runSyntheticStopMonitor`
  attributed via `policy.connectedAccountId`.
- `docs/EFFORT-LOG.md`, `STATUS.md` — this rollout's board/status stanza.
- `docs/rollouts/2026-07-10-audit-item10-attribution-sweep.md` — this note.

## Skipped sites (ambiguous or deliberately out of scope — not guessed)

- Historical NULL-attributed audit rows (the 216 `post_mortem_reflection`, 800
  `synthetic_stop_error`, etc. rows already in the DB) are untouched — per the report, no
  backfill; they age out of the feed's 3-day-ish default windows naturally.

### Land-phase correction (2026-07-10, same branch)

The three sites below were originally listed as deliberate out-of-scope skips (see git
history of this file), but `chatgpt-codex-connector`'s PR review (P2) on PR #1341 flagged
them as real gaps, and re-checking each confirmed the "left alone by design" reasoning didn't
actually hold — the fix commit `116ee816` closed them:

- **`src/lib/fills.ts:21`** (`onBrokerFill`) and **`src/lib/scheduler.ts:459`** (per-tick
  reconcile) both call `reconcilePendingFills` with `policy` already in scope but weren't
  passing `policy.connectedAccountId` — their `fill_reconciled` audit rows kept recording
  `connected_account_id = NULL`. `fills.ts`'s `policy = getPolicy(userId)` is that user's
  active-account policy; `scheduler.ts`'s `policy = getPolicy(userId, accountId)` is resolved
  per-schedule-entry — in both cases `policy.connectedAccountId` is exactly the right account
  to attribute to, not a guess. Fixed by passing it through.
- **`executeProposal`'s blocked-decision path** (`autoRevertOnCapBreach(decision.reasons,
  policy, userId)` at the former line ~3976) omitted the 4th arg. The original reasoning —
  "the manual executeProposal path passes no id because it already operates on the active
  account" — is true for `setPolicy`'s account-scoping (the code comment on
  `autoRevertOnCapBreach` itself, `strategy.ts:3509`) but doesn't extend to the function's own
  `policy_violation_cap_exceeded` audit() call, which kept recording NULL. Traced
  `executeProposal`'s `policy = getPolicy(userId)` (no account override) through
  `getPolicy`/`resolveAccount`: it always resolves to and stamps the ACTIVE account's id onto
  `policy.connectedAccountId`, so passing `policy.connectedAccountId` here is byte-identical
  to the implicit active-account resolution `setPolicy` already does when omitted — a no-op
  for account-demotion scoping, but it fixes the audit attribution. Confirmed safe before
  changing (not just applying the bot's suggested diff blind).

Verification for this correction: `npx tsc --noEmit` clean; focused re-run of
`test/risk-receipts.test.ts` (also fixed — see below), `test/broker-minimum-bump-execute.test.ts`,
`test/reconciliation-risk.test.ts`, `test/usage-budget-strategy-integration.test.ts`,
`test/synthetic-stops.test.ts` — all passing; full `land.sh` gate (tsc/test/build, 315 files /
3377 tests) re-run green after.

A **third** Codex re-review pass (after that push) found one more: `runStrategyOnce`'s three
`autoRevertOnCapBreach(decision.reasons, policy, userId, targetAccountId)` calls (tradability/
escalation/block paths, formerly lines 1741/2010/2026) pass the raw `targetAccountId` — which
is `undefined` for the common case of a run targeting the active account with no explicit
override (`options.connectedAccountId` unset) — instead of the function's own already-resolved
`connectedAccountId` local const (`targetAccountId ?? getPolicy(userId).connectedAccountId`,
line ~311) that every one of the OTHER 14 `audit()` sites in this same function already uses.
Fixed by swapping `targetAccountId` → `connectedAccountId` at all three sites — matches the
established in-function pattern exactly, and by the same resolution argument as above (when
`targetAccountId` is undefined, `connectedAccountId` resolves to the active account, which is
what `setPolicy`/`autoRevertOnCapBreach` would have targeted anyway) this is a no-op for the
account-demotion write and only fixes the audit NULL. Verified: `npx tsc --noEmit` clean;
138 tests across 9 focused files (including `strategy-hardening`, `strategy-bear-fail-closed`,
`strategy-moneypath-drawdown-flip`, `strategy-rationale-collapse-gate`,
`usage-budget-strategy-integration`) passing.

### Land-phase test fix

`test/risk-receipts.test.ts`'s two `auditSpy` assertions (`correlation_receipt`,
`stress_receipt`) still expected the pre-sweep 3-arg `audit()` call shape and failed under
`land.sh`'s verify gate once this branch's real 4-arg calls ran. Updated both assertions to
expect the 4th arg (`policy.connectedAccountId`, `undefined` in that test's fixture) —
commit `2d8c1f78`.

## Follow-ups / risks

- The report said "~42" strategy.ts sites; this sweep changed 41 direct `audit()` calls plus
  wired the `recordLlmOutcome`/`reconcilePendingFills`/`flagStalePlacingIntents` plumbing the
  report called out by name (those functions' 3 downstream audit-call sites are counted in
  the 41). The report said "12" synthetic-stops.ts sites; the file actually has 13 `audit()`
  calls (the extra is `broker_protective_stop_reconcile_error`, in the same function with
  `policy` already in scope) — fixed for consistency rather than left as a stray NULL.
  41 + 13 = 54, matching the task's own "~54 sites" figure.
- `scheduler.ts`/`fills.ts` callers of `reconcilePendingFills`, and `executeProposal`'s
  blocked-decision `autoRevertOnCapBreach` call, were fixed during the Land phase (see
  "Land-phase correction" above) — no longer open follow-ups.
- Landed via PR #1341 (squash auto-merge). Full gate (`npx tsc --noEmit` / `npm test` /
  `npm run build` via `scripts/land.sh`) re-run green multiple times across the land-phase
  fixes described above.
