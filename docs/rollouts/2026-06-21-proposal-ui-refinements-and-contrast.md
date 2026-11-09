# 2026-06-21 - proposal-ui-refinements-and-contrast

## Summary

- Refined the proposed decisions cards inside the `DecisionView` component to show a custom bold, smaller `TEST` text label instead of a green `Chip` for paper test decisions.
- Plumbed connected account info (`Agentic x####`, `Brokerage x####`, `Paper x####` masking the account number suffix) to the top-left of each pending or latest decision proposal card.
- Integrated ticker logo rendering directly beside the ticker symbol inside the proposal cards.
- Hardened text contrast by setting the cost and share quantities to `text-fg font-medium` and the rationale descriptions to `text-fg/85` instead of the default `text-muted`.
- Customized the subtitle text for the Portfolio panel and Mobile portfolio summary components to explicitly show the broker and environment name (e.g., `Alpaca Paper Account` or `Robinhood Agentic Account`).

## Why

- Visual density and clarity: the user requested better contrast for hard-to-read text, clear mapping of which connected account is generating which proposal, broker/environment labeling on the portfolio, and rendering of company logos on proposal cards.

## Files

- `app/dashboard-client.tsx`
- `app/dashboard-types.ts`
- `src/lib/types.ts`
- `src/lib/db.ts`
- `src/lib/strategy.ts`

## Verification

- Checked type safety: `npx tsc --noEmit` (completed successfully)
- Executed unit tests: `npm test` (all 416 unit tests passed)
- Built production app: `npm run build` (completed successfully)

## Follow-ups

- None. All user requests in this tranche have been successfully fulfilled and verified.
