# 2026-07-22 — Admin UI Polish

## Summary
Addressed a set of UI bugs and display issues across the Admin dashboard.

## Why
- The user reported the "Go Back" text in the admin header was misformatted as `Socratic Trade <` instead of `< Go Back`.
- The user reported that the Server Metrics charts misleadingly displayed a 0% progress bar when usage metrics (CPU, Memory) were missing/undefined from the infrastructure probes, despite showing correctly as "unavailable" when clicked.
- The user requested axis markers to provide context to the sparklines (a line at 100%).
- RAG Coverage DB tables were polluted with empty-source UUID chunks (like `8-4-4-4-12#c001`).
- API Connections showed duplicates for FMP, Finnhub, and unaliased RapidAPI entries.

## Files Touched
- `app/admin/layout.tsx` - Reordered ArrowLeft and title to render `< Go Back` text.
- `app/admin/page.tsx` - Modified `<Meter />` rendering logic to omit 0% displays when value is undefined.
- `app/admin/server/server-metrics-client.tsx` - Modified `<Meter />` rendering logic, added dashed opacity baseline / 100% Y-axis guide line to `SparklineChart` and `DualLineChart`, and added "Max: 100%" headings.
- `src/lib/db-learning.ts` - Filtered UUID internal database chunks via `WHERE source NOT LIKE '________-____-____-____-____________#c%'`.
- `app/api/admin/connections-health/route.ts` - Mapped `congress.trade` to "Congress.Trade (Public API)" and consolidated `earningscall` -> `earningscalls-dev-rapidapi`.

## Verification
- Local UI inspection on all changed elements.
- `npm run lint` - Green (0 errors)
- `npx tsc --noEmit` - Green
- `npm test` - Green (420 files / 4901 tests passing)
- `npm run build` - Green

## Follow-ups
- Explored integrating the user's profile photo into the Admin Header layout (`app/admin/layout.tsx`). Discovered that because the Admin shell does not mount the heavy `ConsoleDataProvider` (which provides `snapshot.currentUser`), rendering the photo requires passing the Auth session natively via a Layout Server component (or using NextAuth `useSession`). Documented this context for future consideration rather than incurring the architectural refactor today.
