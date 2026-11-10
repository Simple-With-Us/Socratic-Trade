# 2026-07-11 — PR #1371 round 7: 3 fixed, 1 partial + deferred to owner

## Summary

Four fresh Codex findings arrived after the strategy.ts split-merge push. Three fixed outright,
one partially fixed with the remaining question posted to the owner rather than decided
unilaterally.

- **Schema clarity for `stopPlan.style: "default"`** (`src/lib/strategy.ts`): the LLM-facing
  schema description called `"default"` the recommended, safe choice — but downstream it is not
  a no-op: `sanitizeProposals` preserves it and `recordFillFromProposal`/`reconcilePendingFills`
  clear any persisted `position_stop_plans` row on the opening fill. Since the LLM prompt doesn't
  include the currently-persisted stop plan for a position, following the old "recommended"
  language on a scale-in could silently erase an existing `none`/`trailing`/`fixed`/`atr`
  override. Rewrote the description: `"default"` is now explicitly a RESET, and a genuine
  no-change scale-in should leave the whole `stopPlan` field null/omitted instead.
- **Direction-blind live-basis stop-plan matching** (`src/lib/db-api-keys.ts`): the live-basis
  filter (`filterFullStopPlansByLiveBasis`) matched a persisted plan to the current position by
  symbol + avgCost only, not direction. A long closed and the same symbol shorted afterward at a
  coincidentally similar cost basis (or the reverse) would incorrectly inherit the old lot's plan.
  Added a `side: "long" | "short"` field to `PositionStopPlan`, a matching
  `position_stop_plans.side` column (migration 18, defaulting existing rows to `'long'` — every
  row written before this field existed came from an opening buy), threaded `side` through
  `recordStopPlan`'s two call sites (`performance.ts`, `strategy-execution.ts`, both derived
  directly from the opening proposal's `side`), and the live-basis filter now requires
  `plan.side === live.side` in addition to the avgCost match.
- **Short-stop mandatory-stop-loss gate parity** (`src/lib/policy.ts`): the gate requiring
  `riskRules.shortStopLossPct > 0` for any short proposal predates the stopPlan feature and
  didn't recognize an explicit per-position plan as an alternative source of protection — unlike
  the bracket-permission gate a few lines above it, which already does. Extended the gate to also
  accept an explicit `fixed`/`atr`/`trailing` stopPlan (these guarantee real protection via
  `STOP_PLAN_FALLBACK_STOP_PCT` or the trailing lane, same reasoning as the bracket-permission
  fix). **Left unchanged**: an explicit `none` plan still does NOT satisfy this gate. Codex's
  finding treated both cases as the same bug, but they're not — the mandatory-stop-loss
  requirement for shorts is a distinct, pre-existing safety invariant specific to unbounded-loss
  positions, not an instance of the general "stopPlan: none is never hard-blocked" rule this repo
  applies to per-position overrides elsewhere. Whether the owner wants `none` shorts to bypass it
  too is a product/risk-policy call, not a bug fix — posted a PR reply asking, thread left
  unresolved pending the answer.

## Why

Continuation of the Codex review triage on PR #1371, now running reliably via the DeepSeek-routed
autofix bot (confirmed authenticating correctly; still hitting its 60-turn budget on this large a
backlog and not committing — separate, known, non-blocking issue). The direction-matching gap in
particular follows the same pattern as several earlier rounds' stale-plan fixes (closed+rebought
at a similar basis) — this is the same class of bug in a dimension (position direction) the prior
fixes didn't cover.

## Files

- `src/lib/strategy.ts` — `stopPlanSchema`'s `style` description rewritten
- `src/lib/db-api-keys.ts` — `PositionStopPlan.side`, `recordStopPlan` gained a `side` param,
  `filterFullStopPlansByLiveBasis` matches on side too
- `src/lib/db.ts` — `position_stop_plans` CREATE TABLE gained `side`; migration 18 adds the
  column for pre-existing local/dev databases
- `src/lib/performance.ts`, `src/lib/strategy-execution.ts` — `recordStopPlan` call sites pass
  `side` derived from the opening proposal's `side` (`"short"` → `"short"`, else `"long"`)
- `src/lib/policy.ts` — short-stop gate accepts an explicit fixed/atr/trailing stopPlan
- `test/position-stop-plans-db.test.ts`, `test/reconciliation-risk.test.ts`,
  `test/strategy-hardening.test.ts` — updated `toEqual` fixtures for the new `side` field; added
  one new regression test (long plan does not leak onto a same-symbol short at the same basis)

## Verification

```
npx tsc --noEmit   # clean
npm test           # 323 files / 3591 tests passed
npm run build      # clean (next-env.d.ts / tsconfig.json restored after)
npm run lint       # 0 errors, 408 pre-existing grandfathered warnings
```

## Follow-ups

- Open PR thread (`src/lib/policy.ts:346`): should an explicit `none` stopPlan on a short also
  bypass the mandatory `shortStopLossPct` gate, or should that stay a hard block regardless of
  the per-position plan? Awaiting owner's call.
- Still open: OCO sibling-identity pairing (see PR #1331's comment thread) — needs a broker API
  change to fix precisely.
