# Identity fail-closed in live bootstrap (`identity-fails-open`)

## Context & Objective

Expert review cluster `identity-fails-open` (sec-01): when `AUTH_SECRET` is missing, middleware treated every anonymous request as the primary owner.  Production had an `ENCRYPTION_KEY` boot guard but no equivalent for identity.  This change refuses live boots without a real identity source and blocks the dev local-fallback path when `DB_BOOTSTRAP=live`.

## Changes Made

- Added `src/lib/auth-secret-guard.ts` with `isLiveBootstrap`, `isAuthIdentitySourceConfigured`, and `assertAuthSecretConfiguredInLiveBootstrap`.
- `instrumentation.ts`: call the new assert immediately after `assertEncryptionKeyConfiguredInProduction()`.
- `middleware.ts`: gate Source 3 (`PRIMARY_EMAIL` local fallback) on `!isLiveBootstrap()` so live anonymous requests fail closed (401 / `/login` redirect).
- `src/lib/request-user.ts`: refuse anonymous or `local-fallback` provenance when `DB_BOOTSTRAP=live`.
- Tests: `test/auth-secret-guard.test.ts`, `test/request-user-live-bootstrap.test.ts`, and two new cases in `test/middleware-auth.test.ts`.

## Decisions & Trade-offs

- Used `DB_BOOTSTRAP=live` (not `NODE_ENV=production`) as the production marker — matches Coolify prod boot and avoids Next edge `NODE_ENV` inlining pitfalls documented in `middleware.ts`.
- CF Access counts as configured only when trust flag **and** `CF_ACCESS_TEAM_DOMAIN` **and** `CF_ACCESS_AUD` are set (stricter than middleware `isAuthConfigured()`, which only checks the flag for arming).
- Did **not** remove the widespread `userId = "local"` defaults across db modules in this PR — scope stays on the anonymous-as-owner path; follow-up can make those parameters required.

## Verification State

```bash
npm test -- test/auth-secret-guard.test.ts test/request-user-live-bootstrap.test.ts test/middleware-auth.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

- Auth cluster tests: 49 passed (3 files).
- `npx tsc --noEmit`: clean.
- `npm run lint`: 0 errors (warnings only).
- `npm run build`: clean.

## Next Steps & Blockers

- None for this cluster.  Later P2 work (`auth-session-hardening`) is out of scope.

## Zero-Code Findings

- Confirmed `scripts/coolify-prod-start.sh` exports `DB_BOOTSTRAP=live` for production boots.
