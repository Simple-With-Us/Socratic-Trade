# Revert Accidental Market Scan Addition to from-draft Route

## Context & Objective
While adding EOD historical bar syncing and flat file persistence in a previous commit, I inadvertently added a `fetchFreshQuotesCascade` call to the preview evaluation step in `app/api/proposals/from-draft/route.ts`. 

The preview route is explicitly designed to be scan-less because the authoritative gate (including the staleness check) runs during `executeProposal` with fresh market data at approval time. This unintended addition caused the draft preview to fetch a live quote during evaluation, breaking `test/chat-draft-policy.test.ts` (which relies on `staleness_gate` being tripped during the scan-less preview and asserting that drafts can still stage despite staleness blocks).

## Changes Made
- Removed the `marketScan` creation block and `fetchFreshQuotesCascade` call from `app/api/proposals/from-draft/route.ts`.

## Decisions & Trade-offs
Reverting this ensures that draft previews return to their expected "scan-less" behavior. Sizing is unaffected because `reviewEquityOrder` (which uses a minimal fallback quote or live quote) is still invoked separately just prior to `evaluateTradeProposal`.

## Verification State
- `npm run lint` - pass
- `npx tsc --noEmit` - pass
- `npm test test/chat-draft-policy.test.ts` - pass
- `npm run build` - pending validation

## Next Steps & Blockers
None. This unblocks the current test regressions and allows landing the PR.
