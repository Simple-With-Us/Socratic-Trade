# Capability-aware trading roadmap — margin, shorting, options, PDT, Tradier

Owner-directed program (2026-07-10) to make the app understand and use, per broker
and per account, **margin/leverage**, **shorting**, **options trading**, and
**day-trading (PDT) rules** — all capability-gated. This doc is the durable record
of the verified facts, the current-state survey, the owner's scope decisions, and
the phased plan. Two read-only scoping workflows + two build workflows produced it;
keep it current as phases land.

## Verified regulatory facts (day-trading / PDT / margin)

Researched against primary sources 2026-07-10:

- **The $25,000 Pattern Day Trader rule genuinely changed** (not a rumor, not a
  broker house policy): **SR-FINRA-2025-017**, SEC-approved (**Release No. 34-105226**,
  Apr 2026), **FINRA Regulatory Notice 26-10**, **effective June 4, 2026**. It
  *eliminates* the PDT designation, the 4-day-trades-in-5-business-days count, **and
  the $25,000 minimum-equity requirement**, replacing them with an
  **intraday-margin-deficit framework** (firms monitor equity vs open positions
  throughout the day; deficits cured "as promptly as possible"; repeat violations can
  freeze margin trading up to 90 days).
- **What survives unchanged:** the **$2,000** general minimum to trade on margin;
  **25% FINRA maintenance** margin (now applied intraday, position-by-position);
  **Reg T 50%** initial on new long purchases (shorts 150%); the rules apply only to
  **margin** accounts (cash accounts never had the $25k floor); and **brokers may set
  house requirements STRICTER than the floor** and often do.
- **Honesty caveat:** "changed at the regulator" ≠ "gone at your broker." Firms may
  phase in until **Oct 20, 2027**. Alpaca already **removed** `pattern_day_trader`,
  `daytrade_count`, `daytrading_buying_power` from its account object (2026-07-06) and
  says to use `buying_power` as the running intraday-margin figure; **Tradier still
  exposes `account_type=="pdt"`**. So whether a specific account is still subject to
  legacy PDT is **broker-specific** and read from that broker.
- **The app is already aligned:** `src/lib/policy.ts` sets `MARGIN_MINIMUM_EQUITY =
  2_000` citing Notice 26-10; no `$25,000` threshold exists in production source. Do
  not reintroduce a $25k hardcode.

## Current state (survey findings)

