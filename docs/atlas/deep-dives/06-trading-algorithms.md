# Deep Dive 6 — Trading Algorithms & Quant

> Expert panel deep-dive expanding §6 of the [Multi-Expert App Analysis](../multi-expert-app-analysis.md). For a team newer to quant. Advisory-only: the LLM/algos may draft and optimize; humans confirm; deterministic risk controls bound everything.

---

#### 6.1 Strategy Framework & Backtesting Engine

##### 6.1.1 Modular strategy framework (typed, versioned stages)

A strategy is a pipeline of strictly separated stages, each a typed, versioned interface:

```
Signal → Sizing → PortfolioConstruction → Execution → RiskOverlay
```

- **Signal** — maps point-in-time features to a desired direction/strength per instrument. Knows nothing about capital, positions, or risk limits. Output is dimensionless, never share counts.
- **Sizing** — converts signal strength + volatility estimate into a *target weight*. Knows nothing about the current portfolio.
- **PortfolioConstruction** — reconciles target weights under constraints (gross/net, sector caps, turnover budget, integer-lot rounding).
- **Execution** — diffs target vs current positions into *orders* and decides how to work them.
- **RiskOverlay** — a final, authoritative veto layer (kill-switches, max-DD stops, position/notional limits, fat-finger checks). It can only *reduce or block*, never originate risk.

Separation prevents the most common beginner bug: leaking sizing/risk logic into signal generation so you can no longer tell *what* the edge is.

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class Signal(Protocol):
    version: str  # e.g. "momentum.v3"
    def predict(self, view: PointInTimeView) -> dict[str, float]: ...
    #                    ^ ONLY data available as of view.info_time

class Sizing(Protocol):
    version: str
    def size(self, signals: dict[str, float], vol: dict[str, float]) -> dict[str, float]: ...
```

**The point-in-time (PIT) data layer is the foundation.** Every record carries `event_time` (when it happened) and `info_time` (when you could first have known it). The gap is where lookahead bias hides — fundamentals are restated, economic data revised, an earnings number timestamped to quarter-end but published weeks later, "today's" close not tradable until the close. The data layer answers one question — *"what did I know as of `info_time = T`?"* — and a stage may **never** read a field whose `info_time > T`. Bake this into the API (`view.as_of(T)` returns only admissible rows) so lookahead is structurally impossible. Survivorship bias is the same failure in a different costume: your universe at `T` must include names that later delisted, from a point-in-time universe snapshot.

##### 6.1.2 Two backtesters: event-driven (truth) vs vectorized (scouting)

**Event-driven backtester — the source of truth.** A single chronological event loop processes a merged, time-ordered stream of data, signals, orders, and fills, carrying explicit state (cash, positions, open orders) exactly as a live system does. Causal by construction, so lookahead is hard to introduce by accident, and the same engine logic can drive paper/live.

```python
def run(events, strategy, broker, portfolio):
    for ev in events:                       # strictly chronological
        if ev.kind == "BAR":
            broker.update_market(ev)
            for fill in broker.match_open_orders(ev):
                portfolio.apply(fill)
            sig    = strategy.signal.predict(ev.view)   # PIT-restricted to ev.info_time
            tgt_w  = strategy.sizing.size(sig, ev.vol)
            tgt_p  = strategy.portfolio.construct(tgt_w, portfolio.positions, ev.constraints)
            orders = strategy.execution.orders(tgt_p, portfolio.positions)
            orders = strategy.risk.screen(orders, portfolio)   # veto-only
            broker.submit(orders)           # fills NEXT bar, never this close
        elif ev.kind == "FILL":
            portfolio.apply(ev)
    return portfolio.history
