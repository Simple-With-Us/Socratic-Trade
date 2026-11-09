# 2026-06-22 - Accounts tab: hide phantom Robinhood card + ACTIVE badge

## Summary

Two Accounts-tab UX fixes:

1. **No phantom disconnected Robinhood card.** The Robinhood MCP status card was
   rendered at the top of the Accounts tab *unconditionally* — so on the default
   setup (no Robinhood configured) it always showed a mostly non-functional
   "Not connected" card. It now renders only when Robinhood is actually in play:
   `mcpHealth.configured` (env adapter set) OR `mcpHealth.authenticated` OR a
   connected `robinhood` account exists. Otherwise it's hidden (the "Connect
   Robinhood Agentic Account" button stays available to start a connection).
2. **"ACTIVE" vs "Connected".** The account list badged only the active account
   and labeled it "CONNECTED" (misleading). Now the account the app is actually
   set on shows a green **ACTIVE** badge, and every other connected account shows
   a muted **Connected** badge — so it's clear which one is in use. Active is
   derived the same way as the rest of the app (`policy.connectedAccountId`, else
   the `isActive`-flagged row) for consistency. The AUTONOMOUS badge still rides
   on the active account in `decide` mode.

## Files

- `app/dashboard-client.tsx` — `IntegrationsSection`: `showRobinhoodCard` gate,
  `activeId` derivation, ACTIVE/Connected badge logic.
- `STATUS.md`, this rollout note.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- UI-only change (no unit test covers this view); CI runs the full suite.

## Notes / follow-ups

- The persistent **Robinhood MCP health card** is now scoped to relevant cases;
  the three "Connect …" action buttons are unchanged so connecting is still
  one click.
- Deploy verification for the prior batch (PR #98): Deploy run #16 succeeded on
  the latest `main`; `socratictrade.com` returns HTTP 302 (auth gate) = live.
