# 2026-08-13 — Provider-tier honesty (`dataProvidersDegraded`)

## Context & Objective

Owner: `dataProvidersDegraded` must not flip just because they changed a plan to a
lower (still paid/correct) tier.  It should alert only if a provider is broken or
not working at the tier that was paid for.

Live Massive on Stocks Basic (`history_cap_blocked` on a ~2.5y window) was painting
`/api/health` red even though that cap is the plan they configured.

## Rule

Degrade only when:

1. The paid/expected Settings plan is not what the probe sees, or
2. The provider is not working (probe failure).

A deliberate downgrade to free or a lower paid SKU that **matches** the configured
plan is healthy.  Massive `history_cap_blocked` on ~2.5y is expected on Stocks Basic.
It is degraded only if the configured plan is Starter/Developer/Advanced (those SKUs
include ≥5y history) and the probe 403s or empties that window.

## Changes

- `src/lib/provider-tier-plan.ts`: `massivePlanAllowsDeepHistory`.
- `src/lib/provider-tier.ts`: `evaluateDataProviderHonesty` / `isDataProvidersDegraded`;
  lapse alerts only on a paid/expected mismatch or a later probe failure.
- `app/api/health/route.ts`: uses the honesty helper instead of `tier === "free"`.
- Tests: free+expected-free = not degraded; paid-but-capped = degraded; probe
  failure = degraded.  Health-route coverage in `connection-health-routing.test.ts`.

## Keep-out

New branch `grok/st-provider-tier-honesty`.  Did not touch #2687 #2689 #2691 #2692.
