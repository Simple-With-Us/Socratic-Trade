# Regime-enum adoption inside the risk gates (Monet risk lane)

**Date:** 2026-07-04
**Agent/seat:** MONET (risk-engine swimlane)
**Branch:** `claude/regime-enum-risk-gates` (isolated worktree `nice-heyrovsky-b9d0bd`)

## Summary

Adopted the typed `MarketRegime` enum inside the three deterministic risk gates, replacing three
independent ad-hoc string rules with the single shared classifier in `src/lib/market-regime.ts`:

- **Crisis/inverted opening-exposure cap** (`policy.ts` `isCrisisOrInvertedRegime`): was
  `label.includes("crisis") || label.includes("inverted")` → now
  `isCrisisOrInvertedMarketRegime(regimeFromLabel(label))`.
- **Bear-filter risk-off veto** (`strategy.ts` `deterministicBearFilter`): was
  `regime.startsWith("Crisis") || regime.startsWith("Risk-Off")` → now
  `isRiskOffFilterRegime(regimeFromLabel(regime))`. The veto reason string still quotes the original
  label. This is the site whose in-code comment explicitly reserved the conversion for the risk lane
  ("owned by the risk lane (Monet); it adopts the typed enum from ./market-regime … Do not convert
  here").
- **Escalation gate** (`regime-watch.ts` `isEscalationRegime`): was
  `l.includes("crisis") || l.includes("inverted") || l.includes("risk-off")` → now
  `isEscalationMarketRegime(regimeFromLabel(label))`. This function is also imported by `strategy.ts`
  for the stakes-scaled Red Team dissent trigger, so both consumers now share one source of truth.

## Why

The w1-regime-data lane (Fable, PR #368) introduced the typed `MarketRegime` enum + numeric severity
in a dependency-free module, **deliberately leaving the three risk-gate call sites on their original
substring/`startsWith` rules** and exporting the typed predicates (`isCrisisOrInvertedMarketRegime`,
`isRiskOffFilterRegime`, `isEscalationMarketRegime`, `regimeFromLabel`) plus a pinned behavior matrix
(`test/market-regime.test.ts`) "for a one-line adoption" by the risk lane. That adoption is this
change. Before it, "Cautious (Inverted Curve)" tripped the crisis cap but not the bear filter, and a
future regime relabel could silently desync one gate from another with **no type error** — exactly
the string-coupling the typed enum exists to kill.

This is a **correctness hardening, not an obedience change** (per the product philosophy: harden
correctness + multi-user safety, never re-paternalize). The gates keep the exact same advisory
character and thresholds; only *how the persisted regime label is classified* changes. Behavior on
every canonical persisted label is byte-identical (verified against the pinned matrix). The one
intentional difference: a **non-canonical free-text label** (e.g. a bare `"Crisis"`, a stray
`"Inverted"`, or a synthetic tag like `"Active Risk Check"`) now maps to `unknown` and reads
non-escalating instead of accidentally matching a substring/prefix. Production always persists a
canonical label via `determineMarketRegime`, so this affects only stray/test tags — and it is the
safer reading (an unrecognized string must never itself trip a risk gate).

Imports are taken from `./market-regime` (a dependency-free module), **not** `./macro`, specifically
so `test/regime-watch.test.ts` (which `vi.doMock`s the entire `./macro` module) continues to exercise
the real classifier rather than an undefined mock export.

## Files

- `src/lib/policy.ts` — crisis/inverted cap helper → typed predicate; new `./market-regime` import.
- `src/lib/strategy.ts` — `deterministicBearFilter` risk-off boolean → typed predicate; new
  `./market-regime` import. (The two `isEscalationRegime` call sites at the dissent trigger inherit
  the typed behavior via regime-watch.)
- `src/lib/regime-watch.ts` — `isEscalationRegime` → typed predicate; new `./market-regime` import;
  docstring rewritten to explain the ./market-regime-not-./macro import rationale.
- `test/policy.test.ts` — added a crisis-cap case pinning the non-canonical hardening (bare `"Crisis"`
  label is NOT capped).
- `test/regime-gate-adoption.test.ts` — **new** gate-level regression: pins the bear filter's
  canonical vetoes, the "Cautious (Inverted Curve)" asymmetry (crisis cap only, not bear filter), the
  calm-regime pass-through, the non-canonical hardening, and the escalation matrix — so a future
  refactor that reverts a gate to an ad-hoc substring rule fails here.

## Verification

Full local quartet, all green (in this worktree, off `origin/main` @ `497d06c9`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm run lint` — 0 errors (308 pre-existing grandfathered warnings; none new).
- `npm test` — 254 files / 2465 tests pass.
- `npm run build` — succeeds.
- Targeted: `test/regime-gate-adoption.test.ts` + `market-regime` + `deterministic-bear` +
  `regime-watch` + `policy` + `macro` = 107 tests pass.

Behavior-equivalence audit performed before editing: every regime label literal fed to these gates
across the whole test suite is canonical (`deterministic-bear.test.ts`, `policy.test.ts`,
`redteam-observability-g10.test.ts`, `strategy-money-path-f-g.test.ts`, `red-team.test.ts`) or a
non-escalation fixture (`experience-memory.test.ts` `"Risk-On"`, `socratic-runtime.test.ts` `"Crisis"`
— the latter a persistence-only fixture that never reaches a gate); the regime-watch mock's
`"Neutral (Moderate)"` maps to `unknown` → non-escalating, matching the prior substring result.

## Follow-ups

- The numeric `MARKET_REGIME_SEVERITY` (also exported by the typed module) has no consumer yet; the
  composite review's "vol-targeting / continuous taper / term-structure triggers" (E/high/S) would be
  its first — a separate, larger risk-lane effort, out of scope here.
- Deferred and needing an owner question first (per the drawdown-advisory follow-up): threading the
  drawdown-breach advisory into the Bear context, and a broader per-gate advisory sweep.
