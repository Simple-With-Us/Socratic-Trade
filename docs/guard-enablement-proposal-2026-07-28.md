# Guard Enablement Proposal — 2026-07-28

**Status: PROPOSAL — nothing is enabled by this document.** Each guard below is listed
with its exact constraint behavior (verified in code on 2026-07-28, branch
`agent/antigravity/fix-mock-tests`), its escalation/override path, and a recommended
initial posture. **Approve, strike, or adjust each line; only approved lines get
implemented.** Philosophy honored throughout: the agent decides, rules bound mechanical
failure and inform judgment — they do not replace judgment.

**Correction to the 2026-07-28 fleet review:** the volatility panic brake is **already ON
by default** (`volPanicBrakeEnabled === false` is required to disable it,
`macro.ts:441`), not opt-in as the review stated. See row 8.

---

## The guards

### 1. Quote staleness gate — `maxQuoteAgeSec` (policy.ts:389-414)

- **Behavior:** BLOCK (opening orders only). An opening proposal whose quote is older
  than the threshold is rejected with `quote_staleness`. Exits (sell/cover) are **never**
  gated. A missing timestamp counts as stale when the gate is on.
- **In a crisis:** Prevents buying/selling-to-open off a minutes-old price while the
  market is moving fast. Cannot block the AI from *exiting* anything, ever.
- **Override:** Escalatable by design — a blocked opening routes to human review, and
  approval re-runs the gate against a **fresh** scan, so it self-heals without any
  setting change (policy.ts:401-402 comment).
- **Today:** OFF (threshold unset).
- **Recommended: ENABLE at 120s.** This bounds a mechanical failure (acting on corrupted
  inputs), not a decision.

### 2. Risk receipts — `tuning.riskReceipts` (strategy-risk.ts:317-413)

- **Behavior:** INFORM only. Appends per-proposal correlation and stress-scenario notes
  to the rationale (`[Risk] Correlation: max 78% w/ NVDA…`, `[Risk] Stress -8% (mkt):
  book -4.2% of equity; with this order -4.9%…`) plus audit rows. Changes no decision.
- **In a crisis:** The LLM and Red Team *see* book-level fragility and this order's
  marginal contribution — better situational awareness exactly when conditions are
  atypical.
- **Override:** N/A (nothing to override).
- **Today:** OFF.
- **Recommended: ENABLE.** Zero constraint, pure signal. Costs extra `fetchDailyOHLC`
  calls per opening proposal.

### 3. Vol-target sizing taper — `tuning.volTargeting` + `targetPortfolioVolPct` (strategy-risk.ts:516-543)

- **Behavior:** TAPER. Scales an opening order's size multiplier down (never up, floored
  at 0.25) when the symbol's realized vol exceeds the portfolio target. The vol number is
  appended to the rationale even when the taper is off.
- **In a crisis:** Positions in wild names come in smaller; the AI can still take any
  position it wants.
- **Override:** Per-run — the AI controls whether to propose at all; the taper only
  bounds size within the existing floor/ceiling clamps.
- **Today:** OFF.
- **Recommended: ENABLE with a generous target (25%).** At 25% it binds only in genuinely
  volatile names.

### 4. Portfolio heat taper — `tuning.volTargeting` + `portfolioHeatBudgetPct` (strategy-risk.ts:662-720)

- **Behavior:** TAPER. When the book's aggregate stop-basis risk plus this order's
  incremental risk would exceed the budget (% of equity), this order's size is tapered to
  the remaining budget. Heat note appended regardless.
- **In a crisis:** Stops the book from silently stacking total risk past a ceiling; never
  forbids a position.
- **Override:** Size-only; exits untouched.
- **Today:** OFF.
- **Recommended: ENABLE at 10% of equity** (owner-tunable; start loose, tighten on
  evidence).

### 5. Fractional Kelly sizing — `tuning.fractionalKellySizing` (strategy-risk.ts:557-599, kelly.ts)

- **Behavior:** TAPER (reduce-only). Even when on, Kelly can only *shrink* size vs
  today's multiplier, never increase it. When off, an informational receipt is still
  appended ("informational only, not applied").
- **Today:** OFF (receipt shows when the sample gate clears).
- **Recommended: KEEP SIZING OFF initially** — the receipt alone is useful signal;
  revisit after the eval harness can measure its effect on historical replay.

### 6. Negative-expectancy skip — `tuning.skipNegativeExpectancy` (strategy-risk.ts:216-246)

- **Behavior:** VETO. Skips an opening when its thesis has a **proven** negative
  post-cost edge (≥ `minClosedLotsForWeightShift` = 20 closed lots, shrunk avg return ≤
  threshold). Unproven theses and all exits are unaffected.
- **In a crisis:** Cannot fire without 20 closed lots of evidence, so it can't block
  novel responses to novel conditions — but it *is* a judgment veto (a statistically
  losing thesis might be exactly what a dislocation rewards).
