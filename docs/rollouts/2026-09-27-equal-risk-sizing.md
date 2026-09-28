# Equal-Risk Sizing Cap (2026-09-27)

## 1. Context & Objective

The 2026-09-25 trading performance review found that 4 lots accounted for 70% of the account's
total loss, and that the `Insider-Accumulation` thesis was positive **in percent** while negative
**in dollars** — purely because its losing positions were the larger ones.  Both shapes are the
signature of a sizing function that caps **notional** rather than **dollar risk**.  This change adds
an opt-in dollar-risk cap so that every new position risks the same dollars by construction, and
serves the "better outcomes" goal of the 2026-09-27 performance audit (board parent
`dc501c689caa4fdf8a934289be9cec99`).

**Provenance note.**  This work was found uncommitted in the `minimax/perf-rollout-doc` lane, which
had drifted 3 commits behind `origin/main`.  It was recovered to a patch, the lane was stashed, and
the diff was re-applied cleanly onto a fresh branch off `origin/main` (d0440ed22) so it can land on
its own without carrying the unrelated branch-protection commits.  See § 3.

## 2. Changes Made

High level: `applyDeterministicSizing` gains an opt-in **equal-risk cap**.  Size is derived as
`risk budget ÷ stop distance`, so a name with a wide stop no longer silently carries a wider loss
than the account intended.

Files touched:

- `src/lib/strategy-risk.ts` — added `resolveStopDistancePct`, the equal-risk cap, its audit event
  `sizing_equal_risk_capped`, and a re-assertion after the bracket raise.
- `src/lib/types.ts` — added `TuningSettings.maxPositionRiskPctOfEquity`.

Design decisions that matter:

- **Stop distance is resolved from the concrete order, not a policy average.**  Preference order is
  `proposal.stopPrice` vs `proposal.referencePrice` (the actual order), then
  `policy.riskRules.stopLossPct`, then the shared `STOP_PLAN_FALLBACK_STOP_PCT` constant that
  `synthetic-stops.ts` and `broker-protective-stops.ts` already use.  It returns the fallback
  rather than `0` because a zero distance would make `budget ÷ fraction` infinite and **silently
  disable the cap** — the exact failure a risk cap must not have.  It returns `0` only when a stop
  was configured at a non-positive distance, which the caller treats as "skip the cap".
- **The cap is applied before the ADV cap and re-asserted after the bracket raise.**  The bracket
  raise exists only so Alpaca can place a *native* whole-share bracket — a convenience, not a risk
  requirement — so it must not quietly push an order back above the configured dollar-risk budget.
  The cost is that such an order loses its broker bracket and places unbracketed, which is the right
  way round: the risk budget wins, the bracket does not.
- **The broker-dollar minimum is a HARD constraint and is left to win.**  Robinhood (and potentially
  other brokers) reject sub-minimum orders.  Refusing to trade is the owner's call, not this
  function's, so the cap does not override it.
- **It is a cap, never a sizing target.**  It can only shrink an order.  Existing floors, ceilings,
  ADV, and broker-minimum rules still apply around it.  Off when unset or non-positive, so this
  change is **behaviour-preserving until the owner sets the tuning value**.

## 3. Decisions & Trade-offs

- **Opt-in, default off.**  `maxPositionRiskPctOfEquity` is undefined by default, so no behaviour
  changes until the owner picks a value.  This is deliberate: the correct percentage is an owner
  risk decision, and shipping a default that silently resizes every future order would be a
  live-order behaviour change nobody asked for.
- **No new dependency.**  Uses the existing `audit()` pattern and `accountEquity` helper.
- **Deliberately does not touch live order placement semantics** beyond the cap itself.
- **The stale-lane recovery is recorded here** because it is a trap worth remembering: a lane 3
  commits behind `main` with uncommitted work is a real hazard, and `git apply --3way` staged the
  result against `main` cleanly even though a main commit had touched the same files.

## 4. Verification State

Run in the lane worktree `/Users/jay/apps/trading-minimax` on branch `minimax/equal-risk-sizing`.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

**Results: see the commit message and PR body for the actual output.**  `scripts/land.sh` runs
tsc → vitest → next build and aborts on any failure, so a landed PR is itself the evidence that the
gate passed.

## 5. Next Steps & Blockers

- **Owner action:** choose `maxPositionRiskPctOfEquity`.  Until it is set, this code is inert.  A
  starting point to consider is 0.5–1.0% of equity per position, but that is a risk decision, not
  a technical one.
- **Open:** the 2026-09-27 performance audit filed related P0s — the self-graded `tradeThesisTag`
  (which makes per-thesis P&L unfalsifiable) and the semantic-gate queue that strands the app's own
  post-mortem lessons.  Those are tracked under board parent `dc501c68`.
- **Open:** the `minimax/perf-rollout-doc` branch still holds 2 commits ahead of `main`
  (branch protection + the EXPLAIN QUERY PLAN doc).  It is now clean and stashed-free; those
  commits are unrelated to this change and still need their own landing path.
