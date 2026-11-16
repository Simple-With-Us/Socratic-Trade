# 2026-09-04 — ST Web Session Replay Defaults to 10%

Board `af1ab6e9`.  Branch `grok/sentry-max-replay-10`.  Worktree
`~/apps/trading-grok-sentry-replay-10`.  Follow-up to merged #3165
(`de236a63`), which left web session Replay at 0%.

## Changes

- Code default is now **session 10% / error 100%**
  (`NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0.1"`, error
  `?? "1.0"`).  This is a code default, not a Coolify-only note.
- Kill switches remain: `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=false` and
  sample-rate env vars.
- `.env.example` documents the new defaults (enabled, session `0.1`).
- Mask-all Replay and Feedback are unchanged.

## Verification

- `npx vitest run test/sentry-tunnel-middleware.test.ts`
