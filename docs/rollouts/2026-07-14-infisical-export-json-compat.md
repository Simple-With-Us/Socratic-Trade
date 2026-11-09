# Infisical JSON-export production compatibility

## Summary

PR #1594 hardened the local machine-identity bootstrap but its automatic Coolify deployment failed
the new-container health check and rolled back. Pinned Infisical CLI v0.43.98 serializes
`export --format json` as an array of `SingleEnvironmentVariable` records; the merged runner had
incorrectly required a flat object. The corrective parser implements the real wire shape and fails
closed on ambiguous input.

## Files changed

- `scripts/infisical-run.mjs` — validate an array of records, copy only string `key`/`value`, reject
  duplicates, malformed entries, invalid keys, and NULs.
- `test/infisical-bootstrap.test.ts` — model the pinned CLI output and cover incorrect/malformed
  shapes without leaking output.
- `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, and `docs/secrets.md` — record deployment and format
  truth.

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/infisical-bootstrap.test.ts`
- scoped ESLint and `npx tsc --noEmit`
- `git diff --check`
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh --pr-title "Fix Infisical JSON export compatibility"`
- After merge, require Coolify to report the exact merge SHA and confirm `/api/health` is healthy.

## Follow-ups

- Do not release the held shared-package consumer lane until the corrective production SHA is live.
- Keep the CLI version pinned; update parser tests deliberately if the upstream JSON contract changes.
- Make `scripts/coolify-prod-start.sh` compare the cached Infisical executable's actual version with
  `INFISICAL_CLI_VERSION` and reinstall on mismatch; current production cache is known v0.43.98.