```

**Vectorized backtester — coarse research only.** Express the strategy as array ops (`returns = weights.shift(1) * asset_returns`). 100–1000× faster; ideal for sweeping a parameter grid to decide *what's worth a real test*. **Never use it for final validation:** it applies a single global cost assumption, can't represent partial fills / rejected orders / queue position / unfilled limits, and its ubiquitous `.shift(1)` lookahead guard is trivially broken by a misaligned index or a peeking `rolling()` window — producing a beautiful equity curve and an invisible bug. **A strategy is only "real" once the event-driven engine reproduces an acceptable result with full costs.**

##### 6.1.3 Realistic fills (kill the fill-at-close fantasy)

The decision price (the close that generated the signal) is not available to transact on. Enforce **next-bar execution**. Model each cost component explicitly:

```python
def execution_cost(side, qty, price, bar, p):   # side: +1 buy / -1 sell
    spread_cost  = 0.5 * bar.spread                          # cross half-spread
    notional     = qty * price
    fees         = max(p.min_fee, p.fee_bps * 1e-4 * notional)
    participation = qty / max(bar.volume, 1)
    impact       = p.impact_coeff * bar.sigma * (participation ** 0.5) * price  # square-root impact
    fill_price   = price + side * (spread_cost + impact)     # always adverse
    return fill_price, fees

def fillable_qty(want, bar, p):
    return min(want, int(p.max_participation * bar.volume))  # partial fill -> carry remainder
```

Calibrate `impact_coeff`, `fee_bps`, `max_participation` from your venue/asset class; when uncertain, **be pessimistic** — a strategy that only works under optimistic costs does not work.

##### 6.1.4 Reproducibility (any backtest is exactly regenerable)

Fixed seeds (one RNG seed threaded through every stochastic component); pinned, content-addressed data snapshots (vendors silently restate history); config hashing (hash the fully-resolved config — stage versions, params, cost model, universe, dates, snapshot id); a run manifest capturing config hash + code git SHA (+dirty flag) + data snapshot ids + seed + library versions.

```yaml
run_manifest:
  run_id: 2026-06-19T14:02:11Z-a91f3c
  config_hash: sha256:7b1e…c4
  code_sha: 4f9a2e1   (dirty: false)
  data_snapshots: { prices: snap:px@9d2…, fundamentals: snap:fnd@1a7… }
  seed: 20260619
  stages: { signal: momentum.v3, sizing: voltarget.v2, exec: vwap.v1, risk: overlay.v4 }
```

CI guard: re-run a canonical backtest from its manifest and assert the equity-curve hash matches. Drift = a dependency became nondeterministic; fail the build.

##### 6.1.5 Out-of-sample discipline

- **Walk-forward analysis** — fit/select in-sample, evaluate on the immediately following out-of-sample window, roll forward. Mimics real recalibration over time and exposes regime-sensitivity a single split hides.
- **Lockbox holdout** — a final slice no one touches during research, opened **once** at the end. Every peek burns it.
- **Multiple-testing awareness** — a Sharpe of 2 means little if it's the best of 500 trials. Apply the **Deflated Sharpe Ratio** and estimate the **Probability of Backtest Overfitting** via combinatorially-purged CV. Track every trial.
- **Parameter-plateau robustness over peak optimization** — prefer a broad, flat parameter region (small perturbations barely change performance) over a sharp peak (almost always overfit). Report the surface, not just the argmax.

Decide the evaluation protocol and success threshold **before** running the sweep, and count every trial.

##### 6.1.6 Paper-trading sandbox & decay detection

Between backtest and capital sits a paper sandbox: the *same* event-driven engine and stages, fed *live* data, routing simulated orders through the real broker's order types — no money at risk. Because it shares code with the backtester, divergence isolates environmental effects (latency, feed differences, real spreads). Continuously measure **backtest-vs-live tracking error**; persistent, growing divergence is the early-warning signal that an edge is **decaying**. Alert on tracking error breaching a threshold and on rolling live Sharpe falling outside the backtest's confidence band.

##### 6.1.7 How the LLM assists — and the hard line

Safe, high-value uses: scaffolding code against the typed interfaces (and lookahead-bias tests on the PIT layer); explaining tear sheets and flagging suspicious patterns ("this equity curve is too smooth — check for fill-at-close"); reviewing for classic traps ("does this stage read any field with `info_time > T`? is execution next-bar? how many configs were tested?"); turning manifests into readable run reports.

The hard line: **the LLM is never in the order path.** It does not size positions, choose entries/exits, set risk limits, or approve live orders. Its outputs are code and explanations that a human reviews, the deterministic engine executes, and the RiskOverlay authoritatively bounds. Treat LLM output as an untrusted draft — it can hallucinate a plausible-looking lookahead bug or optimistic cost assumption. If a generated stage can't be reproduced from a manifest and survive the lockbox, it does not trade.

---

#### 6.2 Risk Management, Position Sizing & Safety Controls

> **Architectural invariant:** every control here runs in a deterministic risk engine *outside* the model/LLM. The assistant *proposes*; the risk engine *validates*; a human *confirms*. No prompt, jailbreak, or "reasoning" can disable, soften, or route around these — the limits are code and config.

##### 6.2.0 Trust boundary: controls live outside the model

```
 LLM / model layer        Deterministic risk layer (no model)        Human
 ┌────────────┐  intent   ┌──────────────────────────────────┐  approve  ┌─────┐
 │ proposal + │──────────▶│ pre-trade checks → limits → kill  │──────────▶│ user│
 │ rationale  │  (JSON)   │ switches → sizing reconciliation  │  reject   │     │
 └────────────┘           └──────────────────────────────────┘           └─────┘
        ▲                              │ block / clamp / flatten
        └──────────────  audit log  ───┘
