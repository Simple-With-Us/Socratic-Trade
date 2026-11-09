# 2026-06-19: UI UX Polish and Consistency Fixes

## Summary
Addressed several user-reported UX inconsistencies and UI bugs across the dashboard, focusing on the Market Scan, Smart Money tables, and global Parameter inputs.

## Why
The user reported that:
1. The market scan was blank when the universe was 0 tickers. This actually surfaced a `500` error on the backend because `allowedSymbolsForPolicy` was crashing when an older policy had `includedIndices` as `undefined`. 
2. Congressional and insider trades were not clickable if the symbol wasn't already in the actively tracked universe.
3. The parameter inputs on the Strategy Tab were visually inconsistent (some were text-only, others were nested in grey cards).
4. The top header metrics were redundant (showing Portfolio and Buying Power again despite them being heavily featured on the left sidebar).
5. The Command Palette overlay was too dark (`bg-black/50`), and the global dark mode theme colors (`#070b11`) were too harsh, causing poor readability.
6. The "Additional Symbols" text input in Settings glitched out during typing/deleting due to an `onBlur` race condition firing when `draft` was an empty string `""`.
7. The "Included Indices" dropdown UX was clunky, and there was no UI to manage the existing `blocklist` policy array.

## Files
- `src/lib/policy.ts`
- `app/ui/dashboard/components.tsx`
- `app/dashboard-client.tsx`
- `app/globals.css`
- `app/ui/command-palette.tsx`
- `app/ui/dashboard/settings.tsx`

## Verification
- Ran `npx tsc --noEmit && npm run build` successfully.
- Ran `curl -s http://localhost:4102/api/scan | jq 'keys'` to confirm the API no longer crashes when scanning an empty universe.
- Navigated via Playwright to ensure `SymbolButton` and `NumberField` component changes rendered properly without hydration errors.
- Restarted PM2.

## Follow-ups
None.
