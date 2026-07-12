# 2026-07-12 - app-wide audit production closeout

## Summary

- Restored the 34 individually tracked findings that were deleted by a follow-up commit on PR #1459.
- Reconciled every finding against current `origin/main@17b707ff`, the merged PR, current source,
  and production health.
- Recorded 8 resolved/production-verified findings, 13 partial/open findings, and 13 unresolved
  findings. Five of eight P0s are fully resolved; three remain partial.
- Recorded the Node runtime decision: remain on Node 24 LTS and assess Node 26 through a
  clean-install canary/coordinated migration after it reaches LTS.

## Why

An umbrella "draining and cap fixes completed" row had replaced the issue-level inventory and
overstated three P0 mitigations as complete. The effort board is the fleet's coordination surface;
removing unresolved rows can cause duplicate discovery, missed ownership, and false production
confidence.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-11-app-wide-audit-account-scope.md`
- `docs/rollouts/2026-07-12-app-wide-audit-draining-fixes.md`
- `docs/rollouts/2026-07-12-app-wide-audit-closeout.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

- GitHub PR #1459: merged as `f066ea9d`; `verify-hosted`, `verify`, `smoke`, and
  `gitleaks` all passed.
- `git merge-base --is-ancestor f066ea9d origin/main` - passed.
- Production `/api/health`: `ok=true`, exact release `17b707ff`, DB healthy, scheduler tick
  and nonexpired lease current, Litestream IPC replication current. Alpha Vantage is the known
  noncritical daily-cap degradation.
- Independent read-only reconciliation covered money-path/accounting, API/security/ingress, and
  UI/mobile/accessibility findings.
- `git diff --check` - passed.
- Inventory consistency query - both boards contain 34 unique `A01`-`A34` IDs; mirror status
  counts are exactly 8 resolved, 13 partial, and 13 unresolved.
- `git status --short` - only the six tracked closeout documents are changed; the live board is an
  intentional branch-neutral external update.
- No application source or dependency changed in this closeout commit. The merged implementation's
  hosted full verification is the application-code gate cited above.

## Follow-ups

- Fix the three partial P0s first: placing-intent maintenance under health rejection, a pre-place
  draining fence, and pending-cancel replacement completion truth.
- Then address inactive-account Red Team/post-mortem context and newest-window accounting.
- Keep every remaining row explicit on both effort boards; transition status in place and never
  replace the inventory with an umbrella completion claim.
- Reassess Node 26 after its October 2026 LTS transition using a fresh `npm ci`, native-module,
  full-gate, E2E, and production health matrix.
