# 2026-06-20 — Money-path T5: paper-projection side-aware guards

## Summary

Tranche-2 of the money-path plan. Fixed **T5**: `getPaperPortfolioProjection`
(`src/lib/performance.ts`) mishandled side-inconsistent fills. Pinned with 6 tests.
`tsc` clean, **365 tests** pass (+6).

## Why

The paper portfolio projection (shown on the dashboard and consumed by `strategy.ts`
for paper sizing) had two side-blindness bugs adjacent to the live-projection path:

1. **Wrong-sign / flat closes.** The closing branch capped the matched quantity at
   `Math.abs(current.quantity)` regardless of sign, so a `sell` against a *short*
   deepened the short (`-matched`) and a `cover` against a *long* deepened the long.
   A close that matched nothing (flat account) silently produced a phantom delta.
2. **Opposite-side averaging.** An opening `buy` landing on a *short* (or `short` on a
   *long*) blended the fill cost into `averageCost` across the flip, corrupting the cost
   basis (e.g. covering 1 of a 2-share short @100 with a buy @120 produced averageCost
   320 instead of 100).

## What changed (code)

- `src/lib/performance.ts` `getPaperPortfolioProjection`: made the fill loop side-aware.
  - Closing branch (`sell`/`cover`): only reduces a SAME-SIDE position (`sell`→long,
    `cover`→short); a wrong-sign or flat close matches nothing and is skipped — never
    deepens the opposite side.
  - Opening branch (`buy`/`short`): `averageCost` is re-weighted only on a same-side
    increase; left intact on a partial opposite-side close (the cover/sell leg keeps the
    remaining lot's basis); and re-based to the fill price on a flip past zero. Cash flow
    is unchanged (`buy` spends `qty*price`, `short` receives it, regardless of netting).
  - Same-side behavior is byte-for-byte equivalent to before, so prior tests are unaffected.

## What changed (tests, +6)

- `test/performance.test.ts` new block "getPaperPortfolioProjection — T5 side-aware guards":
  sell-vs-short (no deepen), cover-vs-long (no deepen), flat-close no-op, buy-covers-short
  (basis intact, not averaged), short→long flip (re-based to fill price), and a same-side
  short-averaging regression.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 365 passed (46 suites).
- NOT run: `npm run build` (would wipe the running 4100 dev server's `.next`; `tsc` + tests
  cover this pure-accounting change).

## Follow-ups (remaining money-path tasks)

- **T6** — db-level notional tests (short/cover + hourly window + tenant isolation); null-`estimated_notional` fallback.
- **T9** — `recordFillFromProposal` short/cover boundary tests.
- **T10** — DESIGN DECISION (gross/net exposure gates vs. remove unused fields) — needs sign-off.
- **T11** — red-team fail-open contract tests + debate drop/keep filter.
- **T12** — pin `tax.ts` long-only behavior for short/cover (document + guard tests).
- **T13** — daily-notional reset timezone (explicit/configurable) + kill-switch notification path.
- **T14** — policy returned-field consistency, dead `currentPriceForPosition`, empty-account-number scoping.