```

Properties: separate process & privileges (the risk engine holds the broker/OMS credentials; the model layer never does — it cannot place an order even if it "decides" to); deny-by-default; config not conversation (limits come from a signed config store + risk-committee approval); advisory + human-confirmed; tamper-evident audit log.

##### 6.2.1 Real-time risk overlay: hard limits, kill-switches & circuit breakers (highest impact)

| Limit | Typical trigger | Action |
|---|---|---|
| Max drawdown | -15% from high-water mark | Halt new entries; flatten to target net |
| Daily loss limit | -3% NAV intraday | Stop trading for the session |
| Gross leverage cap | gross > 2.0× NAV | Block size-increasing orders |
| Single-name concentration | position > 10% NAV | Block adds; flag for trim |
| Net exposure band | net outside [-20%, +120%] | Block orders that worsen breach |

Kill-switches (auto-trip): auto-flatten on hard breach (controlled liquidation, not market dumps); data staleness (mark older than `max_staleness_ms` → freeze); NaN/anomaly guard (>Nσ jump → quarantine); excessive reject rate → stop sending; **manual master kill** (cancel all working orders, block all new — always reachable, never gated behind the model).

```python
def evaluate_risk_overlay(state, cfg) -> list[Breach]:
    b = []
    dd = (state.high_water_mark - state.nav) / state.high_water_mark
    if dd >= cfg.max_drawdown:                    b.append(Breach("MAX_DD", dd, action="FLATTEN"))
    if state.daily_pnl_pct <= -cfg.daily_loss_limit: b.append(Breach("DAILY_LOSS", state.daily_pnl_pct, action="HALT"))
    if state.gross_leverage > cfg.max_gross_leverage: b.append(Breach("LEVERAGE", state.gross_leverage, action="BLOCK_ADDS"))
    if state.feed_age_ms > cfg.max_staleness_ms:  b.append(Breach("STALE_DATA", state.feed_age_ms, action="FREEZE"))
    if state.reject_rate > cfg.max_reject_rate:   b.append(Breach("REJECTS", state.reject_rate, action="HALT_SEND"))
    if cfg.master_kill or state.has_nan or state.anomaly_sigma > cfg.max_sigma:
                                                  b.append(Breach("KILL", None, action="FLATTEN"))
    return b
```

Auto-flatten/HALT fire **without** human confirmation — they only *reduce* risk. Only *risk-increasing* actions require human confirmation.

##### 6.2.2 Pre-trade risk checks (block before execution)

```python
def pretrade_check(o, ref, acct, cfg) -> Decision:
    if o.symbol in cfg.restricted_list:            return Decision.block("RESTRICTED")
    if abs(o.qty) * o.price > cfg.max_notional:    return Decision.block("FAT_FINGER_NOTIONAL")
    if abs(o.qty) > cfg.max_qty:                   return Decision.block("MAX_ORDER_SIZE")
    if abs(o.limit_price - ref.price) > cfg.collar_pct * ref.price:
                                                   return Decision.block("PRICE_COLLAR")
    if acct.projected_margin(o) > acct.buying_power: return Decision.block("BUYING_POWER")
    if not tick_lot_valid(o, cfg):                 return Decision.block("TICK_LOT")
    return Decision.allow()   # allow ≠ execute; still requires human confirmation