- **Shorting — ~92% built.** Full short/cover pipeline implemented + unit-tested:
  capability detection (Alpaca `shorting_enabled`), the double-gate (broker capability
  AND `policy.shortSellingEnabled`, plus mandatory `shortStopLossPct` /
  `maxShortOrderNotional`), directional brokerage brackets, `toBrokerSide()` mapping,
  FIFO short P&L with correct sign (`src/lib/performance.ts`), daily-notional + PDT
  tracking (`src/lib/db-execution.ts` — the old "maybe-incomplete" AGENTS.md note is
  **stale/done**), UI guardrails, live short management (stop-cover / take-profit-trim).
  **Off by default; Alpaca-only** (Robinhood MCP can't short — fails closed). No
  production short→cover fill on record yet.
- **Options — 0% of order placement.** Everything is DISPLAY/ANALYSIS only
  (`src/lib/robinhood-options.ts` chain/IV enrichment, a read-only chat research tool,
  account-level `optionsLevel` *reporting* — Alpaca hardcodes `optionsTrading:false`).
  Real placement is a **net-new subsystem**: the whole execution stack is equity-only
  (`OrderSide`, `EquityOrderInput`, the 9-method equity `BrokerGateway`). **Robinhood
  cannot place option orders through this app** (its trading MCP is equity-only), so
  the placement surface is **Alpaca first, Tradier after its adapter lands**.
- **Margin/leverage — not modeled.** The app trusts the broker's single `buyingPower`
  scalar and ignores `multiplier`, `regt_buying_power`, `maintenance_margin`, DTBP,
  `*_blocked` flags. `AccountCapabilities.marginRequirementPct` is **declared but
  dead**. Shorts get **no** buying-power cap in the sizer. Effectively cash-basis
  reasoning that opportunistically permits up to whatever leveraged `buying_power` the
  broker reports.
- **PDT/day-trade tracking — built but unwired.** `countDayTradesInLastBusinessDays`
  (`src/lib/db-execution.ts`) is correct and unit-tested and threaded into the policy
  context as `priorDayTradeCount` — but **verified DEAD: no gate reads it**. The only
  live regulatory gate is the hard **$2,000** live-margin minimum.
- **Tradier** is being promoted from a data-only history source to the **5th broker**
  (equity adapter, PR #1380) — and is the cleanest PDT/day-trade-buying-power source of
  the surveyed brokers.

## Owner decisions (2026-07-10)

1. **Shorting: enable for LIVE too** (not paper-only). Double-gated by broker
   capability + the policy toggle either way. *(Build note: no production fill on
   record — a paper short→cover verification runs in parallel as a non-blocking safety
   check; it does not gate the owner's live enablement.)*
2. **Options: FULL — single-leg AND multi-leg/spreads.** Still Alpaca-first then
   Tradier; Robinhood stays data-only (can't place). Built in phases (single-leg long
   first as the correctness spine, then writing, then multi-leg) but the committed
   destination is full spreads.
3. **Day-trade/PDT: read each broker's own requirements; otherwise leave as-is.**
   Surface broker-reported PDT status / day-trade buying power / requirements per
   account (Tradier `account_type=="pdt"`, etc.); do **not** add an app-side advisory
   day-trade gate or count-limit. The app's own counter stays as-is (fallback only).
4. **Leverage: NAV caps + opt-in leverage.** Keep NAV-based % caps and
   `maxGrossExposurePct` as the governor; surface the broker's real
   buying-power/maintenance honestly; use leverage only if explicitly enabled — never
   silently lever up.

Engineering defaults adopted without needing a decision (philosophy-aligned): read
broker values as source of truth; capability = hard broker-truth gate (you cannot
thesis past what the broker won't approve); options approval-level hard-gated like
shorts; a single shared `BrokerMargin` read per broker; canonical OCC option model
with thin per-broker mappers; assignment/expiration = detect-and-alert (not
auto-exercise).

## Phased plan

Everything shares one broker read, so **build read-first, then features on top**, and
**merge = deploy to the live app**, so foundations land (owner-timed, off-market)
before dependents.

- **Foundation (in review):** Tradier equity adapter (PR #1380) + the order-status
  reconciliation fix ("uncertain" bug). Owner reviews + merges on their timing.
- **Phase 0 — `BrokerMargin` capability read (read-only, no behavior change).** Extend
  `Portfolio`/`AccountCapabilities` with a `BrokerMargin` sub-object (buying power,
  multiplier, maintenance, DTBP, options level/buying-power, shorting-enabled,
  `*_blocked`, **broker-reported PDT status**, source honesty-flag); populate from each
  broker (Alpaca/Robinhood/Tradier) in `getPortfolio`/`getCapabilities`; surface in ops
  snapshot + dashboard. Delivers decision 3's "read each broker's requirements" and
  decision 4's honest visibility. Also add fail-closed `tradingBlocked` reads (hard).
- **Phase 1 — Shorting enable + verify** (decision 1). Wire the short-side
  buying-power cap (from `BrokerMargin`), fix the stale `strategy.ts` bear-filter
  comment, harden non-fractionable dollar-sized shorts; enable for paper+live per the
  owner; run one paper short→cover verification round-trip.
- **Phase 2 — Options single-leg (Alpaca).** New option type system (`OptionContract`,
  `OptionOrderInput`, `OptionPosition`, a separate option-action union — do NOT widen
  the load-bearing 4-value `OrderSide`), OCC symbology util, a parallel option
  `BrokerGateway` surface behind `withLivePreflight`, the Alpaca adapter (parse+persist
  real options level, replace the hardcoded false), premium-based risk gate, proposal +
  LLM plumbing, ×100 multiplier threaded through daily-notional/P&L/min-order,
  assignment/expiry detect-and-alert, UI. Hard-gated on options level.
- **Phase 3 — Opt-in leverage-aware sizing** (decision 4). Optional maintenance-margin
  gate + leverage cap in `openingRiskCapacity`, keyed on the now-populated
  `BrokerMargin`; NAV caps stay the default governor; leverage is opt-in.
- **Phase 4 — Tradier options + covered-call/CSP writing.** Reuse the canonical model
  on the Tradier equity adapter; add `sell_to_open` covered writing behind
  `optionsRequireDefinedRisk`.
- **Phase 5 — Multi-leg / spreads** (completes decision 2). Alpaca `mleg` + Tradier
  `multileg`, level-3 gating, defined-risk combo pairing + combo P&L.

Robinhood remains data-only (enrichment + chat research + approval-level display)
across all phases — out of the placement surface by MCP limitation, not by choice.

## The ×100 landmine (read before Phase 2)

Options carry a 100× contract multiplier. Daily-notional caps, FIFO P&L,
broker-minimum-guard, protective stops, and margin all currently assume shares — every
one must be audited for the multiplier. This is the "load-bearing union" trap from
AGENTS.md at larger scale; treat it as an exhaustive audit, not a quick add.

## Status

Foundation PRs in review (Tradier #1380 gate-green; order-status-reconcile in
adversarial verify). Phases 0–5 not yet started as a block — sequenced after foundations merge to
avoid a money-path merge pileup on the live app.

**2026-08-13 first ship (`grok/st-kalshi-exits-options`):** Exit Contract persistence was already
on main (B1/B2). This slice adds Phase B4 broker-held Alpaca buy-stops for shorts
(`brokerStopsForShorts` default on), unmanaged-short honesty when the venue cannot hold a cover
stop, Alpaca paper option place/cancel behind `optionsTradingEnabled` (live kill switch
`optionsLiveOrdersEnabled` default off), and Kalshi macro prompt context plus a separate
event-contract trading module (`KALSHI_LIVE_ORDERS` + `kalshiLiveOrdersEnabled` both default off).
