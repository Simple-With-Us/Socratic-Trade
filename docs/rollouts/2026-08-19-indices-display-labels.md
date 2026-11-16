# 2026-08-19 — Show “S&P 500”, not “sp500”, on Indices rows

## Context & Objective

User-facing Indices lists printed storage slugs (`sp500`) instead of product names (`S&P 500`).  Internal `IndexUniverse` ids, `defaults.ts` `includedIndices: ["sp500"]`, and snapshot / API payloads stay slugs.  Copy/UI only.

## Changes Made

Web Guardrails checkboxes already used the product names.  The leak was iOS Guardrails (`DeskCopy.joinedList` on raw `includedIndices`) and the web policy-diff extra-patch summary (`adds russell2000`).  Scan source chips already map `sp500-universe` → `S&P 500 Universe`.  Display now goes through `indexUniverseLabel` / `indexUniverseDisplayLabel`; web `INDICES` is derived from `INDEX_UNIVERSES` so the labels cannot drift.

- `src/lib/index-universes.ts`
- `app/console/guardrails/field-defs.ts`
- `app/console/lib/policy-diff.ts`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/GuardrailsView.swift`
- `test/index-universes.test.ts`
- `test/console-policy-diff.test.ts`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-08-19-indices-display-labels.md`

## Decisions & Trade-offs

- Reused `INDEX_UNIVERSES[].label` (`S&P 500`, `Nasdaq 100`, …).  Did not invent a second map.
- Unknown slugs are omitted from the label list so a future id cannot print as camelCase copy.  Direction still uses the raw set-diff.
- iOS duplicates the same eight labels in `DeskCopy` because Swift cannot import the TS helper.  Tests lock both sides to the same strings.
- Did not change API ids, storage, or `defaults.ts`.  Did not touch #2841 / #2849 / #2854 / #2840 / #2850.  Did not merge, deploy, bounce, TF, or click Run once.

## Verification State

```bash
npx vitest run test/index-universes.test.ts test/console-policy-diff.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

Focused tests: 2 files, 30 passed.  Lint: 0 errors (grandfathered warnings).  `tsc --noEmit` clean.  `npm run build` succeeded.  Full `npm test` in this VM hit unrelated network/infra failures (SEC 404, usage-budget, vector-db receipts) not touched by this copy change.  No Xcode on this VM; iOS XCTest added but not compiled here.

## Next Steps & Blockers

Jay merges.  Do not merge / deploy / bounce / TF from this seat.

## Zero-Code Findings

Hypothesis held for iOS: Guardrails was joining raw slugs.  Web Guardrails chips were already labeled.  The stray web leak was policy-diff, not a Scan chip.  Scan source chips already use `S&P 500 Universe` / `NASDAQ Composite Universe`.
