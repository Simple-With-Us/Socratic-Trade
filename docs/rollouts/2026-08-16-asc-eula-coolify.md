# 2026-08-16 — ASC EULA / What's New + Coolify rolling already off [GROK]

## 1. Context & Objective

Owner authorized App Store Connect writes and the Coolify rolling-replacement
steps from the Monet audit leftovers.  Goal: put custom EULAs and beta-review
contacts in ASC, match Congress.Trade store version to `1.0.0`, and turn off
Coolify rolling on `socratic-app` so two Litestream writers cannot overlap.

## 2. Changes Made

ASC (live writes via `ios-fleet/asc-api.mjs`, no repo code path):

- Socratic Trade custom EULA patched to two spaces between sentences
  (`6e6ecf7e-…`, 853 chars).
- What's New on version `1.0.0` could not be edited.  Apple `STATE_ERROR`:
  `Attribute 'whatsNew' cannot be edited at this time` (first version,
  `PREPARE_FOR_SUBMISSION`).
- Beta App Review was already filled (Jay Wedgeworth, OAuth-only notes).

Coolify app `socratic-app` (`<ST_COOLIFY_APP_UUID>`):

- `settings.is_consistent_container_name_enabled` is already `true`.
- `health_check_start_period` is already `60`.
- No Coolify PATCH.  Rolling replacement is already off.

Touched (this docs PR):

- `docs/rollouts/2026-08-16-asc-eula-coolify.md` (this note)
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`

## 3. Decisions & Trade-offs

- Did not delete B2 L1/L2 objects.  Owner asked for the Coolify steps; those
  were already in the desired state.  L2 remains empty/wedged until a
  one-time B2 cleanup is separately authorized.
- Did not invent What's New on a first version Apple refuses to accept.
- Did not touch the Congress.Trade Guideline 2.1 Resolution Center reply.

## 4. Verification State

```
coolify get_application <ST_COOLIFY_APP_UUID>
  is_consistent_container_name_enabled=true
  health_check_start_period=60

GET /v1/apps/6799238379?include=endUserLicenseAgreement,betaAppReviewDetail
  EULA present, 853 chars, two-space sentences
  beta review: Jay Wedgeworth, demoAccountRequired=false
```

## 5. Next Steps & Blockers

- Owner: authorize B2 L1 twin delete if L2 should rebuild.
- What's New can be set on the first *update* version after 1.0.0 ships.
- Native TestFlight still needed for ticker-desk / quote-stats on a device.

## 6. Zero-Code Findings

Coolify rolling-off from the 2026-08-13/14 notes is already applied.  The
remaining backup work is B2 object cleanup, not another Coolify toggle.
