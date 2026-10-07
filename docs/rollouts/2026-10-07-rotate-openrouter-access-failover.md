# 2026-10-07 — `__rotate__` OpenRouter access-denied failover depth

## Context & Objective

Prod Autopilot (`__rotate__` Green + Red) saw three consecutive failed runs with OpenRouter HTTP 403 ("Your OpenRouter key doesn't have access to this model or region") and "Failover chain exhausted (3 Green Team endpoints)" while the scheduler stayed healthy.  The implicit rotation failover cap was pick + two alternates, so several inaccessible slugs could exhaust the chain before a reachable seat was tried.

## Changes Made

- Raised the implicit rotation failover cap (`ROTATION_IMPLICIT_GREEN_FAILOVERS` 2 → 12, hard cap 18) so Green and Red chains can walk further through the eligible pool on 403/404 access errors.
- Added `rotationPoolExcludingCooldown()` and applied it when resolving rotation picks so per-user 403 cooldown slugs are skipped at pick time, with fail-open when every member is cooling (same rule as `/models/user` allowlist emptying).
- Tests: expanded `test/model-rotation.test.ts`; new `test/strategy-rotation-openrouter-403-failover.test.ts` (Green completes after more than three 403 attempts).

**Files**

- `src/lib/model-rotation.ts`
- `test/model-rotation.test.ts`
- `test/strategy-rotation-openrouter-403-failover.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Kept `__rotate__` and existing 403 per-user cooldown recording in `strategy.ts` / `red-team.ts`; this change only deepens the implicit chain and avoids re-picking recently denied slugs.
- Cap remains bounded (not the full 21-model catalog every run) to limit credit burn on empty/malformed-200 glitches.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # exit 0
npx vitest run test/model-rotation.test.ts test/strategy-rotation-openrouter-403-failover.test.ts  # 37 passed
```

Full `npm test` / `npm run build` not re-run on this seat before handoff (CI `verify` is the merge gate).

## Next Steps & Blockers

- Merge PR after green `verify`.  No Coolify restart or deploy from this agent session (owner directive).
- After ship, confirm Autopilot Paper/Sandbox runs complete with `__rotate__` when some catalog slugs are region-restricted on the keyed OpenRouter account.

## Zero-Code Findings

- Live failure pattern matches a shallow failover chain, not SQLite/event-loop or scheduler stall.
