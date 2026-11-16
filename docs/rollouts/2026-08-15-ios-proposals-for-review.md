# 2026-08-15 — iOS Proposals For Review, price delay, and target debate

## 1. Context & Objective

Owner: the Home tile title is **Proposals for Review** above the count, with
nothing under the number so it matches Open P&L height.  On the review list,
show the price at proposal time, the live price, the proposer's guessed
target, and how much delay changed the trade.  When a proposer leaves the
target blank, Green + Red debate whether a target and a staged exit would
help.

## 2. Changes Made

- Home tile title is `Proposals for Review` above the count, with no subtitle
  so the card matches Open P&L height.  Owner correction: not a line under
  the number, and not the bare title `Proposals`.
- Proposal queue heading is `N Proposals for Review`.
- Review cards list **Proposed**, **Now** (with signed %), **Target** (with
  dollars left, or `none`), **Delay** (better/worse $ on the proposed size),
  and **Stop** when present.
- Target comes from `bracketTakeProfit`, then `scorecard.sniperPoints.takeProfit`.
- Delay is side-aware: a buy that rose is worse; a short that rose is better.
- Missing target shows the Green Team `exitPlan` when present, otherwise a
  short fallback that the panel should debate a target and staged exits.
- Green Team prompt `agentic-strategy@2.10.0` requires that debate in `exitPlan`
  when the target is omitted, and prefers a staged-exit note even when a single
  target is set.  Red Team Job 3 reviews a missing target without inventing an
  exit objection when the levels are already coherent.  2.9.0 on main is
  Polymarket sector/theme + macro tilt labels (#2743); this lane bumps on top.
- Optional `TradeProposal.exitPlan` is sanitized (trim, 2k cap) and decoded on
  iOS.

### Files

```
ios/SocraticTrade/HomeView.swift
ios/SocraticTrade/ProposalsView.swift
ios/SocraticTrade/MobileModels.swift
ios/SocraticTrade/ProposalPriceReview.swift          (new)
ios/SocraticTradeTests/ProposalPriceReviewTests.swift (new)
ios/SocraticTradeTests/MobileModelsTests.swift
src/lib/types.ts
src/lib/strategy.ts
src/lib/strategy-prompts.ts
test/strategy-hardening.test.ts
test/strategy-exit-plan-prompts.test.ts             (new)
test/strategy-prompt-safety.test.ts
STATUS.md
docs/EFFORT-LOG.md
docs/rollouts/2026-08-15-ios-proposals-for-review.md
```

## 3. Decisions & Trade-offs

- Did not add a new LLM call.  The existing Green/Red pair is the expert panel.
- `exitPlan` is optional and not in `BULL_PROPOSAL_REQUIRED_KEYS`, so a truncated
  repair is not discarded for missing it.
- Did not change web console cards in this pass (owner asked for iOS).  The
  snapshot already carried reference/current; only the target/exitPlan needed
  decoding on the phone.
- Delay $ uses proposed quantity × price move.  Dollar-amount-only openings
  without quantity show the % move only.

## 4. Verification State

```bash
npx tsc --noEmit
npx vitest run test/strategy-hardening.test.ts test/strategy-exit-plan-prompts.test.ts test/strategy-prompt-safety.test.ts
# 97 targeted tests green on the first pass.  tsc clean.
# land.sh 2026-08-16: tsc clean; 592 files / 6849 tests passed; next build clean.
# npm run lint: 0 errors (grandfathered warnings only).
# Merged origin/main twice (real 2.9.0 pin conflict, then phantom after #2742).
# CI verify green on 9f39a6d3.  Squash-merged #2740 as c1db7d12 2026-08-16T20:13:56Z.
# Cron ios-ship run 31970196190 uploaded 1.0.36 (202608162123) of c1db7d12.
# ASC ensure-tf-ready 2026-08-16: IN_BETA_TESTING, enc=false.
```

## 5. Next Steps & Blockers

- Owner: update TestFlight on the phone to **1.0.36 (202608162123)** to see
  the Home tile and price rows.
- Web approval card still uses the compact `$200 → $202` line.  Same fields
  could be promoted there later.
- Existing pending proposals without `exitPlan` get the fallback note until
  the next strategy run.

## 6. Zero-Code Findings

None beyond the existing `docs/design/exit-strategy-intelligence.md` (exit
plumbing is strong; policy was still mostly a single stop/target).