```

##### 6.2.3 Position sizing (the engine recomputes/clamps; never trusts a raw model quantity)

- **Max-loss-per-trade with stop distance** (most direct): `qty = floor(equity*risk_per_trade / (|entry-stop| * point_value))`. Best with a defined invalidation level.
- **Volatility targeting (ATR-based)** — normalize risk across instruments: `qty = (target_vol*NAV) / (price*σ_annual*point_value)`. Auto-deleverages when vol spikes; default for multi-asset books.
- **Fixed-fractional** — simple robust baseline / sanity cap.
- **Fractional-Kelly** — `f_used = kelly_fraction * (edge/odds)`, `kelly_fraction ∈ [0.25, 0.5]`, capped. Only with a *measured* edge.
- **Risk-parity** — equalize risk contribution (`w_i ∝ 1/σ_i` first cut), lever to target vol.

**Sizing reconciliation rule:** whatever the model suggests, the engine recomputes from the active method and takes the **minimum** of (model qty, method qty, all caps). Suggestions are clamped down, never up.

##### 6.2.4 Portfolio risk analytics

Exposures (gross/net, sector/factor/country/currency, single-name concentration, correlation-cluster); **VaR & Expected Shortfall** (historical / parametric / Monte Carlo, with stated assumptions — always pair VaR with ES, which is coherent and tail-aware); drawdown analytics (HWM, current/max DD, time-under-water, Calmar, Ulcer); **portfolio greeks** + scenario shocks (spot/vol/time grids, revaluing the book to find short-gamma cliffs); **liquidity risk** (`days_to_liquidate = position / (participation_rate * ADV)`).

##### 6.2.5 Stress testing

Revalue the *current* book under named adverse worlds (catches correlation-regime shifts VaR misses): historical replays (2008, 2020, 2010 flash crash, 2013 taper, 2022 rate shock); rate shocks (parallel/non-parallel curve moves with duration/convexity revaluation); custom factor shocks (equity beta −20%, credit +150bps, USD +5%, oil ±30%); a reverse stress test (solve for the scenario producing a target loss). Results feed limits — a plausible scenario breaching the max-DD/daily-loss budget flags the book for de-risking *before* the event.

##### 6.2.6 Why this is safe by construction

Defense in depth (sizing budgets → pre-trade checks → real-time overlay → kill-switches); one-way safety (automated actions only *reduce* risk; *increasing* risk needs a pre-trade pass **and** explicit human confirmation); model-independent (deterministic functions of positions/prices/config/account — they hold even if the model is wrong, manipulated, or adversarial); auditable (every allow/block/clamp/flatten/override logged with inputs + active config hash).

---

#### 6.3 Execution Algorithms & Transaction-Cost Modeling

Execution quality is where measurable basis points are won or lost after the alpha decision. Everything below is *planning/paper/optimization* logic; live routing goes only through a licensed broker API after explicit human confirmation.

##### 6.3.1 Order types & time-in-force (highest impact, lowest effort)

| Order type | Guarantees | Costs | Right use |
|---|---|---|---|
| **Market** | Fill (not price) | Full spread + impact; gap risk | Only when fill certainty dominates — liquidations, triggered stops, liquid names mid-day |
| **Limit** | Price (not fill) | Adverse-selection / non-fill | Default for entries; passive spread capture; illiquid names |
| **Stop (stop-market)** | Triggers a market order | Slippage on trigger | Risk exits where fill certainty > price |
| **Stop-limit** | Triggers a limit | May not fill in a fast move | Exits where you refuse to sell below a floor |
| **Trailing stop** | Dynamic offset | Trigger slippage; whipsaw | Locking gains in trends |
| **MOC / LOC** | Closing auction | Auction impact | Index/rebalance trades that must mark at the close |
| **Bracket / OCO** | Entry + TP + stop / one-cancels-other | Management overhead | Fully specified trade plans |

TIF: **DAY** (safe default), **GTC** (needs a monitoring/expiry policy), **IOC** (sweep displayed liquidity), **FOK** (all-or-nothing where a partial is useless), extended-hours (force limit + warn; never market). Drafting rule: propose the *least aggressive order type that meets the stated urgency*, show the trade-off, and require human confirmation for any market or extended-hours order.

##### 6.3.2 Execution algorithms — choosing by urgency vs liquidity

| Algo | Optimizes | Choose when |
|---|---|---|
| **TWAP** | Even time distribution; low gaming surface | Low urgency, don't trust volume forecasts |
| **VWAP** | Track the volume-weighted benchmark | Benchmarked to VWAP; blend with daily volume |
| **POV / Participation** | Stay a fixed % of live volume | Liquidity-adaptive; willing to extend horizon |
| **Implementation Shortfall** | Minimize slippage vs arrival price | Urgency is real, alpha decays; front-load |

**Almgren–Chriss intuition:** optimal slicing trades **market impact** (faster → more impact, convex; pushes slower) against **timing risk** (slower → more volatility exposure; pushes faster), minimizing `E[cost] + λ·Var[cost]`. λ→0 (patient) → TWAP; λ large (urgent) → front-loaded; higher σ → trade faster; thinner liquidity → trade slower.

##### 6.3.3 Transaction-cost analysis (TCA)

Total cost vs arrival price = **spread** (half-spread for taking; can be negative if you rest passively) + **commissions & fees** + **market impact** (temporary, mean-reverting; vs permanent, information leakage; square-root model `impact ∝ σ·√(Q/ADV)`) + **timing/slippage**. Cost scales with **participation rate** (order size / ADV), spread, and volatility — size every estimate off the instrument's ADV/spread/vol, never a flat bps assumption.

```python
def square_root_impact_bps(order_qty, adv, daily_vol_bps, coef=0.9):
    if adv <= 0: raise ValueError("ADV must be positive")
    participation = order_qty / adv
    return coef * daily_vol_bps * (participation ** 0.5)
