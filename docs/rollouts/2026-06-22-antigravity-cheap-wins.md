# 2026-06-22 — Antigravity critique: the 5 cheap-win risk/execution gates

## Summary
Implemented the five low-cost, high-value items distilled from re-verifying Antigravity's two
strategy critiques (the expert-panel "brainstorm" and the prose "hidden weaknesses" eval) against
live `origin/main`. The prior actionable subset already shipped (#94/#95/#96); these are the
remaining cheap wins where the data/plumbing already existed but wasn't wired into a gate.

1. **Volatility panic auto-brake** (`#1`). A rare tail extreme on VIX / Cboe VVIX / Cboe SKEW at the
   top of a run now flips an `active` system to `close_only` (risk-reducing exits still flow) and
   fires a kill-switch notification — the automatic defensive state the crisis-regime entry cap never
   triggered on its own. The VVIX/SKEW data was already fetched (`market-signals/`) and shown to the
   LLM; this turns it into a hard safeguard. New pure `evaluateVolatilityBrake()` in `macro.ts`;
   wired into `runStrategyOnce` beside the drawdown breaker. Default ON at conservative tail
   thresholds (VIX 40 / VVIX 150 / SKEW 160); all configurable; `volPanicBrakeEnabled:false` disables.

2. **ADV market-impact order-size cap** (`#2`). Opening orders are capped at `maxOrderPctOfAdv` % of
   the name's recent daily $-volume (ADV proxy = scan price × volume; the app ingests no historical
   bars). Applied in `applyDeterministicSizing` (right-sizes) **and** as an approval-time gate in
   `policy.ts` (catches manual/non-sized proposals). Default 5%. The execution-cost model already
   *debited* impact slippage; this *prevents* sizing into illiquid names past what the tape absorbs.
   Rarely binds for small accounts / liquid names; matters at scale.

3. **Marketable-limit entries** (`#3`). The long-dormant `policy.marketableLimitEntries` stub is now
   implemented: when ON, `enrichOpeningProposal` converts a deterministic OPENING market order into a
   quantity+limit priced through the quote by `tuning.marketableLimitBufferBps` (default 15 bps) so a
   fast tape can't fill it arbitrarily past the quote. Resolves the dollar-notional routing conflict
   by deriving a whole-share quantity from the reference price (skips when qty < 1 — sub-share
   notional can't be a clean limit). Default OFF (opt-in; it changes order routing). Protective EXITS
   intentionally stay market (broker brackets are the exit-reliability mechanism).

4. **Robinhood synthetic-stop transparency** (`#4`). Robinhood cannot hold broker OCO brackets via
   the MCP, so its positions are protected by the synthetic scheduler-tick monitor ONLY — a SPOF if
   the app is offline. `enrichOpeningProposal` now appends an explicit `[Risk]` note to opening
   proposals on non-bracket brokers when a stop is configured, so the operator knows. (True
   broker-held RH stop-leg orchestration is a documented follow-up — not faked.)

5. **Optional cross-provider Bear LLM** (`#5`). `RED_TEAM_LLM_PROVIDER=anthropic` routes the Red Team
   critique to Claude while the Bull proposer stays on OpenAI, breaking the single-family echo
   chamber. New `redTeamProvider()` selector + `debateViaAnthropic()` in `red-team.ts` (Messages API,
   same fail-closed contract: any failure → `available:false` → human review). Default openai (no
   behavior change); falls back to OpenAI if Anthropic is selected but unkeyed.

## Why
Re-verification (two background workflows, file:line evidence) confirmed #94/#95/#96 landed and
surfaced these as the genuinely-remaining cheap wins. Notably the ADV cap was *upgraded* from the
earlier "skip — over-engineered" verdict: the market-impact math already existed but no size *cap*
did, and `dollarVol` is already computed, so it's ~a dozen lines. Tax-in-tuner (4b) was deliberately
NOT done — it would penalize turnover that costs a Roth IRA holder nothing (owner priority: Roth
must work as well or better).

## Files
- `src/lib/types.ts` — `TradingPolicy`: `maxOrderPctOfAdv`, `volPanicBrakeEnabled`,
  `volPanicVix/Vvix/SkewThreshold`; `TuningSettings`: `marketableLimitBufferBps`.
- `src/lib/defaults.ts` — defaults: `maxOrderPctOfAdv:5`, `volPanicBrakeEnabled:true` + thresholds.
- `src/lib/macro.ts` — `evaluateVolatilityBrake()` + `VolBrakeSignals`/`VolBrakePolicy`.
- `src/lib/strategy.ts` — vol-brake wiring in `runStrategyOnce`; ADV cap in `applyDeterministicSizing`
  (+ `marketScan` param + call site); marketable-limit conversion + RH transparency note in
  `enrichOpeningProposal`.
- `src/lib/policy.ts` — ADV approval-time gate.
- `src/lib/red-team.ts` — `redTeamProvider()` + `debateViaAnthropic()`.
- `.env.example` — `RED_TEAM_LLM_PROVIDER` / `RED_TEAM_LLM_MODEL`.
- `test/macro.test.ts` — vol-brake unit tests.
- `test/policy.test.ts` — ADV approval-gate tests.
- `test/antigravity-cheap-wins.test.ts` — ADV sizing cap, marketable-limit, red-team selector.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 881 passed (96 files); +new tests.
- `npm run build` — green.
Built in isolated worktree `~/apps/trading-ag5` off `origin/main` (`93a52d7`); landing via PR.

## Follow-ups
- True broker-held stop-leg for Robinhood (place a resting stop after the opening fill + cancel-on-
  close lifecycle) — larger; deferred. Transparency note ships now.
- Alpaca-price event-trigger producer (parked): wire a real-time technical signal into the existing
  trigger engine so high-conviction setups fire an immediate decision cycle.
- Benchmark-vs-SPY equity-curve scoreboard (the OOS "is there edge" measurement) — not in this batch.
- ADV uses single-day $-volume (no historical bars); a true 20-day ADV needs an OHLC feed.
