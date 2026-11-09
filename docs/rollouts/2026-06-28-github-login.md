# 2026-06-28 - GitHub login

## Summary
- Added conditional GitHub OAuth sign-in alongside Google through Auth.js.
- Updated the login page to render every configured Auth.js provider instead of hardcoding Google.
- Required GitHub to return a verified email through the `user:email` scope before accepting sign-in.
- Kept app identity email-based, so Google and GitHub sign-ins with the same verified email map to the same app account.
- Prefer an app-allowed verified GitHub email (`PRIMARY_USER_EMAIL`, aliases, or `ALLOWED_EMAILS`) before GitHub's primary verified email when a GitHub account has several verified addresses.
- Updated account-deletion copy, auth docs, env docs, and focused identity/middleware tests.

## Why
The app already derives users from normalized verified email. Adding GitHub should therefore use the same identity primitive rather than introducing a second provider-account identity model. That gives same-email Google/GitHub account continuity now, while leaving a future `user_identities` table for provider-account-id linking if private relay or non-email identity becomes first-class.

## Files
- `.env.example`
- `PLAN.md`
- `STATUS.md`
- `app/dashboard-client.tsx`
- `app/login/page.tsx`
- `docs/deployment.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-28-github-login.md`
- `middleware.ts`
- `src/lib/auth/auth.ts`
- `src/lib/auth/github-email.ts`
- `src/lib/auth/identity.ts`
- `src/lib/request-user.ts`
- `test/auth-github-email.test.ts`
- `test/auth-identity.test.ts`
- `test/middleware-auth.test.ts`

## Verification
- `npm ci` (installed dependencies for this isolated worktree; npm reported two existing moderate audit findings and pending install-script approvals).
- `npx tsc --noEmit` - clean.
- `npx vitest run test/auth-identity.test.ts test/middleware-auth.test.ts` - 2 files / 22 tests passed.
- `npm test` - 155 files / 1,495 tests passed.
- `npm run build` - passed; existing Next.js middleware-to-proxy deprecation warning only.
- Local smoke with dummy provider envs on `http://127.0.0.1:4126`: `/login` rendered both `Sign in with Google` and `Sign in with GitHub`; `/api/auth/providers` returned both provider IDs and callback URLs.
- Landing: `bash scripts/land.sh` passed local gate again, pushed `codex/github-login`, and opened PR #224.
- Initial GitHub PR checks were blocked before runner startup by an account billing/spending-limit annotation. After the billing issue was fixed, rerunning checks on PR #224 passed `verify`, `smoke`, and `gitleaks` on head `9dd2778c`.
- Merged current `origin/main` from PR #225 into this branch after GitHub reported PR #224 was behind; final revalidation/push is in progress.
- Codex review follow-up: added `test/auth-github-email.test.ts` for choosing an app-allowed verified GitHub email before GitHub's primary email.

## Follow-ups
- Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` in production before expecting the GitHub button to appear live.
- A future provider-account-id table can link accounts even when provider emails differ; this change intentionally links only same verified email plus configured primary aliases.