# 50k shares of 5M ADV, 2% daily vol: 0.9 * 200 * 0.1 = 18 bps estimated impact
```

Surface the estimate as a range; use it to size the order, pick the algo/horizon, and decide whether the trade clears its own cost.

##### 6.3.4 Attribution, latency & routing transparency

**Separate alpha decay from execution cost** by decomposing realized return: decision→arrival (delay cost), arrival→average-fill (execution cost the algo owns), average-fill→interval-VWAP (execution skill), post-fill drift (alpha decay vs temporary-impact reversion). If paper P&L is strong but live is weak, attribution says whether to fix the model's holding assumptions or the execution policy.

**Latency & queue position** for HFT-ish strategies: model wire+processing latency (is your quote still valid on arrival?) and FIFO queue position (paper/backtests must model queue position, not assume top-of-queue, or they massively overstate passive fill rates). **Routing transparency:** surface where child orders routed (lit/dark, rebate vs fee), price improvement vs NBBO, and conflicts (PFOF). **Simulated fills must be conservative:** fill at the far touch (cross the spread) for marketable orders; require the market to trade through your price for passive limits; apply latency/partial-fills/impact; reconcile against live NBBO.

```python
def twap_slices(total_qty, start, end, n_slices, lot=1):
    from datetime import timedelta
    if n_slices <= 0: raise ValueError("n_slices must be positive")
    step = (end - start) / n_slices
    base = (total_qty // n_slices // lot) * lot
    schedule, placed = [], 0
    for i in range(n_slices):
        qty = base if i < n_slices - 1 else total_qty - placed
        schedule.append((start + i * step, qty)); placed += qty
    return schedule   # a PLAN only — each child still requires the broker API + human confirmation
```

##### 6.3.5 The execution boundary (non-negotiable)

This app **optimizes the HOW of a human-approved order; it never decides autonomously to trade.** Drafting & optimization are in scope (order type, TIF, slicing, algo, limit prices, TCA estimate — in planning/paper). Live routing reaches a market **only** through a licensed broker API and **only** after explicit, per-order human confirmation. No standing authority, no auto-approve, no model-initiated execution. The order of operations is always: **model drafts → human reviews cost/risk → human confirms → licensed broker API executes.**
