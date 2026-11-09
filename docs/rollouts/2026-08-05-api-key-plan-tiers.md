# 2026-08-05 — API key plan-tier dropdowns (Connections)

## Context & Objective

Optional market-data keys (Tiingo, Finnhub, Twelve Data, Massive, …) need a
declared **plan tier** so free vs paid quotas match what the owner actually pays
for — without requiring Infisical `PROVIDER_QUOTA_*` knobs alone. Closes the
product gap called out in `docs/source-capability-matrix.md` §6.

## Changes Made

- New `src/lib/provider-tier-plan.ts`: per-service tier options + quota windows
  (from `docs/market-data-provider-pricing.md`). Registry for operator plan-tier
  lookup used by `resolveProviderQuota`.
- DB migration **v70** `user_api_keys.plan_tier` + CREATE TABLE column for fresh DBs.
- `db-api-keys`: persist `planTier` on upsert; `setUserApiKeyPlanTier` for tier-only
  updates; register LOCAL_USER lookup for quota resolver.
- `provider-rate-limit.resolveProviderQuota(provider, planTier?)`: precedence
  env → Usage Monitor knobs → declared plan tier → `RATE_QUOTAS` hard defaults.
- `/api/keys` GET returns `planTier` + `planTierOptions`; POST accepts `planTier`
  with or without a new secret; catalog adds roic/filingapi/marketaux/earningscalls/rapidapi;
  FMP row marked **Retired · CT-only**.
- Connections UI: plan `<Select>` beside optional market-data keys; KeyEditor
  includes plan on save; FMP add/replace disabled with retired chip.

### Files touched

- `src/lib/provider-tier-plan.ts` (new)
- `src/lib/provider-rate-limit.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/db.ts` (migration 70; CREATE TABLE plan_tier)
- `app/api/keys/route.ts`
- `app/console/settings/api-keys.tsx`
- `app/console/settings/lib.ts`
- `test/provider-tier-plan.test.ts` (new)
- `docs/source-capability-matrix.md` §6
- `docs/EFFORT-LOG.md`, `STATUS.md`, this rollout

## Decisions & Trade-offs

- **Env still wins** over UI tier (operators who set Infisical knobs keep them).
- **Operator (`local`) key tier** seeds process-wide quota defaults for shared
  market-data lanes; per-user multi-tenant quota-by-tier is not required for ST’s
  single-owner deployment today.
- **FMP stays in the catalog** as retired (visible + disabled) rather than hard-deleted,
  so archaeology and CT-only labeling stay honest. Does not re-enable product FMP calls.
- Massive paid starter maps to **empty** tier windows (unlimited REST); free stays 5/min.

## Verification State

```bash
npx vitest run test/provider-tier-plan.test.ts test/provider-rate-limit.test.ts test/api-key-preview.test.ts
# 13 + 77 tests green
npx tsc --noEmit  # clean
```

## Next Steps & Blockers

- Optionally flip `TIINGO_DROP_NEWS` when tier is declared `power` (still env today).
- Wire marketstack `admitProviderRequests` to use the same quota windows (entry exists).
- Coordinate with FMP Connections-health OFF UI (other agent) — this change only
  touches the key form, not health panels.
