# Stop-loss, exits & downside-risk controls

Canonical reference for every mechanism that closes a position, caps a loss, or
restricts opening risk. Grouped by layer. For each: what it does, the controlling
policy field / env flag, default, sync/async, broker scope, and status.

> **All money-path risk knobs are policy-driven** (`TradingPolicy` /
> `TradingPolicy.riskRules` in `src/lib/types.ts`, defaults in `src/lib/defaults.ts`,
> validated in `app/api/policy/route.ts`). None require an env var.

## Quick reference

| Mechanism | Field | Default | Layer | Status |
|-----------|-------|---------|-------|--------|
| Fixed % stop-loss | `riskRules.stopLossPct` | 8% | Per-position | Shipped |
| Stop-loss notional | `riskRules.stopLossNotional` | off | Per-position | Shipped |
| Take-profit % | `riskRules.takeProfitPct` | 20% | Per-position | Shipped |
| Take-profit notional | `riskRules.takeProfitNotional` | off | Per-position | Shipped |
| Trailing stop | `riskRules.trailingStopPct` | 0 (off) | Per-position | Shipped |
| Short stop-loss | `riskRules.shortStopLossPct` | required for shorts | Per-position | Shipped |
| **Beta-scaled stops** | `betaScaledStops` | off | Per-position | Shipped |
| **ATR-based stops** | `atrStops` + `riskRules.atrStop{Period,Multiple}` | off | Per-position | **Shipped (new)** |
| Alpaca OCO brackets | `brokerBracketsEnabled` | on (Alpaca) | Order | Shipped |
| Robinhood broker stops | `robinhoodBrokerStops` | off (opt-in) | Order | Shipped |
| Synthetic trailing monitor | (auto when `trailingStopPct`>0) | — | Order | Shipped |
| Marketable-limit entries | `marketableLimitEntries` | off | Order | Shipped |
| Max drawdown breaker | `riskRules.maxDrawdownPct` | off | Account | Shipped |
| Daily-loss breaker | `riskRules.maxDailyLossNotional` | off | Account | Shipped |
| Vol panic brake (VIX/VVIX/SKEW) | `volPanicBrakeEnabled` | on (tails) | Account | Shipped |
| System state machine | `systemState` | halted | Account | Shipped |
| Wash-sale guard (§1091) | `taxSettings.washSaleGuard` | on | Compliance | Shipped |
| Pre-trade gates | (many — see §D) | varies | Pre-trade | Shipped |

---

## A. Per-position exits

These set when an *individual* holding is trimmed or closed. The deterministic
**proactive risk-exit generator** (`generateProactiveRiskProposals`,
`src/lib/strategy.ts`) runs each cycle *before* the LLM and emits market SELL
(long) / COVER (short) proposals when a stop/take-profit is breached. The same
distances feed the pre-trade gate (`riskRuleReason`, `policy.ts:445`) and the
bracket/synthetic placement.

### Fixed % stop-loss — `riskRules.stopLossPct`
Closes (or blocks adding to) a long down more than `stopLossPct` from entry.
Default **8%**. Sync gate + async proactive exit. `types.ts:202`, `defaults.ts:22`,
`policy.ts:461`, `strategy.ts:~2499`. The `…Notional` sibling (`stopLossNotional`)
does the same in dollars; default off.

### Take-profit — `riskRules.takeProfitPct` / `takeProfitNotional`
Trims a long up ≥ `takeProfitPct` (default **20%**) — a target, not a stop, so it
is **never** widened by beta/ATR. `types.ts:204`.

### Trailing stop — `riskRules.trailingStopPct`
A high-water-mark trail: the synthetic monitor exits when price falls
`trailingStopPct` below the running peak (long) / rises above the trough (short).
Default **0 (off)**; async. Logic in `src/lib/synthetic-stops.ts:48`.

### Short stop-loss — `riskRules.shortStopLossPct`
**Mandatory** on any short proposal (`policy.ts:112` rejects a short without it).
Short loses when price rises; covers on a breach.

### Beta-scaled stops — `betaScaledStops` (default off)
Scales the stop *distance* by the name's beta, clamped **0.5×–2.0×**: high-beta
names get wider stops (fewer noise stop-outs), low-beta tighter (cut losers
sooner). Beta comes from the market scan; names without a beta are unaffected.
`betaScaledStopPct()` in `policy.ts:518`. Sync (beta is precomputed in the scan).

### ATR-based stops — `atrStops` (default off) **[new 2026-06-25]**
A volatility-aware stop driven by the name's **own realized daily range** instead
of beta. When `policy.atrStops` is on, the per-position stop *distance* becomes:

```
stopPct = clamp( atrStopMultiple × ATR(atrStopPeriod) ÷ entryPrice × 100, 1%, 50% )
```

