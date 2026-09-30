# 2026-09-29 — Post-Merge Audit Of #3799 (Robinhood $1 Minimum, Account Hold, Hold Reasons) — Lane h3

## Context & Objective

PR #3799 (lane G3: Robinhood $1 minimum fix, account-questionnaire hold, structured `holdReason`)
merged on 2026-09-27 without its adversarial review.  Board `687a5fb4`, wave 3 lane h3 audits the
merged code on `origin/main` against the original G3 lane spec and fixes what is real.  Six defects
were confirmed by reading the merged code and tracing every call site; one is a P1 that made the
new account hold permanent.

## Changes Made

**Findings and fixes (severity, defect, fix).**

1. **P1 — the account-questionnaire hold could never clear by itself.**  The hold cleared only when
   an OPENING order was accepted by the broker, but the run loop refused every opening order while
   the hold was set, so no order could ever be accepted.  The owner alert even promised "this will
   clear automatically the next time an order is accepted".  Even after the owner answered
   Robinhood's questions the account stayed paused until someone deleted an internal setting by
   hand.  Fix: the hold is now half-open (`evaluateAccountActionRequiredGate`).  It pauses entries
   for `ACCOUNT_ACTION_REQUIRED_PROBE_INTERVAL_MS` (6 hours) after each broker refusal, then lets
   one entry through as a probe.  A probe the broker accepts clears the hold; a probe it refuses
   again re-arms the hold for another full interval (the original `since` is kept and a new
   `lastAttemptAt` is recorded).  Worst case while the questionnaire is unanswered: one rejected
   order every 6 hours, never a permanent silent pause.  The probe is spent only when an order
   actually reaches the broker, so a candidate blocked by some other gate does not waste it.  A
   state persisted by the merged version (no `lastAttemptAt`) falls back to `since`; an
   unparseable timestamp probes instead of holding forever.
2. **P2 — the human-approval path neither recorded nor cleared the hold.**  `executeProposal` in
   `strategy-execution.ts` placed orders with no knowledge of the hold.  A card approved by hand
   that Robinhood refused for the questionnaire reason left autonomous runs to rediscover it, and
   an owner who fixed the account and then approved a card by hand still found autonomous entries
   paused.  Fix: the approval placement catch records the hold, and an accepted opening order on
   that path clears it.
3. **P2 — the `holdReasons` funnel counted only proposals still in status "proposed".**  A held
   card that the owner did not answer expires (`proposalExpiryMinutes`) and one they answered is
   placed, rejected, or withdrawn, so `GET /api/ops/performance` reported only the cards open at
   that instant and the funnel was empty for exactly the holds the owner asked about (4 Autopilot
   holds on 2026-09-23).  Fix: `holdReasons` counts every proposal in the window that carries a
   `holdReason`, whatever its status is now.  It is read off the funnel's existing grouped count
   query (`GROUP BY model, status, hold_reason`), so the extra row scan and its row cap are gone
   (`holdReasonRowsCapped` stays in the response shape and is always false).
4. **P2 — the persisted run summary said only "Awaiting approval: N."**  The lane spec asked for
   the reason in the run summary; #3799 only embedded `holdReason` in the per-proposal results.
   Fix: `formatAwaitingApprovalSummary` renders "Awaiting approval: 4 (Red Team review needed: 3,
   Policy hold: 1)." into `strategy_runs.summary`.
5. **P2 — Autopilot holds caused by a mid-run cap breach were labelled "other".**  When
   `autoRevertOnCapBreach` demotes the account to Ask-first, it mutates the run's policy in place,
   and every later proposal in the run takes the `propose` authority branch with no review code.
   `classifyHoldReasonFromCodes` returned "other" for those, which is precisely the case the
   `policy_revert` bucket exists for.  Fix: a new `authorityRevertedInRun` option (true for a
   scheduled run whose stored authority is "decide" but whose run authority is now "propose")
   outranks the catch-all "other" but never a Red Team code.
6. **P3 — the bump planner still degraded a sub-floor trim to a whole-position exit that was
   guaranteed to be blocked.**  #3799 removed the full-exit exemption but only made the planner
   decline an order already at the full position; a partial trim of a position worth less than
   $1 still returned a whole-position plan, costing a broker re-review per run for a known skip.
   Fix: `planBrokerMinimumBump` declines when the whole position itself is under the floor
   (quantity and dollar branches), and the stale "brokers permit liquidating a whole fractional
   position" wording in its doc comment and two test comments is corrected.
7. **P3 — the owner-alert cooldown outlived the hold it belonged to.**  A recurrence within 24 hours
   of a cleared hold would not alert.  `clearAccountActionRequired` now also resets the alert
   cooldown.

**Files touched.**

