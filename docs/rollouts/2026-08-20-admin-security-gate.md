# 2026-08-20 — The operator page tree had no server-side gate

## Context & Objective
Security half of review cluster `admin-honesty` (`docs/reviews/2026-08-18-full-app-expert-review.md`).  Three defects, all confirmed against the code before fixing.

The other half of that cluster — the unqualified CPU percentage on the Overview card and the missing admin identity in the admin chrome — is **deliberately not in this change**: peer PR #2795 owns `app/admin/page.tsx` and `app/admin/server/server-metrics-client.tsx`, and #2793 owns `app/admin/layout.tsx`.

## Defect 1 — `app/admin/**` had ZERO executable auth checks.  Confirmed.
`grep -rn "requireAdmin\|isAdmin\|getSession\|redirect(" app/admin/` returned **only comments** across all 24 files, and `middleware.ts` authenticated and allowlisted but never checked admin role.  Any authenticated allowlisted user could load the entire operator tree.  The pages are client components whose data probes 403 individually, so a non-admin saw full admin chrome, nav and page structure with only the numbers withheld.

**Fix:** one gate in `middleware.ts` covering `/admin` and `/admin/**`.  This reaches `app/admin/page.tsx` without editing it, which is what keeps the change clear of the peer PRs.

To share the *exact* allowlist with `requireAdmin` rather than duplicating a security predicate, `isAdminEmail` / `isPrimaryEmail` moved into a new edge-safe `src/lib/auth/admin-emails.ts`; `admin.ts` and `identity.ts` import from it and re-export for back-compat.  The split was necessary, not stylistic: `identity.ts` pulls node `crypto` for `userIdForEmail`, so the edge runtime cannot import it, and without the split the edge would have needed its own copy of the predicate.  **A duplicated security predicate drifts; a shared one cannot.**

Scoped to pages only, so `/api/admin/securities/import` — which deliberately uses bearer-token auth — is not pre-empted.

**One deliberate divergence, documented in-line.**  `requireAdmin` rejects the `local-fallback` identity source; this page gate accepts the identity middleware just resolved.  That is not a weaker production perimeter: `assertAuthSecretConfiguredInLiveBootstrap` refuses to boot without a real identity source, and the fallback branch is additionally guarded by `!isLiveBootstrap()`.  It only preserves local development, where auth is unconfigured by design.

## Defect 2 — chose to fix the BEHAVIOR, not the label
The review frames `/api/chat-history` as an admin endpoint missing its gate.  That framing is incomplete in a way that matters: it is the **shared per-caller Coach history**, read and DELETEd by `app/console/assistant/chat.tsx` and `ios/SocraticTrade/MobileAPIClient.swift`.  **Adding `requireAdmin` to it would have broken chat for every non-admin user on web and iOS.**

Fixing the label instead was unavailable — it lives in `app/admin/layout.tsx:101`, which peer #2793 owns.

So: a new `requireAdmin`-gated `app/api/admin/transcript/route.ts` that is genuinely cross-user (`listAllChatTurns`), and the page reads that.  "Every chat turn" becomes **true** rather than needing rewording — label and behavior agree, `layout.tsx` untouched, Coach unaffected.  Each turn shows its `userId`, and the user-side label changed `"You"` → `"User"` since the view now spans accounts.  A regression test asserts `/api/chat-history` stays caller-scoped and un-gated.

## Defect 3 — knob writes are attributed to a person
`app/api/admin/server-knobs/route.ts` audited every write as user `"local"` regardless of which admin flipped it.  Now `userIdForEmail(actor.email)` via `checkAdmin`, plus `actor: { email, via }` in the payload.  The legacy `x-admin-token` path has no email by design, so it is recorded as the token principal rather than silently attributed to a person.

## Decisions & Trade-offs
No confirmation ceremony, no scolding, no new "are you sure" anywhere.  Per the repo's product philosophy this is a **correctness** fix — an unauthenticated user should not reach the operator tree — not an obedience mechanism aimed at the owner.

`/access-denied` already exists as a page and is already in `PUBLIC_PREFIXES`, and the same redirect target is already used elsewhere in `middleware.ts`, so there is no redirect loop.

## Conflict resolved by hand
Peer PR #2957 landed `isPeerMarketReadPath` in `middleware.ts` between this work starting and landing, in the same position (immediately after `isPublicPath`).  Both functions are wanted; the conflict was resolved by keeping both, in that order.

Placement was then re-verified rather than assumed: the admin gate sits **after** the fail-closed block and **before** identity forwarding.  A peer-market bearer request reaches the gate with an empty `trustedEmail`, but `isAdminPagePath("/api/market/quotes")` is false, so it passes through untouched.  An `x-admin-token` request aimed at an `/admin` **page** is redirected, which is correct — that token is for API routes.

## Verification State
Failing-first proven per defect, each reverted in place and restored:

| Fix | Result with the fix reverted |
|---|---|
| 1 | 6 failures — `expected 200 to be 307` on `/admin` plus 5 subpages (non-admin got in) |
| 2 | 2 failures — `expected 200 to be 403`; `expected false to be true` on cross-user turns |
| 3 | 1 failure — `expected 0 to be greater than 0` (row filed under `"local"`, not the acting admin) |

New `test/admin-honesty-security.test.ts` — 15 tests.  Identity-adjacent sweep of 25 files (`middleware-auth`, `admin-gate`, `auth-identity`, `request-user`, isolation tests) — 211 passing.

Full gate results recorded in the PR.

## Correction to the review
`admin-01`'s exploitability is narrower than the headline suggests, and the review's own verifier note says so: with Auth.js sessions and an empty `ALLOWED_EMAILS`, only the primary operator can authenticate, and primary is always admin.  The gate matters once `ALLOWED_EMAILS` or `ADMIN_USER_EMAILS` gains a second entry.  Real, worth fixing, **not currently live-exploitable** — recorded here so nobody reads this as a live breach.

The review's `admin-01` "Where" anchor also points at the client fetch, whereas the actual defect is the endpoint being shared with Coach.

## Next Steps & Blockers
The presentation half of `admin-honesty` remains open and belongs to whoever holds #2795 / #2793: the bare CPU percentage on the Overview card (the detail page already carries the caveat, and `server-metrics/route.ts:604-613` documents the scaling as unverified and potentially an 8× under-report), the `0.0%` / `0 Running` substitution when a probe fails, and showing the signed-in admin identity in the admin chrome.
