# 2026-08-16 — Ticker desk sheet: lot, exits, other-account mention

## Context & Objective

Tapping a ticker should read like a desk blotter for that name, not only a quote card.  The web console drawer already had position economics, pending ideas, and scan research.  It did not show the persisted stop/take-profit plan, staged harvest bands, or that the same owner holds/shorts the name in another account.

## Changes Made

- `src/lib/symbol-desk.ts` + `GET /api/symbol-desk` — peer lots from the last portfolio snapshot (size + direction only), current-account exit contract, pending proposals.
- Web console drawer (desktop + phone widths): Exit Plan, Other Accounts (switch via `activateAccount`), Last desk call.
- iOS `SymbolInfoSheet` consumes the same `/api/symbol-desk` payload and resolves the current lot from the snapshot on a company-only tap.

## Decisions & Trade-offs

- V1 does **not** dump RAG corpora or full green/red debate transcripts.  Pending-proposal rationale is the honest abstract already stored on the idea.  Full debate stays on Approvals / the in-flight proposals-review lane.
- Other-account lots come from the last recorded portfolio snapshot, labeled as last-recorded — no extra live broker fan-out on every tap.
- Peer mention never includes average cost or P&L.
- **PWA is out of scope** (owner 2026-08-16).  Desk extras were removed from `MobileSymbolSheet`.  Clients are iOS + the website.  Did not steal `grok/ios-proposals-for-review`.

## Verification State

`npx vitest run test/symbol-desk.test.ts` plus the files' typecheck during land.

## Next Steps & Blockers

- V2: RAG abstract + last green/red case for the symbol.
- Owner still needs a post-#2692 TestFlight for native card tap + this sheet.
