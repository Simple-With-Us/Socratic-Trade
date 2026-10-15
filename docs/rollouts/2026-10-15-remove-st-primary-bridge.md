# Remove obsolete ST primary-user Infisical key bridge (ST-4318)

## Context & Objective

Owner requested permanent removal on 2026-10-06 after repeatedly disabling the default-off Usage Monitor credential bridge.  This rollout deletes the writer code and active setup instructions from Socratic-Trade while preserving encrypted user API keys, tombstones, and ordinary usage reporting.

## Changes Made

- Removed `src/lib/st-primary-bridge-writer.ts` and `test/st-primary-bridge-writer.test.ts`.
- Dropped scheduler `st-primary-bridge-writer` journal lane and `/api/keys` post-delete sync triggers.
- Removed `INFISICAL_ST_PRIMARY_WRITER_*` from `.env.example`, `README.md`, `docs/secrets.md`, and `docs/FEATURE-ENABLEMENT-BACKLOG.md`.
- Updated `PLAN.md` and `STATUS.md`.

**Files touched:**

- `src/lib/st-primary-bridge-writer.ts` (deleted)
- `test/st-primary-bridge-writer.test.ts` (deleted)
- `src/lib/scheduler.ts`
- `app/api/keys/route.ts`
- `.env.example`
- `README.md`
- `docs/secrets.md`
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-10-15-remove-st-primary-bridge.md`

## Decisions & Trade-offs

- No remote Infisical secret deletion or credential migration (per issue scope).
- Historical rollout notes under `docs/rollouts/2026-07-15-*` and audit docs left as archaeology.
- Usage Monitor `infisical-provider-sync.ts` reader handling is out of repo; separate UM issue.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- Merge PR after `verify` CI green.
- Owner may retire unused Infisical writer identities and `/usage-monitor/st-primary/v1` secrets manually if desired.
- Complete paired UM reader removal in Usage Monitor repo when scheduled.

## Zero-Code Findings

None.
