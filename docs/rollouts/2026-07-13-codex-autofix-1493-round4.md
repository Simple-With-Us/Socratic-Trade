# Codex Autofix Round 4 — PR #1493

**Date:** 2026-07-13
**Branch:** `ag/troubleshoot-sentry`
**PR:** #1493 — Add clearCache option to admin reindex endpoint

## Summary

Addressed the remaining P2 Codex finding from commit `516e9dcf3a`: the `hasRealField` emptiness guard in `ingestFundamentalsCard` only checked 6 of the ~22 fields that `buildFundamentalsContext` renders, so a provider returning only `debtToEquity` (for example with `SEC_XBRL_ENRICHMENT_ENABLED=on` and paid/Yahoo tiers absent) would incorrectly skip the card.

## Change

**File:** `src/lib/web-sources/sec-filings.ts` (function `ingestFundamentalsCard`)

The `hasRealField` check was expanded from 6 fields (`companyName`, `sector`, `industry`, `peRatio`, `eps`, `price`) to ALL 22 fields that `buildFundamentalsContext` renders:
- `companyName`, `sector`, `industry`, `price`, `peRatio`, `pbRatio`, `eps`
- `fcfYield`, `debtToEquity`, `returnOnEquity`, `returnOnAssets`, `grossProfitMargin`
- `freeCashFlowYield`, `revenueGrowth`, `epsGrowth`, `shortPercentOfFloat`
- `analystRating`, `analystScore`, `daysToEarnings`, `institutionOwnershipPct`
- `dividendYield`, `beta`

This ensures a card with any single real metric (like only `debtToEquity` from SEC XBRL) is not dropped.

## Verification

```
npm run lint         → 0 errors
npm run build        → compiled successfully, no errors
npm test             → 350 files / 3930 tests passed
npm run build        → compiled successfully, no errors (re-checked after test)
```

## Files Touched

- `src/lib/web-sources/sec-filings.ts` — expanded `hasRealField` check to cover all card-rendered fields
- `STATUS.md` — added round 4 entry
- `docs/rollouts/2026-07-13-codex-autofix-1493-round4.md` — this note

## Resolved Threads

One remaining P2 thread from the latest Codex review resolved:
- "Recognize all rendered metrics before skipping cards"
