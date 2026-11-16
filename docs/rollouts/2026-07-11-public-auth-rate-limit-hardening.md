# 2026-07-11 — Public auth + paid-route rate-limit hardening

## Summary

- Keyed the public Robinhood OAuth callback limiter by trusted Cloudflare client IP before any
  OAuth-state lookup. OAuth `state` and spoofable `X-Forwarded-For` values never affect the key.
- Bounded the in-process sliding-window limiter to 10,000 live subjects, with opportunistic expiry
  sweeps and deterministic least-recently-used eviction at capacity.
- Parsed `CF_ACCESS_TRUST_EMAIL_HEADER` with the existing explicit truth vocabulary. Values such as
  `0`, `false`, `no`, and `off` now disable CF-header identity; Auth.js remains fail-closed.
- Added the named `RATE_LIMITS.strategyTuning` class (10 requests/minute/user) plus a
  one-in-flight-per-user guard before the paid strategy-tuning LLM call.

## Why

The whole-app audit found three bounded security/reliability gaps: attacker-controlled OAuth state
created a fresh public rate-limit bucket per request, the limiter retained subjects indefinitely,
and the production-style string value `CF_ACCESS_TRUST_EMAIL_HEADER=0` was truthy. Manual strategy
tuning was also a paid LLM route without the rate-limit coverage already present on chat and scans.

## Files

- `app/api/auth/robinhood/callback/route.ts`
- `app/api/strategy/tune/route.ts`
- `middleware.ts`
- `src/lib/rate-limit.ts`
- `test/middleware-auth.test.ts`
- `test/public-auth-rate-limit-hardening.test.ts`
- `test/rate-limit.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-07-11-public-auth-rate-limit-hardening.md`

Deliberately untouched because active broker/DB PRs overlap them:
`app/api/connected-accounts/route.ts`, `src/lib/alpaca.ts`, `src/lib/db-api-keys.ts`, and
`src/lib/db.ts`.

## Verification

- `npx vitest run test/rate-limit.test.ts test/public-auth-rate-limit-hardening.test.ts test/middleware-auth.test.ts test/security-route-rate-limit.test.ts`
  - Passed: 4 files / 37 tests.
- `npx eslint src/lib/rate-limit.ts app/api/auth/robinhood/callback/route.ts app/api/strategy/tune/route.ts middleware.ts test/rate-limit.test.ts test/public-auth-rate-limit-hardening.test.ts test/middleware-auth.test.ts`
  - Passed: 0 errors.
- `npx tsc --noEmit`
  - Passed: no diagnostics.
- `npm ci`
  - Two isolated-worktree install attempts were killed with exit 137 during shared-Mac load. Used
    an APFS copy-on-write clone of a lockfile-identical peer worktree's completed dependency tree;
    no tracked files changed.
- `git diff --check` — passed.
- `npm run lint`
  - Passed: 0 errors / 378 existing warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh`
  - Passed: TypeScript clean; 319 test files / 3,499 tests; Next.js build clean.
  - Pushed the branch and opened READY PR #1399. No merge or auto-merge was requested.
- The first `land.sh` attempt used the default Node 26 runtime against the copied Node 24
  `better-sqlite3` binary and failed uniformly with ABI 147 vs 137 before build. Per the shared gate
  protocol, the lane was released, then reclaimed once for the ABI-matched Node 24 command above;
  no reinstall or repeated retry loop was performed.

## Follow-ups

- No product roadmap or phase scope changed, so `PLAN.md` is unchanged.
- This PR does not attempt distributed rate limiting; production currently runs one Next process.
- `.env.example` was deliberately left untouched because active PR #1389 overlaps it; the exact
  flag semantics are documented here and enforced by middleware tests.
- Live board intentionally not modified per coordinator instruction; this branch updates only the
  repo mirror.
