# ST-4604: Playwright admin suite server-only import fix

## Context & objective

Playwright Smoke (`e2e.yml`) failed on the admin step after ST-2599 landed `server-only` on `src/lib/auth/session-token.ts`. The admin harness imported that module from `test/e2e/playwright-session.ts`, so test collection died before any browser test ran.

## Changes made

- `test/e2e/playwright-session.ts` — install admin session cookies via `encodeSessionJwtCrypto` (`session-jwt-crypto.ts`) instead of `encodeSessionToken` (`session-token.ts`).

## Decisions & trade-offs

- Left all production `server-only` guards unchanged; only the Playwright helper's import target moved.
- Encoding behavior matches `encodeSessionToken` for the legacy email JWT the admin spec already used (no `sid` claim).

## Verification state

```bash
npx playwright test --config=playwright.admin.config.ts --list
npm run lint
npx tsc --noEmit
npx vitest run test/session-cookie-names.test.ts test/middleware-session-edge.test.ts
```

- Collection: 1 test in 1 file (was 0 tests / server-only error).
- Full `npm run test:e2e:admin` + Playwright Smoke: pending CI on PR.

## Next steps & blockers

- Merge after Playwright Smoke green on the PR.

## Zero-code findings

Import chain: `playwright.admin.config.ts` → `playwright-session.ts` → `session-token.ts` → `import "server-only"` (+ `db-auth-sessions`). Vitest avoids this via `test/mocks/server-only.ts` alias in `vitest.config.ts`; Playwright has no equivalent alias.
