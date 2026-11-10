# 2026-08-19 — iOS Home / Guardrails parity vs live web

## Context & Objective

Live web is `a8a0a65b` (#2856: common index names).  iOS TestFlight is still
1.0.68 and still shows Guardrails → Universe → Indices as
`sp500, nasdaqComposite, dow30, nyseComposite`.  Confirm whether that is a
stale binary or a leftover slug join on current `main`.  Ship only focused,
user-visible iOS gaps.  Fold #2849 if still open.  Do not merge / deploy /
bounce / TF.  HOLD `5674dfaf` / #2840, #2841, #2854.

## Changes Made

**Finding:** the hypothesis held.  #2855/#2856 already map iOS Guardrails and
Desk Current Policy through `DeskCopy.joinedIndexList`.  There is no remaining
raw `includedIndices` join on current `main`.  TF 1.0.68 is behind that source.
#2849 was still open and the Desk subtitle was still in the tree.

- Removed the Home Desk subtitle that restated Coach / Scan / Guardrails /
  Results above those same buttons (folds #2849).
- Home / Insights empty-universe copy now matches web readiness: Guardrails,
  with the `S&P 500` example.  Dropped the iOS-only "Strategy page" pointer
  (the phone has no Strategy tab; web universe edits live on Guardrails).
- Guardrails Universe no longer claims edits stay on the Strategy page.

Touched files:

- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/GuardrailsView.swift`
- `ios/SocraticTrade/InsightsView.swift`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-08-19-ios-web-parity.md`

## Decisions & Trade-offs

- Did not add iOS index checkboxes.  Web Guardrails can toggle indices; iOS
  still shows the labeled selected-set only.  That is a real editor gap,
  deferred (not a rewrite).
- Did not decode or render Scan `source` chips.  iOS `MarketScanResponse`
  still has no `source` field; porting `formatSourceList` is a larger map.
- Did not add Smart Money, Congress Signal Validation, or an iOS Strategy
  page.  Web has those; they are new surfaces, not leftover copy.
- Left the Assets "Scan Table" shortcut card.  Web splits Scan / Watchlist /
  Orders; the iOS card is navigation, not a slug leak.
- Slugs stay as storage / API ids.  No API contract change.

## Verification State

PR **#2857**.  SHA `e2f56f21`.

Product-source grep on this branch:

```bash
rg -n 'Coach, Scan, Guardrails|Strategy page' ios --glob '*.swift'
rg -n 'joinedIndexList|joinedList\(snapshot.policy.includedIndices' ios/SocraticTrade --glob '*.swift'
```

No product UI hit for the Desk subtitle or Strategy page (test assertions
only).  Indices rows: `GuardrailsView` + Desk Current Policy use
`joinedIndexList` only.

```bash
npm run lint          # 0 errors (771 grandfathered warnings)
npx tsc --noEmit      # clean
npx vitest run test/index-universes.test.ts test/console-policy-diff.test.ts test/dashboard-ui.test.ts
                      # 3 files, 36 passed
npm run build         # succeeded
```

Linux Cloud VM cannot run `xcodebuild`.  Swift XCTest added but not compiled
here.  Full `npm test` in this VM hit unrelated network/infra failures (SEC
404, rag-doc-type-coverage, vector-db receipts) not touched by this copy
change — same class as #2855/#2856.

## Next Steps & Blockers

- Review the PR.  Do not merge from this seat.
- Close #2849 as superseded once this lands (same Desk subtitle delete).
- Next TestFlight is required before the phone shows `S&P 500` instead of
  `sp500`.  Do not TF from this seat.
- Deferred: iOS index toggles, Scan source chips, Smart Money.

## Zero-Code Findings

TF 1.0.68 is a stale binary vs `a8a0a65b`, not a remaining slug join on
current main.  The live phone string is the pre-#2855 `joinedList` of raw
`includedIndices`.  #2849 was still the Desk subtitle leak.
