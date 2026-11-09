# 2026-06-29 - Gitleaks self-hosted temp cleanup

## Summary

- Added a Security workflow step that removes stale macOS gitleaks installer
  temp artifacts before running the pinned `gitleaks/gitleaks-action`.
- Refreshed ops/security docs that still described GitHub Actions gitleaks
  wiring as deferred.

## Why

The self-hosted macOS runner failed the `gitleaks` job before scanning because
the pinned action attempted to download `gitleaks_8.24.3_darwin_arm64.tar.gz`
to a fixed `${TMPDIR}/gitleaks.tmp` path that already existed from a previous
run. Cleaning only that installer artifact and the matching partial version
directory preserves the pinned action's scan behavior while making the
persistent runner idempotent.

## Files

- `.github/workflows/security.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/ops-observability-security.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-29-gitleaks-temp-cleanup.md`

## Verification

- Targeted cleanup snippet - passed; a temporary `TMPDIR` containing
  `gitleaks.tmp` and `gitleaks-8.24.3` was cleaned by the workflow shell logic.
- `npm run lint` - passed; existing warnings only.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 155 files / 1,494 tests.
- `npm run build` - passed; Next.js emitted the existing
  middleware-to-proxy deprecation warning.

## Follow-ups

- If GitHub-hosted runners become available again and Security moves back to
  `ubuntu-latest`, this cleanup step can remain harmless or be removed with the
  self-hosted runner workaround.
