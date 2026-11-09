# Settings overhaul + universe floor + take-profit trim + backfill expansion — program plan

Owner decisions (2026-06-25): **full settings overhaul**, take-profit becomes a **real partial trim**,
and **add a universe floor + expand the backfill** (via Massive flat files). This is a multi-PR program;
each phase ships independently behind its own PR with the tsc/test/build trio green.

Grounded in the verified audit (`docs/rollouts/2026-06-25-sell-stops-settings-audit.md` /
workflow `wf_5a9d6a6c-051`): the app has 8 structural sell triggers + LLM sells; stop types are
fixed%/notional, take-profit, short stop, beta-scaled (multiplier), synthetic trailing (app-managed on
ALL brokers), Alpaca native brackets, and an opt-in Robinhood broker-held stop; **no ATR stop in main**;
and ~17 enforced policy settings have **no UI** plus several silent priorities.

## Phase 1 — Universe floor (penny/illiquid exclusion) ✅ (this PR)
- `UniverseFloor` type (`minPrice`/`minMarketCapUsd`/`minDollarVolume`) on `TradingPolicy`; default
  `{5, $100M, $1M}` (no-op for the S&P-500 default universe; bites only when broadened).
- `passesUniverseFloor`/`applyUniverseFloor` in `market.ts`; applied in the scan before ranking.
- **Exemptions:** explicitly-listed `additionalSymbols` and held positions are never filtered; exits never
  affected. Market-cap / dollar-volume bounds apply only when that datum is known (price floor is the
  reliable penny gate). Threaded through `scanMarket` → all 3 call sites.
- Tests: `test/universe-floor.test.ts`.

## Phase 2 — Take-profit: full exit → real partial trim ✅ (`docs/rollouts/2026-06-25-take-profit-trim.md`)
- New `riskRules.takeProfitTrimPct` (fraction of the position to sell at the target; default keeps a sane
  trim, e.g. 50, with 100 = full exit). Fix the misleading "trim" rationale wording.
- **Re-trigger ratchet (required):** the proactive generator runs every ~60s; a naive partial trim would
  ladder out the position on every tick while it stays above the target. Need state (mirror the
  `synthetic_trailing_stops` pattern: a small per-position "last take-profit level" record) so the next
  trim only fires after the gain advances another `takeProfitPct` band. This is why it's its own PR.
- Tests: trim fraction, ratchet (no double-trim same tick/band), full-exit at 100, short cover symmetry.

## Phase 3 — Settings overhaul (largest) ✅ (`docs/rollouts/2026-06-25-settings-overhaul.md`)
Make the editor honest: surface what's enforced, label interactions, and prevent mis-set combos.
- **Expose the ~17 enforced-but-invisible fields:** drawdown/daily-loss breaker, vol-panic brake group,
  gross/net exposure caps (the silent 80%), short sub-limits (`shortStopLossPct` etc.), `trailingStopPct`,
  `permitExtendedHours`, `permittedOrderTypes`, `maxOrderPctOfAdv`, `marketableLimitEntries`,
  `allowExtendedHoursSyntheticStops`, plus Phase-1/2's `universeFloor` and `takeProfitTrimPct`.
- **Per-account stop-support labels:** show, for the active broker, which stops are broker-held vs
  app-managed vs unsupported — especially "trailing stops are app-managed on every broker → only protect
  while the app is running", Alpaca-only brackets, Robinhood opt-in protective stop, Test = simulated.
- **Make interactions explicit / mis-set-proof:**
  - `$⇄%` toggle is currently destructive (clears the other variant) though the engine honors `min($,%)`.
    Either allow BOTH with a clear "lower binds" note, or make it an explicit either/or — not a silent clear.
  - Show the **effective** beta-scaled stop per name (displayed "8%" ≠ actual when beta-scaling is on).
  - Enabling shorting must require `shortStopLossPct` (today every short is silently rejected without it).
  - "Broker-held brackets" switch is a no-op off Alpaca and is really gated on `stopLossPct>0` — label it.
  - Fix the dangling "separate order permission" help text (the control didn't exist → it will now).
  - Surface that gross/net default to 80% (≈20% cash buffer) and let the user raise to 100%.
  - Universe: dynamic-index universes widen the tradable set beyond the explicit allowlist; blocklist is
    opening-only. Make both visible.
- API validation in `app/api/policy/route.ts` for every newly-editable field.

## Phase 4 — Backfill expansion + Massive flat files ✅ (`docs/rollouts/2026-06-25-flatfile-backfill.md`)
- Expand the share/backfill universe beyond static index members: all index universes + non-index names
  above the `universeFloor`, replacing per-ticker OHLC fetches (which timed out / burn the API cap) with
  **Massive flat files** (bulk daily-aggregate files on S3, or the REST grouped-daily endpoint as the
  no-S3 middle ground). Store bulk history as Parquet (DuckDB locally; R2 + DuckDB/warehouse in cloud).
- **Open prerequisite:** confirm we have Massive flat-file (S3) access/credentials and the access tier.
  If not, Phase 4 uses the grouped-daily REST endpoint first and defers true flat files.
- Centralize shared bulk history in App A (Congress.Trade) where practical so neither app double-stores.

## Cross-cutting
- Every phase: update `STATUS.md` + a `docs/rollouts/*` note + this plan; tsc/test/build green; PR with
  `verify` CI. Risk/money-path changes (Phases 2–3) get an adversarial review pass before merge.
