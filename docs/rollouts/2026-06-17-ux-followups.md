# 2026-06-17 - ux-followups

## Summary

Three user-requested UX follow-ups on branch `web-sources`. Paper mode unchanged.
`tsc` clean, 121 tests, build ok; browser-verified.

1. **Consistent proposal sizing display.** Pending/decision proposals showed an
   inconsistent mix of "$63.93" (dollar orders) and "0.4 sh" (quantity orders).
   `proposalSize(proposal, estimatedNotional?)` now always presents a **total
   dollar figure**; quantity/price-derived totals are marked **"(est)"** (from the
   broker review's `estimatedNotional`, or `quantity × limitPrice`) because the
   fill price can differ. Both the Pending-approval and Latest-decisions cards pass
   the estimate and carry an explanatory hover tooltip.

2. **Holding-horizon setting.** New `policy.holdingHorizon`
   (`intraday | swing | position | longterm`, default `swing`) in **Settings →
   Operate** ("How long you plan to hold most new positions"). It's fed to the
   agent as an explicit prompt directive (`HOLDING_HORIZON_GUIDE`) that shapes
   setup selection, exit timing, and tax awareness (long-term favors holding past
   the 1-year line). Validated in the policy route.

3. **More hover tooltips.** Added explanatory `title` tooltips to the header status
   pills (Portfolio, Buying power, Universe), the Performance stat tiles (Realized,
   Unrealized, Win rate, Avg return — via a new `StatTile title` prop), and the
   proposal size. (Scan column headers, rating/sentiment cells, and rationale
   already had them.)

## Files

- `app/dashboard-client.tsx` (proposalSize + tooltips + holding-horizon selector +
  StatusPill title), `app/ui/primitives.tsx` (`StatTile.title`),
  `src/lib/types.ts` (`HoldingHorizon`, `TradingPolicy.holdingHorizon`),
  `src/lib/defaults.ts` (default `swing`), `src/lib/strategy.ts`
  (`HOLDING_HORIZON_GUIDE` + prompt injection), `app/api/policy/route.ts`
  (validation).

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 121 passed
npm run build      # succeeds
```

Browser: header/perf tooltips render; Settings → Operate shows the 4 holding-horizon
options; policy persists `holdingHorizon`.

## Follow-ups

- Extend tooltips to the Decision/Tax chips and scorecard bars if desired.
- Surface the chosen holding horizon as a small chip near the strategy status.
