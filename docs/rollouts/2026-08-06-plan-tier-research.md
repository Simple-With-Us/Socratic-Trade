# 2026-08-06 — Plan-tier research from live vendor docs

## Context & Objective

Owner: plan tiers need research on each site's docs (takes time / team), and it is
not infrequent that the owner finds better quota data than agents assume. Correct
Connections plan-tier ladders and free-safe `RATE_QUOTAS` so we stop inventing
limits (especially ROIC daily invents and Twelve Data Grow=377).

## Changes Made

- Re-fetched vendor pricing pages on 2026-08-06 (ROIC, Twelve Data `pricing.md`,
  Marketstack, Massive, Alpha Vantage premium, Tiingo matrix).
- Updated `src/lib/provider-tier-plan.ts` labels + `TIER_QUOTA_WINDOWS` +
  `roicTranscriptQuartersForPlan` to match vendor units.
- Updated free-safe defaults in `src/lib/provider-rate-limit.ts`
  (`RATE_QUOTAS` + ROIC `HARD_DEFAULTS` minInterval).
- Documented verification table and new traps in
  `docs/market-data-provider-pricing.md`.
- Tests: `test/provider-tier-plan.test.ts`, `test/provider-rate-limit.test.ts`,
  `test/roic-transcripts.test.ts`.

### Files touched

- `src/lib/provider-tier-plan.ts`
- `src/lib/provider-rate-limit.ts`
- `test/provider-tier-plan.test.ts`
- `test/provider-rate-limit.test.ts`
- `test/roic-transcripts.test.ts`
- `docs/market-data-provider-pricing.md`
- `docs/rollouts/2026-08-06-plan-tier-research.md`
- `docs/EFFORT-LOG.md` (+ live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`)
- `STATUS.md`

## Decisions & Trade-offs

| Topic | Decision |
|---|---|
| ROIC | Free **5/min**, Individual **300/min** + **20** transcript quarters, Pro unlimited + app cap 40 quarters/symbol/run. Removed invented `starter` tier. |
| Twelve Data | Family ids map to **floor** SKU (grow→55); exact `grow_377` etc. for paid SKUs. |
| Marketstack | Monthly caps via 30d rolling window (100 / 10k / 100k / 500k) — not daily invents. |
| Finnhub All-In-One | Empty tier windows (no invented RPM); set env when owner has dashboard facts. |
| FilingAPI / Marketaux / etc. | Free-safe placeholders only; paid = env, not invented high daily. |
| ROIC pacer | Free-safe `minIntervalMs` 12s (5/min). Paid Individual should set plan tier and/or `PROVIDER_RATE_LIMIT_ROIC_PER_MIN` so pacing is not stuck at free. |

## Verification State

Commands (targeted first, then full gate before land):

```bash
npx vitest run test/provider-tier-plan.test.ts test/provider-rate-limit.test.ts test/roic-transcripts.test.ts
npx tsc --noEmit
# land.sh runs lint/test/build
```

## Next Steps & Blockers

1. Owner: set Connections **ROIC plan = Individual** after deploy (if on paid $29).
2. Owner: if Twelve Data is paid Grow 377, pick **Grow 377** not plain Grow (floor 55).
3. Optional peer pass: FilingAPI, Marketaux, EarningsCalls full-text plan, RapidAPI
   product-specific Basic/Pro pages (not finished this pass).
4. After ROIC Individual + deploy: confirm `roic_transcript_ingested > 0`.

## Zero-Code Findings

- Prior agent code assumed ROIC free ~300/day and Individual ~10k/day — **wrong**
  vs https://www.roic.ai/pricing (per-minute + quarter depth).
- Twelve Data Grow default of 377 over-admits the $29/55 SKU.
- Marketstack free 100/month was approximated as 3/day; UI and billing are monthly.
