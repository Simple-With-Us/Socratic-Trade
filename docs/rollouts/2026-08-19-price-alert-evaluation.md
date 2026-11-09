# Price alert evaluation — user-scoped quotes, no silent failure

## Context & Objective

Part II cluster `price-alert-evaluation` from `docs/reviews/2026-08-18-full-app-expert-review.md`.  Price alerts stopped evaluating when the console-active account had no `accountNumber`, swallowed broker errors, ignored quote staleness, and validated symbols with a looser regex than the rest of the app.

## Changes Made

- `checkPriceAlerts` now fetches quotes via user-scoped `fetchFreshQuotesCascade(symbols, userId)` instead of `gateway.getEquityQuotes` on the active account.
- Cascade failures are logged and audited as `alert.check_error` instead of returning silently.
- Per-alert evaluation skips stale or missing quotes using `quoteAgeSecForStalenessGate` and `policy.maxQuoteAgeSec` (same formula as `policy.ts`).
- `createAlert` uses shared `isValidAppSymbol` instead of local `SYMBOL_RE`.

**Files touched:**
- `src/lib/alerts.ts`
- `test/price-alerts-evaluation.test.ts`

## Decisions & Trade-offs

- Did not take on `alert-push-delivery` (triggered-before-send, deep links) — deferred P2.
- Cascade is heavier than a single-broker quote call; acceptable on the existing scheduler cadence and matches approval/strategy paths.
- `isValidAppSymbol` allows digit-containing tickers the old regex rejected; rejects leading/trailing/double dots the old regex allowed.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/price-alerts-evaluation.test.ts test/watchlist-alerts.test.ts
npm run build
```

All commands run clean in the Cloud VM.

## Next Steps & Blockers

- Merge PR; no deploy action beyond auto-deploy on `main`.
- Follow-up cluster `quote-value-provenance` addresses fabricated `asOf` timestamps upstream in the cascade.

## Zero-Code Findings

None — code change only.
