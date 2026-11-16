# Rollout: plan-tier dropdowns for all market-data sources

## Context & Objective

Owner: plan tier dropdown should exist for every data source we use or have used
(other than free-only contact strings), with the full ladder of tiers a user might
hold, and the app must know respective rate limits for each.

## Changes Made

- Expanded `src/lib/provider-tier-plan.ts`:
  - Full tier ladders + quota windows for: tiingo, massive, fmp, twelvedata, finnhub,
    alphavantage, marketstack, roic, filingapi, fintechstudios, marketaux, earningscalls,
    rapidapi, fred, apify, logodev, tradier, pinecone, voyage, siliconflow.
  - `PLAN_TIER_REQUIRED_SERVICES` + tests that every required service has ≥2 tiers and
    free-safe default quotas.
  - SEC User-Agent and LLM keys stay non-tier (contact / model keys, not vendor plan ladders).
- Connections copy lists all data-platform keys that need a plan selection.
- Free-safe `RATE_QUOTAS` defaults for marketaux, earningscalls, rapidapi, fred, apify,
  logodev, fintechstudios when no tier is declared.

## Verification

```bash
npx vitest run test/provider-tier-plan.test.ts
```

## Operator note

After deploy: open Connections and set each paid key's plan (especially Massive Starter,
ROIC Individual, Tiingo Power if applicable). Until set, free-safe caps apply.
