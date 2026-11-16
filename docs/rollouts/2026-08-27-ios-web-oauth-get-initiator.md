# 2026-08-27 — iOS Google/GitHub sign-in: GET OAuth initiator + middleware translation

## Context & Objective

The iOS app's "Sign in with Google" and "Sign in with GitHub" buttons have never worked.
`beginWebAuth` (ios/SocraticTrade/LoginView.swift) opens an `ASWebAuthenticationSession` at
`GET /api/auth/signin/<provider>?callbackUrl=…`, but Auth.js v5 initiates OAuth **only on
POST with a CSRF token** — a GET with a provider segment unconditionally throws
`UnknownAction` (`@auth/core/lib/pages/index.js`), which the outer handler maps to the
generic `Configuration` error and 302s to `/access-denied?error=Configuration`.  The auth
sheet parks on that page, the `socratictrade://` callback never fires, and the app shows no
error.  Production container logs show the `UnknownAction` error firing continuously.  The
website is unaffected because `app/login/page.tsx` uses server actions (POST).  This
predates the next-auth beta.32 bump (#3086) — verified byte-identical GET dispatch in
@auth/core 0.41.2 vs 0.41.3 — and traces back to the flow's introduction (#1859/#1886).
Apple sign-in works because it is fully native (`/api/mobile/auth/apple`).

## Changes Made

- **`app/api/mobile/auth-start/route.ts` (new)** — public GET initiator: validates
  `provider` against the web-configured set (google/github/twitter), clamps `callbackUrl`
  to same-origin, then calls the server-side `signIn()` exported by
  `src/lib/auth/auth.ts`.  That sets the state/PKCE cookies and 307s to the provider's
  authorization URL.  Non-redirect failures fall back to `/login?callbackUrl=…` so the
  user can still sign in by hand inside the sheet.
- **`middleware.ts`** — translates `GET /api/auth/signin/<provider>` (the URL already-
  shipped iOS builds open) into `/api/mobile/auth-start?provider=…&callbackUrl=…`, so the
  fix works for installed TestFlight builds without an app update.  Added
  `/api/mobile/auth-start` to `PUBLIC_PREFIXES`.
- **`ios/SocraticTrade/LoginView.swift`** — `beginWebAuth` now opens
  `/api/mobile/auth-start?provider=…` directly (forward fix; older builds ride the
  middleware translation).
- **`app/api/mobile/auth-redirect/route.ts`** — comment updated to describe the new entry
  point (it previously documented the broken GET design as intended).
- **`test/mobile-auth-start.test.ts` (new)** — 7 tests: middleware translation (with and
  without callbackUrl, nested-segment ignore), NEXT_REDIRECT rethrow, cross-origin
  callback clamp, unknown-provider fallback, unconfigured-provider fallback.

## Decisions & Trade-offs

- Chose a query-param route (`?provider=`) over a dynamic segment for simplicity; the
  middleware translation covers shipped builds either way.
- `callbackUrl` is clamped to same-origin **path+search** before reaching `signIn`, so the
  route cannot be used as an open redirector.
- Apple deliberately not in the web set — native flow only on iOS.
- The intercept only matches `GET` with a single non-empty provider segment; Auth.js's own
  `GET /api/auth/signin` (no provider → /login redirect) is untouched, as is every POST.

## Verification State

- `npx vitest run test/mobile-auth-start.test.ts` — 7/7 pass.
- Live dev-server proof (next dev, dummy Google creds):
  `GET /api/auth/signin/google?callbackUrl=…` → 307 `/api/mobile/auth-start?…` → 307
  `https://accounts.google.com/o/oauth2/v2/auth?…code_challenge=…` with
  `authjs.pkce.code_verifier` + `authjs.callback-url` cookies set — exactly the initiation
  Auth.js refused on the old GET.
- Full gate (tsc → vitest → build) runs via `scripts/land.sh`; Swift change compiles on
  hosted `ios-build`.

## Next Steps & Blockers

- After deploy: `curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "https://socratictrade.com/api/mobile/auth-start?provider=google&callbackUrl=https%3A%2F%2Fsocratictrade.com%2Fapi%2Fmobile%2Fauth-redirect%3Fcode_challenge%3Dtest"` — expect 307 to accounts.google.com.
- Owner: retry Google/GitHub sign-in in the installed TestFlight build (no update needed).
- Separate lanes: workspace-load-after-Apple-sign-in investigation (in flight), and the
  Usage-Monitor Litestream/B2 retry-storm fix (separate repo/PR).
- Follow-up UX gap (small): `ASWebAuthenticationSession` cancel is silently swallowed in
  LoginView, so a stuck sheet gives zero in-app feedback — worth an error banner later.
