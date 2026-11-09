# 2026-06-22 — Risk gates, shorting enablement & execution hardening (CORE)

One of three sibling PRs landing the verified-actionable items from Antigravity's strategy critique
(see `docs/rollouts/2026-06-22-learning-loop-hardening.md` and
`docs/rollouts/2026-06-22-tradingview-trigger-wiring.md` for the other two). This is the CORE slice:
the proposal/gate/execution risk core.

## Summary

- **Shorting enablement (default OFF, capability-gated).** The Bull/Bear proposal JSON-schema side
  enum and both system prompts now include `short`/`cover` **only** when `policy.shortSellingEnabled`
  is true AND the connected account reports `capabilities.shortSelling` — computed by the new exported
  `allowedProposalSides(policy, account)` (`strategy.ts`). Mirrors the existing two-layer execution
  gate in `policy.ts`, so the model can never surface a side the gate would reject. Default behavior
  is unchanged (long-only) until the user opts in on a short-capable broker (e.g. Alpaca).
- **`maxPortfolioBeta` cap.** New deterministic gate in `evaluateTradeProposal` (`policy.ts`) bounds
  the projected **net** portfolio beta (Σ signed marketValue·beta ÷ equity, candidate included). Blocks
  an opening order only when it pushes |projected beta| both past the cap and further from the current
  level (a beta-reducing trade always passes). Per-name beta from the scan; unknown betas count as 1.0.
  Default off; especially relevant now that shorting can be enabled. Exposed in Settings.
- **Entry-drift guard.** `evaluateTradeProposal` rejects a stale **opening market/dollar** order whose
  price has drifted more than `policy.maxEntryDriftPct` from the recorded entry anchor
  (`TradeProposal.referencePrice`, stamped at proposal time by `enrichOpeningProposal`). Limit orders
  are excluded (the broker's limit already caps the fill). Closes the gap where an hours-old market
  order approved off the run cadence (or with no LLM revalidation key) executed at a materially worse
  price. Default 10% (in `DEFAULT_POLICY`); exposed in Settings.
- **Model-free fundamentals hard-veto.** `deterministicBearFilter` (the LLM-independent pre-filter)
  gained an FCF-yield-floor / debt-to-equity-ceiling veto on buys (`tuning.bearVetoFcfYieldFloorPct`,
  `tuning.bearVetoDebtToEquityCeiling`). Both data points are already on `MarketQuote` (Yahoo, no key).
  Skipped when the threshold is unset or the field is unavailable, so it never false-vetoes. Off by
  default; exposed in Settings → tuning. Catches cash-burning / over-levered longs regardless of what
  the same-family Bull/Bear LLMs agree on.
- **Broker-held brackets.** `enrichOpeningProposal` attaches native stop-loss / take-profit (OCO) legs
  to opening orders on brokers with native bracket support (Alpaca) — derived from
  `riskRules.stopLossPct`/`takeProfitPct` (long: stop below / take above; short: inverted). Protective
  exits now rest at the broker's matching engine and survive local downtime; the synthetic
  scheduler-tick monitor remains the fallback for non-bracket brokers. `policy.brokerBracketsEnabled`
  defaults ON (treats undefined as true); toggle in Settings.
- **Beta-scaled stops.** New exported `betaScaledStopPct(base, beta, enabled)` widens stops for
  high-beta names (clamped ≤2×) and tightens for low-beta (≥0.5×), applied in the gate
  (`riskRuleReason`) and the proactive risk-exit generator. `policy.betaScaledStops` default off.
- **Dead-code removal.** Deleted the never-referenced `RiskRules.stopLossAtrMultiple` field.

New policy/tuning fields are validated in `app/api/policy/route.ts`; Settings UI controls added to
`app/dashboard-client.tsx`.

## Why

These are the items I verified as genuinely actionable in Antigravity's critique once re-scoped to the
app's real posture (multi-user, real sizes, shorting in scope — not a $10 paper-only toy). The
broker-bracket and entry-drift items are correctness/safety wins; the rest are guardrails that mostly
matter once sizing grows or shorting is enabled, so they default off/neutral and are user-tunable.

## Files

- `src/lib/types.ts` — `TradingPolicy.maxPortfolioBeta/maxEntryDriftPct/brokerBracketsEnabled/betaScaledStops`; `TradeProposal.referencePrice`; `TuningSettings.bearVetoFcfYieldFloorPct/bearVetoDebtToEquityCeiling`; removed `RiskRules.stopLossAtrMultiple`.
- `src/lib/policy.ts` — entry-drift guard, portfolio-beta cap, beta-scaled stops in `riskRuleReason`, exported `betaScaledStopPct`.
- `src/lib/strategy.ts` — `allowedProposalSides`, shorting in schema+prompts, FCF/leverage veto in `deterministicBearFilter`, `enrichOpeningProposal` (referencePrice + brackets), beta-scaled proactive exits.
- `src/lib/defaults.ts` — `maxEntryDriftPct: 10`, `brokerBracketsEnabled: true`.
- `src/lib/execution-mode.ts` — `ExecutionAccount` now includes `capabilities` (needed for the short-capability check).
- `app/api/policy/route.ts` — validation for the new fields.
- `app/dashboard-client.tsx` — Settings controls (shorting toggle, beta cap, entry-drift, broker brackets, beta stops, FCF/leverage veto).
- `test/strategy-hardening.test.ts` — **new**, 31 tests.

## Verification

```
npx tsc --noEmit   # clean
npx vitest run     # 92 files, 838 tests, all pass
npm run build      # green
```

## Follow-ups (deliberately deferred)

- **Marketable-limit entries** — conflicts with the dollar-notional routing (sized orders are
  `dollarAmount` market orders; brokers don't cleanly support dollar-based limit orders). Needs the
  sizer to optionally route notional via a bid/ask-derived quantity before this can be done cleanly.
- **True ATR/volatility stops** — needs an OHLC bar-history feed the app does not yet ingest (only
  delayed quotes). The beta-scaled approximation here is the no-new-data interim.
- **Beta-scaling the synthetic trailing stop** — would require threading beta through `scheduler.ts`
  into `synthetic-stops.ts`; left flat for now (the gate + proactive-exit sites are covered).

## Process note

Built across three isolated worktrees off `origin/main` with parallel sub-agents (CORE authored
directly; LEARN and TRIG delegated). All three delegated agents independently and spuriously reverted
the unrelated `feat/robinhood-data-consent-pool` feature while "fixing" their suites — caught in review
and restored on every branch before commit. The TRIG agent's `npm run build` also surfaced a Next.js
rule (`route.ts` may only export route handlers) that tsc+vitest missed; fixed by moving the helper to
`src/lib/tradingview-trigger.ts`.