- **Today:** OFF.
- **Recommended: KEEP OFF initially.** Strong candidate to enable after the eval harness
  (#1 in the fleet review) can prove it on replay.

### 7. Correlation cluster gate — `maxAvgCorrelation` (strategy-risk.ts:247-277)

- **Behavior:** VETO. Drops an opening whose average return-correlation with current
  holdings exceeds the cap (needs ≥20 samples per pair, correlation.ts:15).
- **In a crisis:** This is the guard most likely to fight the AI in a dislocation —
  correlated dips are sometimes the opportunity.
- **Today:** OFF (no cap set).
- **Recommended: KEEP OFF.** The correlation receipt (row 2) already puts the number in
  front of the LLM and Red Team; let them weigh it.

### 8. Drawdown / daily-loss breaker — `riskRules.maxDrawdownPct` / `maxDailyLossNotional` + `drawdownBreakerAction` (risk-breaker.ts, strategy.ts:649-697)

- **Behavior:** Two modes. **Advisory (default when limits set):** receipt + audit +
  the drawdown is injected into the strategist's prompt as decision context — the agent
  decides whether to de-risk. **Enforcement (opt-in `close_only`/`halt`):** flips
  systemState, blocks new entries, fires a kill-switch notification. Exits flow in all
  modes.
- **In a crisis:** Advisory mode informs without seizing control; enforcement mode stops
  the bleed but requires manual re-arm.
- **Today:** fully OFF (no limits set).
- **Recommended: SET LIMITS, KEEP ACTION "advisory"** — e.g. 15% trailing drawdown —
  so breaches become prompt context + audit. **Plus one small code change:** advisory
  mode currently sends no notification (only the enforcement branch does,
  strategy.ts:684-694) — add one, so a breach reaches you, not just the logs. Defer
  `close_only` enforcement until advisory data shows the thresholds are calibrated.

### 9. Volatility panic brake — VIX/VVIX/SKEW (macro.ts:436-459, strategy.ts:699-726)

- **Behavior:** STATE-FLIP. Any configured tail gauge at/above threshold flips the
  account to `close_only` + kill-switch notification; new entries stop, exits flow.
  Missing gauges are skipped (never false-trips). Defaults: VVIX 150, SKEW 160
  (defaults.ts:101-102).
- **Today:** **ON by default** (correction — the fleet review called this opt-in; it
  requires explicit `volPanicBrakeEnabled: false` to disable).
- **Recommended: KEEP ON.** It bounds mechanical tail exposure, not thesis judgment, and
  re-arming is one tap in Guardrails. Verify the VIX threshold value suits you.

### 10. Earnings blackout — `tuning.earningsBlackout` (strategy-risk.ts:278-316)

- **Behavior:** TAG (advisory). Within 7 days of earnings a rationale note is always
  appended; with the flag on, openings inside the window (default 3 days) get a
  `preVetoReasons` tag — which per the current tag-not-drop design flags for review
  rather than silently killing.
- **Today:** OFF (proximity note still appended within 7 days).
- **Recommended: KEEP OFF** (note-only). Earnings plays are a legitimate strategy; the
  tag already surfaces proximity.

### 11. Regime-flip trigger — event-driven run on regime change (strategy.ts:733-734; docs/event-driven-llm-triggering.md)

- **Behavior:** Not a guard — **adds** a close-only review run when the market regime
  flips, instead of waiting out the 60-min cadence. Increases responsiveness in atypical
  conditions.
- **Today:** deferred; the trigger engine is default-off.
- **Recommended: ENABLE when the trigger engine lands** (close-only review run on flip).
  Pro-flexibility: more agent attention in unusual markets, not less.

### Already on, no action needed

- **Conviction cap** (`convictionCapUncorroborated` default 0.6, strategy-risk.ts:502-507):
  AI confidence alone can't oversize a proven-but-mediocre thesis. ON by default.
- **ATR / beta-scaled stops** (defaults.ts:115-116): per-symbol stop distances, ON.
- **Broker-held brackets + trailing stops** (defaults.ts:103,108): ON (Alpaca).

---

## Summary table

| # | Guard | Type | Crisis behavior | Today | Recommendation |
|---|---|---|---|---|---|
| 1 | Quote staleness | Block (openings, self-healing) | Stops acting on bad data | OFF | **ENABLE 120s** |
| 2 | Risk receipts | Inform | Better crisis awareness | OFF | **ENABLE** |
| 3 | Vol-target taper | Taper | Smaller size in wild names | OFF | **ENABLE @ 25%** |
| 4 | Portfolio heat | Taper | Caps total book risk | OFF | **ENABLE @ 10%** |
| 5 | Fractional Kelly | Taper (reduce-only) | — | OFF | Keep sizing off; receipt only |
| 6 | Negative-expectancy skip | Veto (evidence-gated) | Can't fire on novel theses | OFF | Keep off → eval first |
| 7 | Correlation cluster gate | Veto | Could fight dislocation buys | OFF | Keep off; receipt covers it |
| 8 | Drawdown breaker | Inform or state-flip | Advisory informs; enforcement halts | OFF | **Set limits, advisory + notify** |
| 9 | Vol panic brake | State-flip → close_only | Stops new entries in panic | **ON** | Keep on |
| 10 | Earnings blackout | Tag | — | OFF | Keep off |
| 11 | Regime-flip trigger | Adds runs | More responsiveness | Deferred | Enable when engine lands |

**Net effect if all recommendations are approved:** the only *new* hard block is "don't
open on stale quotes" (self-healing). Everything else is tapers, information, or
notification. The two true vetoes (6, 7) stay off pending eval evidence. Nothing here can
stop the AI from exiting a position or responding to an unprecedented market — it only
bounds opening risk on bad data, caps aggregate mechanical exposure, and makes sure you
and the agent both *see* the risk state.

**Implementation note for whichever agent lands this:** approved rows go through
`scripts/land.sh` with the standard gates; each row is an independent PR-sized change
except rows 3+4 (one flag pair) and row 8 (limits + the advisory-notification patch).
