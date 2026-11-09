# 2026-06-26 — Apple Sign In provider

## Summary

Added Apple as a third OAuth sign-in option alongside Google and GitHub.

## Why

User request. Apple Sign In is a common and privacy-respecting identity choice, particularly
for operators who use Apple devices and have an Apple Developer account.

## Files

- `src/lib/auth/auth.ts` — conditionally registers Apple provider; `signIn` callback gates
  GitHub on verified emails (calls `/user/emails` to check the `verified` flag) and gates
  Apple on non-null email (first-auth-only caveat).
- `app/login/page.tsx` — added `appleConfigured` check, Apple sign-in button (dark styled per
  Apple HIG), `AppleIcon` SVG component; updated "not configured" hint to mention Apple vars.
- `.env.example` — documents `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` with full Apple Developer
  Portal setup steps (`npx auth add apple`), expiry warning, and private relay email note.
- `docs/rollouts/2026-06-26-apple-login.md` — this file.

## Apple-specific caveats (operator must know)

1. **Email only on first authorization.** Apple sends the user's email once — at the moment
   they first authorize the app. Subsequent re-authorizations (e.g. after session expiry or
   cookie clear) will NOT include the email, and the `signIn` callback will reject the attempt.
   The session JWT cookie has a 30-day lifetime, which covers normal usage. **Keep at least
   one other provider (Google or GitHub) active** so users can always sign back in.

2. **Client secret expires.** The `AUTH_APPLE_SECRET` is a JWT you generate using your Apple
   private key. It is valid for up to 6 months and must be regenerated and re-injected before
   it expires. Set a calendar reminder; an expired secret blocks all Apple sign-ins.

3. **Private relay email.** If the user chooses "Hide My Email", Apple provides a proxy
   address (`xxx@privaterelay.appleid.com`). This address will NOT match `PRIMARY_USER_EMAIL`
   or a typical `ALLOWED_EMAILS` entry — add the relay address to `ALLOWED_EMAILS` if needed.

4. **Callback URL.** The Apple Services ID must list:
   `https://<your-domain>/api/auth/callback/apple`

## Generating AUTH_APPLE_SECRET

```bash
npx auth add apple
```

Interactive CLI — prompts for Team ID, Key ID, and the `.p8` private key path, then writes
`AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` directly to your `.env` file. The generated JWT is
valid for up to 6 months; set a reminder to regenerate before it expires.

## Follow-ups

- **Infisical**: add `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` to the `agentic-trading` project
  when provisioning Apple sign-in.
- **Secret rotation**: `AUTH_APPLE_SECRET` JWT expires in ≤6 months — calendar reminder needed.
- **Private relay**: if the operator or any allowed user hides their email via Apple, add the
  relay address (`xxx@privaterelay.appleid.com`) to `ALLOWED_EMAILS`.
- **Session lifetime**: the 30-day JWT default covers normal Apple usage. If this app's session
  maxAge changes, re-evaluate whether Apple-only users can re-authenticate after expiry.
- **GitHub verified-email extra call**: the `signIn` callback now makes a second call to
  `/user/emails` to verify the `verified` flag. If GitHub rate limits become a concern in a
  multi-user deployment, consider caching the verification result or moving to a DB adapter
  that stores verified state after first sign-in.

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1253/1253 passed
npm run build      # clean, /login still ƒ (Dynamic)
```
