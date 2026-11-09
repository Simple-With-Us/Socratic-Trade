# 2026-06-25 — Audit: sell mechanisms, stop types × broker support, settings interactions

Reference note (no code change in this file). Findings from a multi-agent audit
(workflow `wf_5a9d6a6c-051`) of `main`, with an adversarial verify pass (both verifications returned
`overallTrustworthy: true`; only minor citation nits). Drives the program in
`docs/settings-and-universe-overhaul-plan.md`.

## Sell-decision mechanisms

**Structural / mathematical (no LLM):**
1. Proactive fixed-% stop-loss (long) — `returnPct ≤ −stopLossPct` (default 8%) → full market SELL. Beta-scaled if `betaScaledStops`. (`strategy.ts:2380`)
2. Proactive take-profit (long) — `returnPct ≥ takeProfitPct` (default 20%) → SELL **full position** (labeled "trim" — being fixed in Phase 2). Flat, not beta-scaled.
3. Proactive short stop / take-profit → COVER (only when `shortSellingEnabled`).
4. Synthetic trailing stop — app monitor ~60s tick, high/low-watermark, `trailingStopPct` (default 0 = off). Broker-agnostic. (`synthetic-stops.ts`)
5. Drawdown / daily-loss circuit breaker → `close_only` + kill-switch. (`risk-breaker.ts`)
6. Volatility panic brake (VIX/VVIX/SKEW) → `close_only`. **On by default.** (`macro.ts`)
7. System-state gate (`halted`/`close_only`/`liquidating`) — permits exits, blocks entries.
8. **No time-based / max-holding exit exists.**

**LLM:** prompt (`strategy.ts:1552-1555`) instructs SELL/TRIM when a position exceeds `maxSymbolExposurePct`, is down > `stopLossPct` "without a clear catalyst", is up > `takeProfitPct`, or to rebalance. Structural exits run first; **no dedup** with LLM sells (same name can get both).

## Stop type × broker support matrix

| Stop type | Alpaca | Robinhood | Test/Paper | Survives app offline? |
|---|---|---|---|---|
| Fixed %/price stop | app-managed exit **+ native bracket stop-leg** | app-managed **+ opt-in** broker-held stop-market | app-managed only | Alpaca / RH(opt-in) only |
| Take-profit %/$ | app-managed **+ bracket TP-leg** | app-managed | app-managed | Alpaca only |
| **Trailing (%/$)** | **app-managed ONLY** | **app-managed ONLY** | **app-managed ONLY** | **never** — needs app running |
| Beta-adjusted | app-managed (× clamped beta 0.5–2.0) | same | same | as fixed |
| Bracket (OCO) | **native** | not supported (note only) | ignored | Alpaca only |
| Broker protective stop-market | n/a | opt-in, live only | n/a | RH only |
| **ATR / true-volatility** | **not in `main`** (deferred — no OHLC feed) | — | — | — |

Order-type primitives: `market | limit | stop_market | stop_limit` (no native trailing/bracket TYPE).
Beta-scaling is a multiplier on the % stop, not a competing mode; %-stop and notional-stop are independent.

## Settings interactions / mutual-exclusivity (verified)
- `$⇄%` toggle is **destructive** in the UI (clears the other variant) though the engine honors `min($,%)`.
- Beta-scaling silently replaces the displayed % stop with `% × clamped beta`.
- ~17 enforced settings have **no UI**: drawdown/daily-loss breaker, vol-panic brake, gross/net caps
  (silent 80% → ~20% cash buffer), short sub-limits (so enabling shorting leaves every short rejected
  without `shortStopLossPct`), `trailingStopPct`, `permitExtendedHours`, `permittedOrderTypes`,
  `maxOrderPctOfAdv`, `marketableLimitEntries`, `allowExtendedHoursSyntheticStops`.
- Dangling help text references a "separate order permission" control that doesn't exist.
- Brackets gated on `stopLossPct>0` (+ Alpaca), not the "Broker-held brackets" switch.
- Dynamic-index universes widen the tradable set beyond the explicit allowlist; blocklist is opening-only.
- Stale comment: `policy.ts` says gross/net default "100% (non-binding)"; `defaults.ts` actually sets 80.

## Follow-ups
Addressed across Phases 1–4 of `docs/settings-and-universe-overhaul-plan.md`.
