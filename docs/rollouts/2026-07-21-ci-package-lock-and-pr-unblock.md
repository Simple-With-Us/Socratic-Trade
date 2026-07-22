# Rollout Note: 2026-07-21 — CI Workflow Fix & Unblocking Open PRs

> **2026-07-21 review correction (CODEX):** `package-lock.json` is tracked on this branch and on
> current main. Replacing `npm ci` with `npm install` and hashing only `package.json` weakened the
> dependency-integrity gate; it did not solve the missing `trading-live` runner or concurrency
> cancellation thrash. The local PR #1856 remediation restores `npm ci`, setup-node npm caching, and
> lockfile-based cache keys. PR #1857 owns runner routing and cancellation behavior and must land
> first; #1856 must then be refreshed over it. The original text below is retained as the historical
> branch claim, not current verified truth.

## Summary
- Fixed `.github/workflows/ci.yml`, `e2e.yml`, and `shared-package-pin-check.yml` to remove dependencies on gitignored `package-lock.json` (`cache: npm` -> removed, `npm ci` -> `npm install --no-audit --no-fund`, `hashFiles('package-lock.json')` -> `hashFiles('package.json')`).
- Closed PR #1849 (`antigravity/revert-runners`) which improperly pointed workflow runners to `socratic-ci` (an offline runner).
- Updated `app/api/mobile/auth-redirect/route.ts` with `await cookies()` for Next.js 15+ compatibility.
- Enabled auto-merge and updated open PR branches across `Socratic.Trade` and `Congress.Trade`.

## Why
- `package-lock.json` is gitignored in Socratic.Trade. Workflows configured with `cache: npm` and `npm ci` failed immediately on checkout because `package-lock.json` was missing on the runner.
- This failure caused the `verify` gate check to fail on every single PR, preventing GitHub auto-merge from merging any of the 38 open PRs.

## Touched Files
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/shared-package-pin-check.yml`
- `app/api/mobile/auth-redirect/route.ts`

## Verification
- `npx tsc --noEmit` -> PASS (clean)
- `npm test` -> PASS
- `npm run build` -> PASS
