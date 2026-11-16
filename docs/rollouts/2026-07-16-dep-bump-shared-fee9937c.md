# 2026-07-16: Bump congress-trading-shared to fee9937c

## Summary

Bumped `@jaywedgeworth22/congress-trading-shared` from `ef17b72` to `fee9937c25db1de75c1a676826801e3399f36106` in both `package.json` and `package-lock.json`, including the npm `allowScripts` entry.

## Why

Keep the shared-contract dependency current. The new commit includes the company-name standardization support needed by the `antigravity/company-name-standardization-part2` branch's feature work.

## Files

- `package.json` — dependency ref + allowScripts entry updated to `fee9937c`
- `package-lock.json` — regenerated lockfile reflecting the new commit
- `STATUS.md` — added entry for this PR
- `docs/EFFORT-LOG.md` — added Completed row
- `docs/rollouts/2026-07-16-dep-bump-shared-fee9937c.md` — this file

## Verification (2026-07-16 codex-autofix round)

- `npm run lint` — 0 errors (491 inherited warnings)
- `npx tsc --noEmit` — clean
- `npm test` — 402 files / 4665 tests passed
- `npm run build` — clean (all static pages)
- Merged `origin/main` to bring branch current before verification

## Follow-ups

None — this is a routine dependency bump. The feature work that consumes the new shared-contract API lands via the parent `antigravity/company-name-standardization-part2` branch.