- `src/lib/broker-account-questionnaire.ts` — half-open gate, `lastAttemptAt`, probe interval,
  alert-cooldown reset on clear, owner-facing reason text.
- `src/lib/strategy.ts` — run loop uses the gate (hold or probe), `authorityRevertedInRun`,
  summary clause.
- `src/lib/strategy-execution.ts` — approval path records and clears the hold.
- `src/lib/hold-reason.ts` — `authorityRevertedInRun` option, `formatAwaitingApprovalSummary`.
- `src/lib/ops-performance.ts` — `holdReasons` over all statuses from the grouped count query.
- `src/lib/broker-minimum-guard.ts` — planner declines a whole position under the floor.
- Tests: `test/account-questionnaire-run-loop.test.ts` (new, real `runStrategyOnce` loop),
  `test/broker-account-questionnaire.test.ts`, `test/hold-reason.test.ts`,
  `test/ops-performance.test.ts`, `test/broker-minimum-bump.test.ts`,
  `test/final-size-red-autonomous.test.ts`.
- Docs: `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Decisions & Trade-offs

- **Probe interval is 6 hours, a constant, not a setting.**  It bounds the cost of an unanswered
  questionnaire at four rejected orders a day and is short enough that a resolved account resumes
  the same trading session.  Per the owner's product philosophy this is an adjustable preference
  in spirit, but the hold itself only reacts to a refusal the broker already issued, so a knob was
  not added; promote the constant to a policy field if the owner wants one.
- **Considered and kept: the removal of the full-position-exit exemption (#3799 A1).**  Whether
  Robinhood accepts a sub-$1 whole-position exit could not be verified from this codebase or from
  production access, which the brief forbids.  The removal is consistent with the pre-existing
  comments on `ROBINHOOD_MIN_ORDER_NOTIONAL` (an unconditional floor) and with Robinhood's own
  `order_checks` pre-flight block, which was never exempt.  The cost of being wrong is one
  unsellable dust position worth under $1 per symbol.  Not changed.
- **Considered and not changed: hold gate runs after the Red Team debate.**  Moving it before
  candidate generation would save LLM cost but is a larger restructure with no correctness payoff;
  #3799 already recorded this as a follow-up.
- **Considered and not changed: the protected `account_action_required` run_failed alert is never
  auto-acknowledged, even after the hold clears.**  It is a persistent inbox item the owner
  dismisses; auto-acking it on clear needs a notification-store helper that does not exist.
- **Considered and not changed: proposals created from chat drafts** (`app/api/proposals/from-draft`)
  carry no `holdReason`.  They are owner-initiated, not held by the app.

## Verification State

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/broker-account-questionnaire.test.ts test/broker-minimum-bump.test.ts \
  test/broker-minimum-bump-execute.test.ts test/broker-minimum-guard.test.ts \
  test/account-questionnaire-run-loop.test.ts test/final-size-red-autonomous.test.ts \
  test/hold-reason.test.ts test/ops-performance.test.ts test/notification-lifecycle.test.ts
npx tsc --noEmit
npx eslint src/lib/broker-account-questionnaire.ts src/lib/broker-minimum-guard.ts \
  src/lib/hold-reason.ts src/lib/ops-performance.ts src/lib/strategy.ts src/lib/strategy-execution.ts
```

Failing tests were written first for the hold gate, funnel, summary, and revert-label findings
(commit `f60da9350`) and for the planner and cooldown findings (they failed before the fix, 4 of 4).
The two integration files (`test/account-questionnaire-run-loop.test.ts`, the approval-path cases
in `test/broker-minimum-bump-execute.test.ts`) were added alongside the fixes and pass.

Results on the merged tree (`origin/main` merged in): `tsc --noEmit` clean (exit 0), eslint 0 errors
(two pre-existing unused-import warnings in `strategy-execution.ts`), every targeted file above
passes.  Caveat: the Mac was at load average 250 to 800, and the repo's own fixed 30 second per-test
timeouts in `test/final-size-red-autonomous.test.ts` fail all six of its tests under that load
(including ones this PR does not touch).  The test carrying this PR's new run-summary assertion
passes when its per-test timeout is raised.  The required `verify` CI check is the binding
full-suite and build gate; `npm run build` was not run locally.

## Next Steps & Blockers

- Owner: if the questionnaire is still pending on the live Robinhood "Agentic" account, answering
  it on robinhood.com is the only real fix; the app now resumes on its own within 6 hours of that.
- Optional follow-up: check the hold before candidate generation to skip the LLM cost, and
  auto-acknowledge the protected alert when the hold clears.

## Zero-Code Findings

- Robinhood sub-$1 whole-position exit behaviour is unverified (see Decisions).  No production
  access was used for this audit.
