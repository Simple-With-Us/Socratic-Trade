# 2026-11-13 - st-5391-pending-status-entries

## Summary

- Marks the STATUS.md entries for ST-4622, ST-4611, ST-4618, ST-4633, ST-4631 and ST-2797 as proposed and pending, each naming its still-open source PR: #5158, #5142, #5155, #5175, #5172, #5157.
- Marks the PLAN.md entries for ST-4633 (#5175) and ST-4631 (#5172) as proposed and pending.
- The ST-4631 entry separates what `main` already has (middleware session gate and peer-path exclusion) from what #5172 proposes (handler session-provenance guard and six-per-minute `enforceRateLimit` cap).

## Why

- #5391 recorded these efforts as landed while their source PRs were still open.  Entries for merged PRs are untouched.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-13-st-5391-pending-status-entries.md`

## Verification

- `gh pr view <n> --json state` for each of the six PRs showed none merged when the entries were written.
- `grep -n "flatfile" middleware.ts` shows the session-gate comments at lines 158 and 625; `app/api/market/flatfile/route.ts` on main has no handler session guard or rate limit.
- Docs only: no code, tests or build affected.

## Follow-ups

- When each source PR merges, drop its Pending line and the PLAN marker.
- ST-4631 Next paragraph now says #5172 is open.
