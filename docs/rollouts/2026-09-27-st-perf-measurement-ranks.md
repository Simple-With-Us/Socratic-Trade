# 2026-09-27 — ST perf-review improvement plan: rank 3 measurement layer

Sun, Sep 27, 2:35pm

## 1. Context & Objective

The `[ST, Claude] Trading performance report` (Fri, Sep 25, 7:15pm) closed with a ten-rank
Improvement Plan.  Owner asked on 2026-09-27 to (a) confirm everything Claude did after that
review was actually deployed, and (b) implement the remaining proposed improvements.

A code-archaeology pass established that several ranks were already done or already wired, so
this work is deliberately the measurement layer (rank 3) plus what it unblocks, not a blind
re-implementation of the whole plan.  Rank 3 is built first because the plan itself gates rank 5
on it ("Re-check once 3 lands") and because ranks 4, 6 and 7 all decide on numbers this produces.

## 2. Changes Made

Four measurement gaps closed in `src/lib/ops-performance.ts`, the rollup behind
`GET /api/ops/performance`.  Every figure here is derived from data the app already holds; no
broker is called, and no trading behaviour changed.

### 2.1 Round-trip grading (rank 3, part 1)

`computeTradeStats` counts one entry per `ClosedLot`, and a scaled-out position produces one
`ClosedLot` per trim — so two profitable trims followed by a stopped-out remainder grade as two
wins plus a loss instead of one losing trade.  This is the review's "perf-11" note.

- New `OpsRoundTripStats extends OpsTradeStats`, adding `incompleteRoundTrips` and `lotsGraded`.
- New `roundTripKey(symbol, entryAt)` — the same identity `calculatePnl` stamps onto every exit
  it books against an opening lot, so grouping never re-derives FIFO matching.
- New `buildRoundTripStats(closedLots, fills, sinceIso, windowDays)` groups exits by that key,
  sorts each group by `exitAt` (so `aggregateRoundTrip` takes the terminal exit's `exitAt`/`mae`/
  `mfe` rather than whatever order the map yielded), and calls the existing
  `aggregateRoundTrip` (`performance.ts:98`).
- A round trip is graded only once COMPLETE.  `aggregateRoundTrip` returns `undefined` while a
  position is still partly open; those openings are counted in `incompleteRoundTrips` rather than
  dropped, so a report can say "40 graded of 51 opened".
- `fills` supplies the opening size per lot.  `ClosedLot.quantity` is the size each EXIT closed,
  not the size the position was opened with, and those differ on exactly the scaled-out positions
  this exists to measure.
- `tradeStats` is deliberately LEFT in place alongside the new field: per-exit grading is a
  different (and differently wrong) number, and removing it would break existing consumers.

### 2.2 Unattributed model bucket (rank 3, part 2)

`computeModelAttribution` did `if (!model) continue` — unstamped lots were silently dropped.
The review found the unstamped fifth of Alpaca Paper's lots was collectively the PROFITABLE
bucket (+$184.54), so dropping it is what let "gpt-5.5 vs grok-build-0.1" read as ~3-in-1,000 by
chance.  Those lots now land in an explicit `unattributed` row, using the same label the Red
Team rollup already uses (`performance.ts:1391`) so both surfaces agree on what the word means.

### 2.3 Proposal funnel by proposing model (rank 3, part 3)

The funnel was `GROUP BY status` only.  The single grouped query now also groups by
`COALESCE(NULLIF(TRIM(json_extract(proposal, '$.proposedByModel')), ''), 'unattributed')`,
and the global per-status counts are computed by summing the per-model rows in memory.

That in-memory sum is the point: this module's whole design constraint (see its own doc comment
and `docs/rollouts/2026-09-12-issue-3221-event-loop-stalls.md`) is not adding a query whose cost
scales with the window.  Both views come from one scan, so they can never disagree.
`trade_proposals` has no `proposed_by_model` column — the stamp lives in the `proposal` JSON
blob, and `json_extract` on that blob is the established pattern in this repo (`db.ts:4521-4524`).

### 2.4 Broker-rejection reasons (rank 3, part 4)

