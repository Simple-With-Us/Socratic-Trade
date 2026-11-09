# 2026-06-21 — Fix flaky CI timeout in approval-lock.test.ts

## Summary

Raised the per-test timeout to 20s on the two `approval-lock.test.ts` tests that let
`executeProposal` run its full broker-review path, so they stop intermittently failing
CI with `Test timed out in 5000ms`.

## Why

`executeProposal` with no broker configured exhausts the broker-review retry/backoff
sequence before throwing. On a loaded CI runner that can exceed vitest's 5s default,
so the two tests that exercise the real path (`releases the lock after executeProposal
runs` and `does not interfere with a different user's lock`) flaked — one of them
failed #40's first CI run and was only cleared by a re-run. The other two tests in the
file hold the lock first, so `executeProposal` returns `busy` immediately and never
hits the slow path; they were left unchanged.

The fix is a timeout bump, not a logic change — the tests assert lock behavior, not
timing, so giving the broker path margin is the correct, minimal fix. It does not mask
a real hang (a genuine deadlock would still fail at 20s).

## Files

- `test/approval-lock.test.ts` — `}, 20000);` on the two slow tests
- `STATUS.md`, this rollout note

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run test/approval-lock.test.ts` — 4/4 pass

## Follow-ups

- A deeper fix would make `executeProposal` fail fast (or be mockable) when no broker is
  configured, removing the slow path entirely. Deferred — the timeout bump is sufficient.
