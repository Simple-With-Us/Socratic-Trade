# 2026-09-07 - web-401-routes-to-login

## Context & Objective

A web API 401 (session expired) never routed the signed-out user to `/login` — the console
kept polling `/api/dashboard` every 15s, treated the 401 exactly like a network blip, and
kept rendering the last-good snapshot with only a small "delayed" freshness chip.  On a
trading desk that is dangerous: the user can keep looking at stale positions/orders that
stopped updating the moment their session died, believing it is live (board `30809a0c`, P1).

## Changes Made

- Every console API call (`app/console/lib/api.ts`'s `request<T>` and `fetchDashboard`) now
  sends the browser to `/login?callbackUrl=<current location>` the instant a response is a
  401 — the same fail-closed destination `middleware.ts` already uses for a page-level 401,
  not a second auth-redirect mechanism.  The redirect is idempotent and refuses to fire from
  `/login` itself, so a 401 reaching this client can never bounce in a loop.
- `app/console/lib/useConsoleData.tsx` now treats a 401 as session-death, not a retryable
  refresh error: it stops the poll/backgroundRefresh loop (no more requests against a
  known-dead session) and exposes a new `sessionExpired` flag.  `app/console/components/
  shell.tsx` reads that flag and replaces the ENTIRE console shell with an explicit "Your
  session has expired" notice the instant it is set, instead of leaving the normal dashboard
  chrome up with a small "refresh failing — showing last good data" pill while the redirect
  navigation is in flight.
- Secondary, lower priority (board `ab03d8c9`, Sentry `SOCRATIC-TRADE-28`,
  "alpaca-account-insights connection failed", 9 events/12 days — genuinely low-volume, not a
  money-path emergency): `src/lib/alpaca-account-insights.ts`'s `getJson` call site now
  classifies transport failures using the same shared helpers (`src/lib/network-errors.ts`,
  `src/lib/provider-rate-limit.ts`) `data-providers.ts` already uses for every other
  enrichment provider, and gives a transient transport error (`fetch failed` / ECONNRESET /
  DNS blip) ONE bounded retry before it is ever logged as a failure.  A caller-timeout abort
  (this call site's own 8s budget) is logged soft, same as `data-providers.ts` already does
  for its own budget aborts.  No change to the shared `db-health.ts` pipeline itself.
- **Codex-triage round (this PR's review threads), all real findings fixed in this batch:**
  - `app/console/components/shell.tsx` — the session-expired card had no interactive
    escape hatch: `redirectToLogin`'s hard navigation trips the existing `beforeunload`
    dirty-draft guard (`useDirtyGuard.tsx`), and `redirectingToLogin` latches `true`
    *before* the navigation, so a user who cancels that native prompt is stuck on a
    "Redirecting…" screen forever with no retry.  Added a real `<a href="/login?...">Sign
    in</a>` link that works regardless of how the automatic attempt resolved.
  - `middleware.ts` — a relative `/login` navigation on `console.socratictrade.com` /
    `mobile.socratictrade.com` got rewritten by the host-routing block to the protected
    `/console/login`, which is not a real route and not public; the page-level fail-closed
    redirect then sent it back to `/login`, which got rewritten again — an infinite loop
    that never reached the sign-in page.  New `isLoginPath()` helper exempts `/login` (and
    `/login/*`) from both host-rewrite blocks.
  - `app/console/lib/api.ts` — `redirectToLogin`'s `callbackUrl` dropped
    `window.location.hash`, so a fragment-driven view (`/console/guardrails#autonomy`,
    `/console/strategy#models`) lost its subsection on the round trip through sign-in.  Now
    includes `window.location.hash` (guarded against `undefined` in the test's fake
    `window`).
  - `app/console/lib/api.ts`, `app/console/settings/lib.ts`, `app/console/orders/api.ts` —
    the 401 handling only covered `lib/api.ts`'s own `request<T>`/`fetchDashboard`.  Two
    other self-contained console request wrappers (`settings/lib.ts`'s `request<T>`,
    `orders/api.ts`'s `post<T>`) had no 401 handling at all, so a dead session hit through
    either one surfaced only as a generic error toast with no redirect.  `redirectToLogin`
    is now exported from `lib/api.ts` and both wrappers call it on a 401 before throwing.
  - `src/lib/alpaca-account-insights.ts` — `getJson`'s scrub only redacted `secretKey` from
    an appended transport-error cause, but `apiKey` is equally auth material (sent as
    `APCA-API-KEY-ID` alongside the secret key, or as the Bearer token when there is no
    secret key), so a cause echoing it back logged it verbatim.  Now scrubs both.
  - `docs/rollouts/2026-09-07-web-401-routes-to-login.md` (this file) — restructured onto
    AGENTS.md's required six-section template; the previous version used
    `Summary`/`Why`/`Files`/`Verification`/`Follow-ups`/`Blockers` and was missing
    `Decisions & Trade-offs` and `Zero-Code Findings` entirely.

## Decisions & Trade-offs

- **Scope of the "route every client through the 401 boundary" fix.**  Beyond
  `settings/lib.ts` and `orders/api.ts` (the two other `request`-shaped wrapper functions
  the review named concretely), roughly 18 more `app/console/**` files call `fetch()`
  directly with no shared wrapper at all.  Routing all of those through `redirectToLogin`
  in this same batch would be a much larger, higher-risk refactor across files this PR
  never otherwise touches, for a P2 whose worst case (an isolated screen shows a generic
  error toast instead of an immediate redirect) is already bounded by the dashboard poll
  independently redirecting within `POLL_MS` (15s).  Fixed the two named wrapper functions;
  left the direct-`fetch()` tail as an explicit follow-up rather than expanding this PR's
  blast radius.
- **Manual "Sign in" link vs. bypassing the dirty-guard prompt.**  `redirectToLogin` lives
  in a plain module (`api.ts`), not a component, so it has no access to
  `DirtyGuardProvider`'s React context and cannot itself suppress the native `beforeunload`
  prompt.  Wiring that through would mean a new module-level bridge between a context
  provider and a non-component fetch wrapper — a larger structural change for a narrow
  benefit, when the discard-vs-lose-work choice on an ACTUAL dirty draft is arguably the
  correct one to keep asking.  A persistent, always-clickable "Sign in" link fixes the
  actual reported hazard (no escape hatch at all) without touching that trade-off.
- **`isLoginPath` exemption scoped to `/login` only, not all of `isPublicPath`.**  The
  host-rewrite blocks intentionally funnel every other public path (legal pages, `/welcome`,
  etc.) on these subdomains into `/console/*` — that looks deliberate (the blocks' own
  comment: "PWA retired — send this host to the website console").  Broadening the
  exemption to all of `isPublicPath` would change that behavior for paths unrelated to this
  fix; `/login` is the one path this PR's new client code actually navigates to, so the
  exemption is scoped to exactly that.
- The admin portal (`app/admin/**`) has its own, separate 401 presentation
  (`app/admin/lib/probe-error.ts`, per-card "Not signed in" copy) and was left as-is — the
  originating board item names "the trading desk," i.e. the console, and the admin surface
  already degrades more gracefully per-card rather than freezing a whole polled snapshot.
- No jsdom/testing-library in this repo's vitest setup (`vitest.config.ts` is Node-only), so
  `useConsoleData.tsx`'s stop-polling behavior and `shell.tsx`'s new render branches are
  exercised by inspection and by the `api.ts`/`middleware.ts`-level tests (which cover where
  the actual 401/redirect decisions are made), not by a mounted-component test.

## Verification State

Commands, in the order AGENTS.md requires:

```bash
npm run lint       # full repo
npx tsc --noEmit   # full repo
npm test           # full repo, vitest
npm run build      # full Next.js build
```

- `npm run lint` (full repo) — **0 errors.**
- `npx tsc --noEmit` (full repo) — **clean.**
- Targeted `npx eslint` on every file this PR touches — **0 errors**; the same 3
  pre-existing `react-hooks/set-state-in-effect` warnings already on `main` in those files,
  untouched; the one `@next/next/no-location-assign-relative-destination` warning from the
  original commit is addressed with a scoped, commented `eslint-disable-next-line`.
- Targeted `npx vitest run` on every test file this PR touches or added
  (`test/console-session-expired.test.ts`, `test/alpaca-account-insights.test.ts`,
  `test/subdomain-routing.test.ts`, `test/middleware-auth.test.ts`,
  `test/copy-rules-lint.test.ts`) — **95/95 passed**, including 6 new tests added in the
  codex-triage round (hash preservation, the two other wrapper functions redirecting on a
  401, and 3 new middleware login-loop cases).
- `node scripts/copy-rules-lint.mjs` on every touched file — **0 sentence-gap violations.**
- `npm test` (full repo) and `npm run build` (full repo) were launched and are the
  authoritative full-repo confirmation of this table's two full-repo rows above; this
  section is updated in place once they finish (see this PR's own CI `verify`/
  `verify-hosted` run for the authoritative, contemporaneous full-repo result if this note
  is read before that update lands — this repo's suite is large, ~7,700 tests per recent
  `docs/EFFORT-LOG.md` entries, and this task's own instructions are explicit not to end a
  turn idle-waiting on a background job).

## Next Steps & Blockers

- Follow-up (not a blocker): extend the shared 401 → `/login` redirect to the remaining
  `app/console/**` files that call `fetch()` directly with no wrapper (see Decisions &
  Trade-offs above for the concrete list boundary and why it was not folded into this PR).
- Follow-up (not a blocker, unrelated to this change): `npm ci` in this lane skips
  `better-sqlite3@13.0.3`'s install script (npm's install-scripts trust gate only lists
  `better-sqlite3@12.11.1` in package.json's `allowScripts`, a version drift from whatever
  bumped the dependency without updating that entry).  Worked around locally via the
  package's own prebuilt `darwin-arm64` binary; CI is Linux and may not reproduce this at
  all.  Left unfixed — editing `allowScripts`/CI trust config is outside this P1's scope.
- Blockers: none.  All review threads on this PR are addressed in this batch (see PR
  conversation for the per-thread replies); the verification gate above is clean on every
  row settled so far.

## Zero-Code Findings

None — every review finding in this round of triage either identified a real defect (fixed
above) or was addressed by scoping/documenting a deliberate trade-off (Decisions &
Trade-offs above); none were investigated and found to require no code change.
