# 2026-08-16 — Overlay regime label/enum match

## 1. Context & Objective

#2743 shipped the overlay library.  The architect review then found the live apply path passed `determineMarketRegime()` labels into a router that matches `MarketRegime` enums.  Only overlays tagged `any` could fire on a real run.  Would Fire Now in the UI used enums, so the preview lied relative to production.

## 2. Changes Made

- `loadActiveOverlays` now receives `classifyMarketRegime(macro).regime`.
- `normalizeOverlayRegime` accepts either an enum or a persisted label.
- Overlay instructions are contained as `coach` and scanned in `untrustedPromptFields`.

Touched:

- `src/lib/overlay-router.ts`
- `src/lib/strategy.ts`
- `test/overlay-router.test.ts`
- This note, STATUS, PLAN, effort log

## 3. Decisions & Trade-offs

- Kept `currentMarketRegime = determineMarketRegime(macro)` for persisted labels.
- Did not add tags / side-tilt / a 10-template catalog in this hotfix.

## 4. Verification State

Targeted `overlay-router` tests, then `scripts/land.sh`.

## 5. Next Steps

Owner: enable overlays on Strategy if wanted.  Catalog extras from the architect note can wait.
