# 2026-06-25 — Take-profit: full exit → real partial trim (Phase 2)

Branch `agent/claude-tp-trim`. Phase 2 of `docs/settings-and-universe-overhaul-plan.md`.

## Summary
The proactive take-profit exit used to SELL the **full** position the moment a name crossed
`takeProfitPct` (its rationale even said "trim", but it sold everything). It now sells a configurable
fraction (`takeProfitTrimPct`, default **50%**) and lets the rest ride, with a **monotonic band ratchet**
so it trims **once per take-profit band** (+20%, +40%, …) instead of laddering the whole position out on
every run.

## Why
Owner chose "real partial trim — sell a fraction at the target and let the rest ride." A naive partial
trim would re-fire every run (the generator runs each strategy run and the position stays above the
target after a partial sell), laddering the position to zero — so a ratchet with persistent state is
required.

## What changed
- **`types.ts`** — `RiskRules.takeProfitTrimPct?` (1–100; 100 = full exit; undefined→100 for back-compat).
- **`defaults.ts`** — `DEFAULT_RISK_RULES.takeProfitTrimPct = 50`.
- **`db.ts`** — new `take_profit_trims` table (PK `user_id, account_number, symbol`; `band INTEGER`):
  the highest take-profit band already trimmed per open position.
- **`db-api-keys.ts`** — CRUD: `getTakeProfitTrimBands`, `recordTakeProfitTrimBand` (upsert, floors band
  to a non-negative int), `clearTakeProfitTrimBands` (clear closed positions; empty-input no-op).
- **`strategy.ts`** —
  - `generateProactiveRiskProposals` now emits ONLY stateless full-position **stop-loss / short-stop**
    exits (take-profit branches removed; guard relaxed accordingly).
  - new pure `planTakeProfitTrims(positions, currentPrices, policy, lastBandBySymbol)` →
    `{ proposals, advancedBands }`: for each position at/above target, `band = floor(returnPct/takeProfitPct)`;
    emits a `takeProfitTrimQuantity(qty, trimPct)` sell (long) / cover (short, when shorting enabled) ONLY
    when `band > lastBand`. Returns the bands to persist.
  - new exported `takeProfitTrimQuantity` (fraction; full-exit at ≥100; avoids leaving a dust remainder)
    and `clampTakeProfitTrimPct`.
  - `runStrategyOnce` caller: reads prior bands, plans trims, persists `advancedBands`, clears bands for
    positions that have closed (re-buys start fresh), merges the trim proposals. Wrapped in try/catch so a
    DB hiccup never breaks the run; only runs when `policy.accountNumber` is set.

## Design notes
- **Bands are committed ON FILL, not at plan time.** `planTakeProfitTrims` stamps each trim proposal with
  `takeProfitBand` + `takeProfitBasis`; the ratchet (`take_profit_trims`) is advanced only inside
  `recordFillFromProposal` (the single fill chokepoint — paper, live, and approve paths). So a trim that is
  merely proposed (propose mode), policy-/tradability-blocked, or rejected NEVER advances the band and is
  re-offered next run. (This was the high-severity defect the adversarial review caught in the first cut,
  which recorded at plan time and silently dropped the trim in the default `propose` mode.)
- **Lot-keyed ratchet.** The stored band carries the position's cost basis; `planTakeProfitTrims` ignores a
  stored band whose basis no longer matches the live position (a close+rebuy is a new lot → starts fresh),
  closing the same-cycle close-and-rebuy gap. `clearTakeProfitTrimBands` still prunes fully-closed symbols.
- **Whole-share trims.** `takeProfitTrimQuantity` floors a whole-share position's trim to whole shares (and
  full-exits when no clean ≥1-share slice exists) so a trim never forces a fractional order a non-fractional
  broker would reject; an already-fractional position keeps a fractional trim.
- **Behavior change for existing users:** `mergePolicy` injects the new `takeProfitTrimPct` default (50)
  into stored policies that lack the key, so users who previously got a FULL exit at take-profit now get a
  50% partial trim with the remainder riding. Deliberate (matches the chosen default); the `undefined→100`
  clamp only applies to non-merged policy literals/tests.
- Take-profit and stop-loss are mutually exclusive for a position (return% can't be both ≤ −stop and
  ≥ +target), so the two generators never double-emit for the same name.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/reconciliation-risk.test.ts test/strategy-hardening.test.ts test/take-profit-trim-db.test.ts`
  — all pass (trim fraction, monotonic ratchet, higher-band re-trim, short cover, full-exit back-compat,
  dust handling, DB round-trip/upsert/clear; stop-loss generator unchanged).
- Adversarial review workflow (3 lenses + verify) before merge; full trio via `scripts/land.sh`.

## Follow-ups
- Phase 3 settings overhaul will surface `takeProfitTrimPct` (and the rest of the hidden fields).
- Phase 4: flat-file backfill expansion (Massive flat files now verified working).