`topBlockReasons` only ever read the app's OWN pre-placement block decision, so the ~84 broker
rejections outside the PG failure path were one unexplained bucket.  New
`brokerRejectionReasons` itemises them from `audit_events` where
`kind = 'order_rejected_by_broker'`, reading `payload.reason` and falling back to
`payload.brokerState` for the reconcile-path rows that carry no reason string.

`canonicalizeBrokerRejectionReason` strips a leading `HTTP <code>:` prefix and collapses
whitespace, so the same refusal arriving as HTTP 422 and HTTP 400 counts as one cause.  It is
deliberately NOT a full canonicalizer — over-merging genuinely different refusals would be worse
than under-merging.  Same caveat as `topBlockReasons`.

Scoping uses `audit_events`' own `(user_id, connected_account_id, kind)` columns rather than
joining through the payload's `proposalId` to `trade_proposals`.  Every `order_rejected_by_broker`
row is written with both by `audit()` (`db.ts:3627`), and `idx_audit_events_user_account_kind`
covers the lookup; the join would have made SQLite parse every rejection payload in the table.

### 2.5 Files touched

- `src/lib/ops-performance.ts` — all four changes; `roundTripStats` added to
  `OpsPerformanceAccount` and populated on all three account branches.
- `test/ops-performance-measurement.test.ts` — new, 6 tests.

## 3. Decisions & Trade-offs

- **Kept `tradeStats` next to `roundTripStats`.** The review wants round trips as the decision
  denominator, but deleting the per-exit figure would break existing consumers and destroy the
  ability to see the gap.  Both ship.
- **Incomplete round trips are counted, not imputed.** Grading a half-closed trade is grading it
  before it is over, so the honest answer is "not yet", reported as a count.
- **Broker-reason bucketing is deliberately shallow.** Stripping the HTTP status is the one
  normalisation that pays for itself; a real taxonomy would need its own effort and its own tests.
- **No trading behaviour touched.** This is a read-only diagnostics endpoint.

## 4. Verification State

```
npx tsc --noEmit                                  # 0 errors in src/ + app/
npx vitest run test/ops-performance-measurement.test.ts test/ops-performance.test.ts
                                                  # 17 passed (17), 2 files
```

`npm run lint` and the whole-repo `npm test` were NOT completed for this lane: the host was at
load average 114-228 for the whole session (three users, several seats' suites running), and a
full-suite run did not finish inside its window.  **CI's `verify` check is the full-suite gate of
record for this PR** — treat the numbers above as targeted, not as the whole gate.

## 5. Next Steps & Blockers

- Ranks 4, 5, 6, 7 are unblocked by this and are the next unit.  Rank 4 (equal-risk sizing) and
  rank 5 (per-thesis sizing knob) both change money-path sizing and should land behind a policy
  flag with the new `roundTripStats` as their measurement baseline.
- Rank 7 (Red Team re-score at matched horizon) is a measurement change on the same rollup.
- Rank 8 (dormant-account parking) needs a `parked` state and therefore a schema migration; the
  `ConnectedAccount` model (`types.ts:832-862`) has no such field today.
- Rank 9's code already exists (`benchmark.ts`); the staleness is an ingest condition, not a gap.

## 6. Zero-Code Findings

Owner also asked for confirmation that Claude's post-review work was deployed.  Verified:

- Production is live at `7492aa1f3` (`bash scripts/verify-deploy-sha.sh` → PASS, `ok=true db=ok`),
  which is the tip of `main` and includes #3793 (approved exits release the app's own resting
  protective stop — review rank 2).
- Merged and deployed: #3750, #3751, #3759, #3761, #3754, #3755, #3756, and rank 2 (#3793).
- Four review-round PRs were stuck `DIRTY` on phantom conflicts and were re-synced onto `main`:
  #3791, #3794, #3795, #3798.
- `~/apps/claude-st-ops-account-control` and `~/apps/claude-st-order-roles` looked stranded
  (local-only branches, no PR).  They are NOT lost — #3754 and #3755 are already merged to `main`
  (`47f2d6804`, `a0b3e51b6`).
