# iOS full desk (Coach, Scan, Guardrails, Results, Data Sources)

Date: 2026-08-13
Branch: `grok/st-ios-full-desk`
Agent: GROK

## Why

The native app was still a command remote.  Owner asked for more desk parity
so the phone can be the full desk: a real Coach conversation, a scan table,
full guardrails, read-only results/receipts, and Settings data-source knobs
the server already exposes.

## Surfaces

New More destinations (pinnable, not default-pinned):

- **Coach** — `GET /api/chat-history`, `POST /api/chat`, `GET /api/chat/providers`
- **Scan** — `GET /api/scan` plus existing `watchlist.add` / `watchlist.remove`
- **Guardrails** — snapshot policy + `GET /api/policy`; tighten-only `policy.patch`
- **Results** — snapshot P&L / benchmark / fill receipts (tax-relevant, not advice)

Settings also hosts **Data Sources** via `GET/PATCH /api/settings/source-features`.

No new mobile command types.  Session-cookie auth only.  Keepouts: #2687 #2689
#2691 #2692 untouched.

## Copy / chrome

Light default already forced.  Title Case nav and buttons.  Sentence-case
values.  Two spaces after sentences.  Inline nav titles.  Autopilot stays
authority; Running / Paused stays run state.

## Verify

- `xcodebuild … test`
- focused vitest on AASA
- `npx tsc --noEmit` if TS was touched