- `riskRules.atrStopPeriod` (default **14**, bounded 5–100) — ATR lookback in bars.
- `riskRules.atrStopMultiple` (default **2.0**, bounded 0–10) — ATR multiplier.
- Pure math: `trueRange`, `atr`, `atrStopPct` in `src/lib/indicators.ts`.
- Wiring: the async strategy loop precomputes an ATR stop-% per open position from
  `fetchDailyOHLC` bars and passes it into the (sync) proactive generator —
  mirroring the `betaBySymbol` precompute (`strategy.ts`). It applies only when
  `stopLossPct > 0` (it sets the *distance* of the configured stop) and **falls
  back to the fixed/beta stop whenever bars are unavailable** — a position is
  never left unprotected. **ATR takes precedence over beta-scaling** when both are
  on (it's the more direct, per-name volatility read).

**Why three modes?** Fixed % is simple and predictable. Beta-scaled adapts to a
name's *market* sensitivity (needs a beta). ATR adapts to a name's *realized*
range and needs only its own bars — useful when a beta is missing or a name's
idiosyncratic volatility differs from its market beta.

---

## B. Order-level protection (survives app downtime / fills at the broker)

### Alpaca OCO brackets — `brokerBracketsEnabled` (default on, Alpaca only)
On an opening Alpaca order, attaches a stop-loss + take-profit OCO pair at
`entry × (1 ∓ pct/100)`. Computed in `enrichOpeningProposal` (`strategy.ts:~2393`).
Non-bracket brokers get a transparency note + the synthetic monitor fallback.

### Robinhood broker-held stops — `robinhoodBrokerStops` (default off, opt-in)
Places a resting **GTC stop-market SELL** at `stopLossPct` below entry for each
open RH **live** long, cancels on close / synthetic-exit. `broker-protective-stops.ts`,
`broker_protective_stops` table. Enabled only when `robinhoodBrokerStops` +
`broker/live` + `activeBroker==="robinhood"` + `stopLossPct>0`. Opt-in because the
exact RH MCP stop semantics should be live-verified first; the synthetic monitor
stays the always-on fallback.

### Synthetic trailing-stop monitor (all brokers)
`runSyntheticStopMonitor` (`synthetic-stops.ts:86`) ticks each cycle: tracks a
high/low-watermark, ignores >10% bad ticks, and fires a market exit on a breach.
Atomically claims a stop before placing (no double-fire) and cancels any orphaned
broker stop. Skips a symbol that already has a broker-held stop. When the system is
not "running" it audits `synthetic_stop_would_trigger` but does **not** place.

### Marketable-limit entries — `marketableLimitEntries` (default off)
Converts a deterministic opening *market* order into a marketable-limit through the
quote by `tuning.marketableLimitBufferBps` (default 15 bps) so a fast tape can't
fill arbitrarily far. Protective *exits* stay market for fill certainty.

---

## C. Account-level circuit breakers (flip `systemState`)

### Max drawdown — `riskRules.maxDrawdownPct`
Trailing drawdown from the equity high-water mark ≥ cap → `systemState` →
`close_only` + kill-switch notification. `risk-breaker.ts:39`, evaluated at run
start (`strategy.ts:~190`). Default off.

### Daily-loss — `riskRules.maxDailyLossNotional`
Single-day equity loss from the day's start ≥ cap → `close_only`. Same module.
Default off.

### Volatility panic brake — `volPanicBrakeEnabled` (default on)
Any of VIX ≥ 40 / VVIX ≥ 150 / SKEW ≥ 160 (thresholds configurable) → `close_only`.
`macro.ts:308`, async fetch at run start. A missing gauge is skipped (never
false-trips).

### System state machine — `systemState` (default `halted`)
`active` (opens+exits) · `halted` (all blocked) · `close_only` (exits only) ·
`liquidating` (exits only, stricter). Gate at `policy.ts:55`. Breakers and the
operator drive transitions.

---

## D. Pre-trade risk gates (prevent over-sizing / correlated risk)

Not stops, but they bound downside before a position exists (all in `policy.ts`
unless noted): `maxSymbolExposurePct`, `maxGrossExposurePct` / `maxNetExposurePct`
(default 100%), `sectorCaps`, `maxPortfolioBeta`, `maxAvgCorrelation` (opt-in
cluster gate, `correlation.ts` + `strategy.ts:~860`), `skipNegativeExpectancy`
(opt-in), the deterministic **bear veto** (`bearVetoFcfYieldFloorPct` /
`bearVetoDebtToEquityCeiling`, opt-in), `maxDailyNotional`/`maxDailyOrders`
(500/10), `maxHourlyNotional` (reverts `decide`→`propose` on breach),
the **PDT**/margin path (`MARGIN_MINIMUM_EQUITY` = $2,000 on live margin;
`db-execution.ts` day-trade counting), `maxEntryDriftPct` (default 10% — rejects a
stale opening order whose price drifted), `maxOrderPctOfAdv` (default 5% market-impact
cap), and `crisisMaxOpeningExposurePct` (crisis-regime notional ceiling).

---

## E. Tax / compliance exits

### Wash-sale guard — `taxSettings.washSaleGuard` (default on)
Blocks rebuying a symbol closed at a loss within 30 days (IRC §1091). A **taxable**
loss locks the symbol across **all** accounts (including IRAs, whose replacement buy
would destroy the disallowed basis); losses *inside* an IRA create no lock.
`policy.ts:236`, `tax.ts:99`.

---

## F. Deferred / future

- **Native Alpaca trailing stop (`trail_percent`)** — deferred; the synthetic
  monitor covers trailing on all brokers without a broad `OrderType` change.
- **Short-specific take-profit notional** — not yet a field (shorts use
  `takeProfitPct`).

---

## How they compose

1. **Each cycle, before the LLM:** circuit breakers + vol brake evaluate (may flip
   `systemState`); the proactive generator emits deterministic stop/take-profit
   exits; pre-trade gates will block any over-sized/over-correlated *opens*.
2. **At order placement:** Alpaca attaches OCO brackets; opening market orders may
   become marketable-limit.
3. **Continuously:** the synthetic monitor is the always-on trailing fallback;
   Robinhood broker stops (opt-in) and Alpaca brackets are broker-held and survive
   app downtime.

**Choosing a per-position stop:** *fixed %* = simplest/most predictable; *beta-scaled*
= volatility-aware via the name's market beta; *ATR* = volatility-aware via the name's
realized daily range (adapts per-name, no beta needed). Take-profit always stays flat.

_Last verified: 2026-06-25._
