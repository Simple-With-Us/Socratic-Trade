# 2026-07-11 — Alpha Vantage health lane canonicalization

## Summary

Corrected the admin connections-health expected-lane inventory from the API-key slug
`alphavantage` to the canonical provider health identity `alpha-vantage`. The route's existing
`(service,keySource)` map now merges the expected env lane with real Alpha Vantage health history
instead of rendering an additional empty card.

Added an authenticated route regression that writes a successful `alpha-vantage:env` health row,
calls the admin endpoint using verified Auth.js provenance, and proves the response contains exactly
one canonical lane and no `alphavantage` entry.

## Why

Production investigation found the visible Alpha Vantage failures were genuine free-plan daily-cap
exhaustion. The separate neutral card was not another credential or provider lane; it was a spelling
mismatch confined to `EXPECTED_BACKEND_LANES`. Correcting the inventory removes misleading operator
state without changing provider behavior, secrets, pacing, rotation, or quota classification.
PR #1392 (`32783b12`) is the current provider behavior: one singular key (or the first legacy plural
entry) because the free cap is enforced per source IP. This change does not revive the historical
six-key rotation described by the July 9 rollout.

## Files

- `app/api/admin/connections-health/route.ts`
- `test/connections-health-route.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-09-alert-triage-av-multikey.md`
- `docs/rollouts/2026-07-11-alpha-vantage-health-lane-canonicalization.md`

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --no-audit --no-fund` — installed the locked
  dependencies in the isolated worktree.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/connections-health-route.test.ts` —
  1 file / 1 test passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint app/api/admin/connections-health/route.ts test/connections-health-route.test.ts`
  — passed with no findings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — 332 files / 3,747 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — passed; only the inherited Next.js
  middleware deprecation, Sentry Edge-runtime, and webpack cache serialization warnings appeared.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors / 404 inherited
  warnings.
- `git diff --check` — passed before handoff.

The initial focused-test attempt used the shell's default Node 26 before this isolated worktree had a
`node_modules`; Vitest could not load its config because the package was not installed. During the
full gate, two mistakenly unprefixed `npm test` launches also used Node 26 and produced expected
`better-sqlite3` ABI-load cascades; both were stopped. These were runtime-selection failures, not code
failures. The locked install and final ordered checks passed under Node 24.

## Follow-ups

- Ready PR: `#1438` at head `1687974c`, reconciled through `main@da9558ac`; wait for hosted
  verify/smoke/security before merge.
- After merge and auto-deploy, confirm `/admin/connections` shows one Alpha Vantage env lane and no
  legacy-spelling placeholder.