- Review rank 10 ("why did Autopilot runs leave 4 proposals Awaiting approval") is already
  answered by shipped code: `hold-reason.ts` classifies the cause, and it is
  `red_team_unavailable` — the Red Team could not run, so the proposal was held for a human.

---

## Addendum — Seer review round on rank 3, and rank 5 (per-thesis sizing dial)

### 7. Seer findings on rank 3 — both correct, both fixed

`sentry[bot]` (Seer) posted two MEDIUM findings on PR #3895.  Both were real:

1. **`brokerRejectionRowsCapped` compared two different populations.**  It read
   `rejectedCount > sum(brokerRejectionReasons)`, where `rejectedCount` is a count of *proposals*
   carrying the `rejected_by_broker` status and the right-hand side counts *audit rows*.  Those are
   different populations — one proposal can log several rejection events, and a reconcile-path audit
   row can exist without a status write — so the flag was wrong in both directions.  It also lost
   rows past the `.slice(0, 20)`.  Now simply `brokerRejectionRows.length >= MAX_BROKER_REJECTION_ROWS`,
   matching the block-reason and hold-reason scans.  The now-unused `brokerRejectionRowsUnreadable`
   counter was dropped in favour of the sibling scans' catch-and-skip convention.
2. **`lotsGraded` counted every lot ever, not just the windowed ones.**  `computeTradeStats` windows
   on `exitAt >= sinceIso`, but `lotsGraded` accumulated unconditionally, so a 200-day-old round trip
   inflated a denominator that contributed nothing to `tradeCount` — two figures describing the same
   window and disagreeing.  Now applies the identical predicate.  Regression test added
   ("windows lotsGraded the same way it windows tradeCount").

### 8. Rank 5 — per-thesis sizing multiplier

`policy.tuning.thesisSizeMultipliers: Record<string, number>`, keyed by `tradeThesisTag`, applied in
`applyDeterministicSizing` (`strategy-risk.ts`) on top of the learned `edgeFactor`.

The motivating case is the review's own: "Value-Quality — the most consistent negative thesis in the
data (25 lots, -$79.18)".  The learned path already shrinks a weak thesis from realized stats, so
this dial exists for what that cannot do: park a thesis whose sample is too thin or too
regime-specific for its learned factor to be trustworthy.

Two deliberate design decisions, both discovered by the tests failing first:

- **Clamped to [0, 1].**  A knob that could *inflate* sizing on a typo is not a knob anyone should
  leave in a policy file.  A non-finite or out-of-range value is ignored entirely.
- **An explicit 0 BYPASSES `sizingFloorPct`.**  The floor exists to stop the sizer emitting dust, but
  an operator parking a thesis means "stop trading this", and silently sizing it at the floor would
  make the dial lie.  The existing `avgReturn < 0` branch already takes exactly this hard-zero path,
  so this is the same rule reached by configuration rather than by learned stats.  Safe in practice: a
  0-notional order cannot reach a broker (the small-account/broker-minimum guards reject it), so
  honouring the zero degrades to "proposal never places" with no possibility of an accidental fill.

Every application is announced in the order rationale and in a `sizing_thesis_multiplier_applied`
audit event, matching the `volTargetNote` convention — silent shrinkage is indistinguishable from a
bug in the log.

Not done in this addendum: rank 5's second half ("watch Momentum-Breakout") needs rank 3's
`roundTripStats` to be live and a fresh sample; it is a decision, not a code change.

### 9. Verification (addendum)

```
npx tsc --noEmit                                                        # 0 errors in src/ + app/
npx eslint <5 touched files>                                            # clean
npx vitest run test/thesis-size-multiplier.test.ts \
                test/kelly-sizing.test.ts test/vol-targeting-sizing.test.ts \
                test/finalized-sizing-review.test.ts test/broker-minimum-sizing.test.ts
                                                                       # 29 passed (29), 5 files
```

The 4 pre-existing sizing suites passing unchanged is the load-bearing check: the new multiplier
composes with the floor/ceiling clamp, vol targeting, fractional-Kelly and the broker-minimum guard
without perturbing any of them.
