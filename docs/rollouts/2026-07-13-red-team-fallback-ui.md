# Red Team Fallback logic, UI Updates, and Episodic Memory Defensive Fix

## Summary
Implemented a robust failover capability for the Red Team model, improved the Settings UI for fallback models, and resolved an episodic memory retrieval crash.

## Why
1. The Red Team model previously did not have fallback options, so it would fail if the primary model experienced transient errors. The user also wanted "fancier" text boxes for the model fallbacks to easily toggle options from the catalog without typing manually.
2. In production runs, the strategy execution failed with `TypeError: a.filter is not a function` during the episodic memory retrieval phase when the `injected` array was undefined or null (e.g., during specific mock tests or cached retrieval mismatches).

## Files
- `src/lib/types.ts`
- `app/api/policy/route.ts`
- `src/lib/red-team.ts`
- `app/console/strategy/page.tsx`
- `src/lib/strategy.ts`

## Verification
- `npm run lint` (passed, fixed 1 error regarding `useRef` access during render)
- `npx tsc --noEmit` (passed)
- `npm test` (passed, all 3934 unit tests pass successfully)
- `npm run build` (passed, Next.js build completed successfully)

## Follow-ups
None.
