# Settings busy feedback + ROIC Individual lookup

## Context & Objective

Owner set ROIC to the paid first tier (Individual) in Connections.  The dropdown
snapped back to Free for 20–30s with no spinner, then a toast.  The save itself
did land.  Follow-up: the desk in general must show that a write is in flight
instead of looking idle on button/toggle/dropdown changes.

## Changes Made

- Optimistic plan-tier + Data Sources values so the control keeps the new choice
  while the POST is still running.
- Card-level Saving…/Saved on API keys and Data Sources.
- Global **Saving…** chip in the console top bar for any POST/PATCH/PUT/DELETE
  from the console/settings request helpers.
- Plan-tier lookup now reads the logged-in user's `user_api_keys.plan_tier`, not
  only `local`.  Otherwise Individual looked saved in Settings but ROIC still
  ran as Free (5/min, 2 quarters).

Touched:

- `app/console/lib/mutation-busy.ts`, `useMutationBusy.ts`, `api.ts`
- `app/console/settings/lib.ts`, `api-keys.tsx`, `page.tsx`
- `app/console/components/shell.tsx`
- `app/console/ui/primitives.tsx`
- `src/lib/db-api-keys.ts`
- `test/mutation-busy.test.ts`, `test/provider-tier-plan.test.ts`

## Decisions & Trade-offs

- Track mutations at the fetch helper, not per-control.  That covers Settings,
  Connections, Strategy, Guardrails, and chrome actions that already go through
  those helpers.
- Success toasts on every Data Sources toggle were dropped in favor of the
  inline Saved chip (errors still toast).
- Multi-user: if two accounts declared different ROIC tiers, lookup takes the
  first non-local row.  ST is single-operator.

## Verification State

Focused: `npx vitest run test/mutation-busy.test.ts test/provider-tier-plan.test.ts`

## Next Steps & Blockers

None for this unit.  Prod already has the Individual row; after this deploys,
quotas and 20-quarter depth follow it without a re-click.
