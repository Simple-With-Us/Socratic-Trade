# 2026-07-11 — Refactoring strategy.ts (AG, branch `agent/strategy-split`)

## Summary
The massive `strategy.ts` file was split into focused modules to improve maintainability and separate concerns. `strategy-risk.ts` now handles risk, veto gates, and sizing logic. `strategy-execution.ts` handles the main execution loop and broker order reconciliation.

## Why
`strategy.ts` had grown too large, mixing execution logic, risk controls, and helper utilities. This split creates a clearer architecture and paves the way for further improvements like options trading and margin support.

## Files Touched
- `src/lib/strategy.ts` (split and became a barrel for existing consumers)
- `src/lib/strategy-risk.ts` (NEW)
- `src/lib/strategy-execution.ts` (NEW)
- Over 100+ tests and route files where imports were updated programmatically via `ts-morph` script.

## Verification
- Local build checks passed.
- `tsc --noEmit` clean.
- `npm run lint` clean (0 errors).
- `npm test` all 3427 tests passed.
