# Mobile API and Clients

Goal: make phones first-class control surfaces without moving trading authority,
provider secrets, scraping, calculations, or MCP orchestration onto the device.

## Architecture

- **Backend is source of truth.** The web dashboard, phone PWA, and SwiftUI app all
  read account state from the backend and submit audited commands to the backend.
- **One command model.** Both clients use `/api/mobile/commands`; command rows are
  validated, queued, audited, executed server-side, and exposed by status.
- **Thin clients.** The PWA and SwiftUI app render state, collect explicit user
  confirmation, and subscribe to command/status updates. They do not hold broker
  credentials, provider keys, MCP tokens, or scraping logic.
- **MCP behind the backend.** Any broker/MCP operation remains a backend concern.
  The mobile API never exposes MCP as the phone protocol.
- **Realtime updates.** Clients can use `/api/mobile/events` SSE for command
  changes and dashboard freshness events, with polling as a fallback.

## Endpoints

- `GET /api/mobile/bootstrap` returns the control catalog, readiness summary, and
  recent commands for a fast app launch.
- `GET /api/mobile/snapshot` returns the full mobile-readable dashboard snapshot:
  current user, readiness, policy summary, portfolio, positions, proposals,
  connected accounts, watchlist, alerts, and recent commands.
- `GET /api/mobile/commands?status=&limit=` lists command history for the
  authenticated user only.
- `POST /api/mobile/commands` queues one validated command. The request may supply
  an `Idempotency-Key` header so retries do not double-submit.
- `GET /api/mobile/commands/:id` fetches one command, scoped to the authenticated
  user.
- `GET /api/mobile/events` streams `mobile.command` plus dashboard events.
- `POST /api/mobile/account-deletion/request` starts a short-lived, multi-step
  deletion request.
- `POST /api/mobile/account-deletion/confirm` confirms deletion with the request
  id, signed-in email/user id, and exact required phrase.

## Commands

Supported mobile commands are intentionally explicit:

- `strategy.run_once`
- `strategy.start`
- `strategy.stop`
- `strategy.close_only`
- `strategy.liquidating`
- `proposal.approve`
- `proposal.reject`
- `account.activate`
- `watchlist.add`
- `watchlist.remove`
- `alert.create`
- `alert.delete`
- `policy.patch`
- `consent.set`
- `notification.test`

High-risk fields are guarded at the gateway. For example, `policy.patch` cannot
change account ownership, selected broker account, legacy paper/live fields, or
secrets; live proposal approval text is accepted only for execution and redacted
from public command payloads.

## Account Deletion Procedure

The deletion flow is deliberately multi-step and should be shown the same way in
the PWA and SwiftUI app:

1. User opens the danger-zone flow and starts a deletion request.
2. Backend returns a short-lived `requestId`, expiry, signed-in email/user id,
   exact required phrase, and ordered warning steps.
3. Client shows the warning that backend account data, broker connections,
   provider keys, proposals, fills, watchlists, alerts, and learned context will
   be deleted for this app user.
4. User must type the signed-in email or app user id exactly.
5. User must type `DELETE MY AGENTIC TRADING ACCOUNT` exactly.
6. Client posts `requestId`, `typedIdentity`, and `typedText` to confirm.
7. Backend deletes user-scoped app records and server-stored secrets, clears
   scoped OAuth state rows, returns `/logout`, and the client signs out.
8. If the user later signs in with the same Google or Apple identity, the app
   creates a fresh backend account because the prior app-side data is gone.
9. Provider-side OAuth grants are separate. The client should tell the user to
   revoke the app in Google or Apple account security settings if they also want
   the provider-side connection removed.

## PWA

`/mobile` is the phone-first Next.js/PWA control surface. It uses normal page
scrolling, stable touch targets, clear command buttons, readiness metrics,
approval cards, watchlist and alert tools, command history, and the shared
account-deletion flow. The route is installed through `app/manifest.ts` with
standalone display and app icons.

## SwiftUI iPhone App

The files in `ios/SocraticTrade/` model the same backend contract:

- `MobileAPIClient` reads snapshots, queues commands, listens to SSE events,
  calls account deletion endpoints, and (session-cookie) reads Coach, Scan,
  full policy, and Settings data-source knobs.
- `MobileStore` keeps app state and refreshes from the backend.
- `MobileControlView` renders the native desk: Home, Proposals, Assets,
  Activity, Insights, Coach, Scan, Guardrails, Results, plus More.

The iOS app should use `ASWebAuthenticationSession` or system browser login for
the backend session and store only the resulting session token/cookie in Keychain
or the system cookie store.

## Verification

Before landing mobile API/client changes, run:

- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- Browser visual pass for `/mobile` at small phone, standard phone, tablet, and
  desktop widths.
