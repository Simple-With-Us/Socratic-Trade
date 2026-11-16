# Shared-package pin-check queue unblock — 2026-07-22

## Summary

Replaced the stale #1780 vehicle with a minimal workflow correction: the shared-package pin check
now runs on every pull request and installs Node 24 before its comparison script.

## Why

The current workflow's pull-request `paths` filter emitted no check for most PRs, and the check's
shell script invoked `node` before any setup-node step. Hosted run 29915655110 failed at line 102
with `node: command not found`; unrelated PRs could also be stranded with no pin status at all.

## Files

- `.github/workflows/shared-package-pin-check.yml`
- `test/ci-workflow-queue-safety.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-07-22-shared-package-pin-check-queue-unblock.md`

## Verification

- `npx vitest run --maxWorkers=1 test/ci-workflow-queue-safety.test.ts` — 5 tests passed.
- `npx eslint test/ci-workflow-queue-safety.test.ts` — passed.
- `npx tsc --noEmit` — passed.
- `node -e "const fs=require('node:fs'); const yaml=require('js-yaml'); yaml.load(fs.readFileSync('.github/workflows/shared-package-pin-check.yml','utf8'));"` — YAML parsed successfully.
- `git diff --check` — passed.
- Hosted `CI / verify-hosted` run `29941083303` — passed 2026-07-22 17:46 UTC; the required `CI / verify` gate was queued immediately afterward.

## Combined landing

The reviewed workflow correction is subsumed into telemetry PR #1889 so both changes consume one
protected gate. PR #1890 is closed as superseded after subsumption, with its branch retained and
reopenable; #1780 was already closed. The combined Node 24 local gate passes 5 files / 71 tests,
TypeScript, scoped ESLint, workflow YAML parsing, and diff-check. Auto-merge remains off until the
final combined head passes hosted checks and zero-thread verification. Do not restore `check-pin` as
a required context until both consumers' shared-package pins are coordinated.
