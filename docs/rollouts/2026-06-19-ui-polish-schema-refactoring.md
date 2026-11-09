# 2026-06-19: UI Polish & Policy Schema Refactoring

## Summary
Refactored `TradingPolicy` schema to better handle optional fields (notional vs percent of NAV). Addressed TS compilation failures related to optional policy fields, cleaned up overlapping settings panels in the dashboard, and improved the "Universe" selection UX to allow for composite universes (e.g. S&P 500 AND custom symbols).

## Why
- The user requested that we clean up the dashboard UI where Strategy settings were duplicated between the Strategy tab and Settings pop-up.
- The user requested support for selecting a base index (like S&P 500) and adding custom custom symbols on top of it.
- Replaced the "0 tickers" language with "TBD" for better UX.
- Build errors (`TS2322`, `TS18048`) had broken the frontend after recent schema modifications related to switching parameters between absolute $ and relative %.

## Files Touched
- `src/lib/types.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-tuning.ts`
- `app/dashboard-client.tsx`
- `app/ui/dashboard/settings.tsx`
- `app/ui/dashboard/views.tsx`
- `app/ui/dashboard/components.tsx`

## Verification
- Clean run of `npx tsc --noEmit && npm run build` (compiled successfully with 0 errors).
- UI successfully verified through code inspection:
  - `EditableParam` now supports robust `$/%` toggle logic.
  - Universe UI reads "TBD" if 0 tickers are selected, or "Base Index + X custom tickers" (e.g. S&P 500 + 1 custom) if a composite is active.
  - Duplicate Strategy sliders were removed from the StrategyStudio, centralizing them in the Strategy tab.

## Follow-ups
- Check if additional indices (like Nasdaq 100) should be populated with symbols (right now `IndexUniverse` supports `nasdaq100` and `russell2000` via type but lacks the arrays).
- Phase 11 multi-broker: Add separate manage account buttons for Alpaca once it is fully onboarded.
