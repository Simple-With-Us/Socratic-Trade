# 2026-07-10 — Reviewed-by-model proposal stamp (AG, branch `agent/antigravity-reviewed-by-model`)

## Summary
Added a `reviewedByModel` stamp on trade proposals to durably attribute the model that acted as the Red Team / Reviewer for each proposal, and integrated this data into the model stats UI to report Reviewer-role realized performance.

## Why
When evaluating which LLM models are most effective, we need to distinguish their performance not just by who proposed the trade (the Green Team / Bull / Proposer) but also by who reviewed it (the Red Team / Bear / Reviewer / Strategist). Previously, `proposedByModel` attributed the proposer, but the reviewer model was only known at runtime or in separate audit logs. By stamping `reviewedByModel` directly on the proposal and threading it through into the P&L lots (`ClosedLot`), we can aggregate symmetrical performance statistics for the Red role in the `Model Stats` drawer.

## Files
- `src/lib/types.ts`
- `src/lib/performance.ts`
- `src/lib/strategy.ts`
- `src/lib/model-stats.ts`
- `app/api/llm-usage/model-stats/route.ts`
- `test/model-stats.test.ts`

## Verification
- `npx tsc --noEmit` clean
- `npm run lint` 0 errors
- `npm test` all tests passed
- `npm run build` clean

## Follow-ups
None immediately. This task is complete and ready for deployment.
