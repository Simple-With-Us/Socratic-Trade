# Wise relay read-only readiness canary (PR #4949)

## Context & Objective

Ship a read-only GitHub Actions canary that mints a Wise relay token and exercises non-mutating API reads, without cutting merge callers over to the relay (PR #4948).

## Changes Made

- `scripts/wise-relay-exec.py`: read-only Infisical folder, scope verification, actor injection, malformed scope fail-closed.
- `scripts/test_wise_relay_exec.py`: unit coverage wired into CI selftests.
- `.github/workflows/wise-relay-canary.yml`: manual dispatch canary.
- `scripts/merge-shepherd.sh` + `_merge-shepherd-impl.yml`: required `--expected-actor` (no actor guessing).
- Docs: launchd `--expected-actor` recipe in `docs/rollouts/2026-07-09-merge-shepherd.md`.

## Decisions & Trade-offs

- Read-only canary uses `/gr-front/wise-st-readonly`; merge path unchanged until #4948 lands.
- Caller-supplied `--expected-actor` is refused (relay sets it); PAT `/user` probe failure aborts rather than falling back to a wrong login.

## Verification State

- `python3 -m unittest scripts/test_wise_relay_exec.py`
- `npm run lint` (0 errors)
- `npx tsc --noEmit`
- `npm test`
- `npm run build`

## Next Steps & Blockers

- Owner: apply Mac launchd `ProgramArguments` after merge (host-local).
- After merge: run `Wise relay read-only canary` workflow_dispatch once with Infisical token in `merge-shepherd` env.

## Zero-Code Findings

None on this pass.
