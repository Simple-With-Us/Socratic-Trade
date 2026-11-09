# 2026-08-07 — iOS UI title-case headings / sentence-case values

## Owner copy rules
- **Headings, titles, buttons**: Title Case (Agent Controls, Run Once, Win Rate, Needs Attention, Review N Proposals, Current Policy, Connected Accounts, User Info, Delete Account, Last Run).
- **Values / answers**: sentence or lower case (not reported, ask-first, intraday, not scheduled, every 60 min, open holdings, account return minus…).
- **No "Live" callouts** on accounts (all accounts are real money); paper only as `Broker (paper)`.
- Drop redundant **Paper account** under Open P&L (PAPER pill + account name already enough).
- Positions tile: large count with **open holdings** trailing on the same row.

## Files
- `ios/SocraticTrade/AppComponents.swift` — format helpers + MetricTile trailing detail
- `ios/SocraticTrade/HomeView.swift` — Home / settings copy
- `ios/SocraticTrade/InsightsView.swift`, `ActivityView.swift` — Run Once / Last Run

## Follow-up (same PR / branch)

- Always `.inline` nav titles (small centered) on Home, Proposals, Assets, Activity, Insights.
- Tab **Markets → Assets** (same chart icon); remove U.S. Equities session card.
- Status banner: `arrow.triangle.2.circlepath` + **Market Closed** / **Market Open** (all tabs via SnapshotScaffold).
- Bell alert button always opens composer (was disabled when snapshot stale → looked dead).
- Order types: `stop_market` → **Stop Market**.
- Price Alerts / Orders title-case; empty alert message no trailing period.
- Insights: Portfolio Brief; Backend Remains Authoritative; vs SPY; Daily Opening Notional: N% used; N pending proposals.

## Money + logos (2026-08-07)

- Compact money suffixes lowercase: `$99.8k`, `$1.2m`, `$3.4b`.
- iOS Home equity + Portfolio tiles use **full** currency (not compact).
- iOS `TickerLogo` (ticker-icons + monogram fallback) on Assets positions/orders/watchlist/alerts, Activity fills, Proposals.
- Web: re-enabled logos on all `SymbolButton` call sites that had `showLogo={false}` (watchlist, alerts, activity, results, lessons, etc.).
