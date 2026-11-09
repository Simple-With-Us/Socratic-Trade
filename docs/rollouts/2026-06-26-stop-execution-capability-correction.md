# 2026-06-26 — Stop-execution: capability correction + roadmap (copy fix)

Branch `agent/claude-stop-execution`.

## Summary
Corrects a wrong claim in the Phase-3 Risk & Safety copy — "trailing stops are app-managed on every broker;
no broker holds them" — which conflated *broker capability* with *what this app emits*. Fixes the UI copy to
the verified reality. The actual stop-execution improvements (native Alpaca trailing, broker-held-by-default
fixed stops, app-managed fast-loop as fallback) are the follow-up build scoped below.

## Why
Owner pushed back (correctly) that brokers do support trailing stops and that a fixed % stop is a static
price that should rest at the broker 24/7 rather than be polled. We ran a diverse, adversarial verification
(84 agents, primary broker/API/MCP docs, 2 skeptics per claim — workflow `wf_e5bf1b0a-04d`).

## Verified capability matrix (integration-level, not just broker-level)
| Integration the app uses | resting stop-market | stop-limit | NATIVE trailing | bracket/OCO |
|---|---|---|---|---|
| **Alpaca REST/SDK** | ✅ native | ✅ | ✅ native (`trail_percent`/`trail_price`) — **app doesn't emit it** | ✅ (app emits brackets) |
| **Alpaca MCP** (as wired) | ✅ routed | ✅ | ❌ not routed (upstream unverified) | ✅ |
| **Robinhood MCP** (the app's RH path) | ✅ exposed | ✅ exposed | ❌ **MCP schema has no trail param** (2/2 refuted) | ❌ (RH has no brackets at all) |
| Test sim | app-simulated | sim | sim | sim |

Key nuances: native trailing is the COMMON case across brokers (Alpaca, Robinhood, Schwab, Fidelity, IBKR,
E*TRADE, Webull, Public) — the earlier "no broker holds them" was false. BUT for THIS app's two live
integrations: Alpaca supports native trailing yet the app never emits it (vocabulary gap — `OrderType` lacks
`trailing_stop`, and `mapAlpacaOrderType` even down-maps inbound trailing reads to `stop_market`); and the
official Robinhood Trading MCP exposes only `{market, limit, stop_market, stop_limit}` — no trail param — so
RH trailing must stay app-managed even though RH-the-brokerage supports it.

## What changed in THIS PR (copy only)
- `app/dashboard-client.tsx` Risk & Safety "Stops & exits": replaced the false "no broker holds trailing"
  line with the accurate statement — a fixed % stop is a static price that rests at the broker where the
  integration allows it; trailing is *currently* app-managed (brokers support it natively; the app doesn't
  emit native trailing yet; RH's MCP can't carry it). Tightened the per-broker summary so "fixed %" isn't
  listed as app-managed on brokers that rest it (Alpaca brackets).

## Roadmap (follow-up build — money-path, own reviewed PRs)
1. **Native Alpaca trailing** (tier 2): add `trailing_stop` to `OrderType` + `trailPercent`/`trailPrice` to
   `EquityOrderInput`; emit `trail_*` in `alpaca.ts`; fix `mapAlpacaOrderType` to round-trip honestly; place
   the native trailing order after entry (Alpaca only; single-order, regular-hours-only — mutually exclusive
   with a bracket stop on the same position). Test required (no fixture today).
2. **Fixed % stop = standing broker order by default** wherever the integration rests one: Alpaca already
   does (brackets ✅); Robinhood MCP `stop_market` — the `broker-protective-stops` mechanism exists but is
   gated off (`robinhoodBrokerStops:false`). Trigger it on fill; flip the default ON only after a LIVE
   `place_equity_order` confirms the accepted `stop_market` string + GTC handling (uncertain item).
3. **App-managed fast loop = fallback only** (Test sim, RH trailing): move fixed/ATR/beta stop-loss +
   take-profit-trim evaluation onto the 60s monitor tick (fresh price = broker quote + Massive real-time),
   but ONLY for positions whose stop is NOT broker-held — avoid double-exits with a resting broker stop.

## Verification
- `npx tsc --noEmit` clean; full build via `scripts/land.sh`.

## Open items (carried from the audit)
- Confirm RH MCP `stop_market`/GTC against a live account before enabling RH broker stops by default.
- Upstream Alpaca-MCP native trailing tool unverified (REST/SDK trailing is confirmed).
