# 2026-08-19 — Indices common names on every surface

## Context & Objective

#2855 (`b27de85c`) mapped iOS Guardrails and policy-diff extras, but live
Guardrails → Universe → Indices still printed `sp500, nasdaqComposite, dow30,
nyseComposite`.  Jay does not distinguish “rows” vs Guardrails.  Both (all)
surfaces must use the same names: S&P 500, Nasdaq Composite, Dow 30, NYSE
Composite, Nasdaq 100, Russell 2000, FT Wilshire 5000, S&P 100.  Slugs stay as
storage / API ids.  New PR on current `main`.  Do not reopen #2855.

## Changes Made

Web Guardrails now labels the control **Indices** (not “Base indices”) and
prints the selected-set through `formatIndexUniverseList`.  Scan
`${IndexUniverse}-universe` chips derive from `indexUniverseLabel` for every
slug (including `dow30` / `russell2000`, which had no map and leaked).  Policy-diff
uses the same **Indices** label.  iOS Desk Current Policy gained an Indices row
on `joinedIndexList`.  iOS Guardrails already used that helper after #2855.

- `src/lib/index-universes.ts`
- `src/lib/dashboard-ui.ts`
- `app/console/guardrails/page.tsx`
- `app/console/lib/policy-diff.ts`
- `ios/SocraticTrade/HomeView.swift`
- `test/index-universes.test.ts`
- `test/dashboard-ui.test.ts`
- `test/console-policy-diff.test.ts`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-08-19-indices-common-names.md`

## Decisions & Trade-offs

- Did not special-case only `sp500`.  Labels come from `INDEX_UNIVERSES` /
  `DeskCopy.indexUniverseLabels` for all eight ids.
- Scan chips keep the existing “Universe” suffix (`S&P 500 Universe`) so they
  stay source-attribution, but the index half is the same common name.
- Unknown slugs stay off the label list so a future id cannot print as camelCase.
- Did not change API ids, storage, or `defaults.ts`.  HOLD `5674dfaf`.  Did not
  touch #2841 / #2849 / #2854 / #2840.  Did not merge, deploy, bounce, TF, or
  click Run once.

## Verification State

```bash
npx vitest run test/index-universes.test.ts test/console-policy-diff.test.ts test/dashboard-ui.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

Focused tests: 3 files, 36 passed.  Lint: 0 errors (771 grandfathered warnings).  `tsc --noEmit` clean.  `npm run build` succeeded.  No Xcode on this VM; iOS XCTest updated but not compiled here.

## Next Steps & Blockers

Jay merges.  Do not merge / deploy / bounce / TF from this seat.

## Zero-Code Findings

The live leak string is `includedIndices.join(", ")`.  #2855 fixed the iOS
Guardrails call site in source, but the web selected-set was never rendered
through the helper, Scan chips still special-cased a subset, and Desk Current
Policy had no Indices row.  TF was not shipped, so iOS testers still see the
pre-#2855 binary until a later TestFlight.
