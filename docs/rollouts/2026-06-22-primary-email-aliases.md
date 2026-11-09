# 2026-06-22 - primary email aliases (one operator, many addresses)

## Summary

Added a `PRIMARY_USER_EMAIL_ALIASES` env so several email addresses all resolve to
the single primary `"local"` account. The owner can now sign in via Cloudflare
Access with any of their addresses (e.g. a Gmail and a custom-domain email) and
land on the same identity and dataset — and all of them count as allowed + admin,
exactly like the primary.

## Why

Owner wanted to log in with three of their emails and have them be the *same*
account (not three isolated tenants). Previously only `PRIMARY_USER_EMAIL` mapped
to `"local"`; every other verified email hashed to a distinct `u_<hash>` tenant
with empty data. This adds first-class aliasing.

## Design

- `src/lib/auth/identity.ts`: new internal `primaryEmails()` returns
  `{ PRIMARY_USER_EMAIL } ∪ PRIMARY_USER_EMAIL_ALIASES` (comma-separated), read at
  **call time** so deployment config / `vi.stubEnv` take effect without reload.
  `isPrimaryEmail`, `userIdForEmail` (→ `"local"`), and `isEmailAllowed` all honor
  the alias set. `ALLOWED_EMAILS` semantics unchanged for non-primary addresses.
- `middleware.ts` (edge, crypto-free): mirrors the alias set in `PRIMARY_SET` and
  allows primary + aliases through the edge gate. It still forwards the *actual*
  verified email; the Node runtime (`identity.ts`) maps it to `"local"`.
- `src/lib/auth/admin.ts`: `isAdminEmail` now delegates the primary check to
  `isPrimaryEmail`, so aliases are admins too (not just `PRIMARY_USER_EMAIL`).
- `.env.example`: documents `PRIMARY_USER_EMAIL_ALIASES`.

No data migration: the dataset is keyed by userId `"local"`, and primary + all
aliases map to `"local"` regardless of which one is configured as `PRIMARY_USER_EMAIL`.

## Files

- `src/lib/auth/identity.ts`
- `middleware.ts`
- `src/lib/auth/admin.ts`
- `test/auth-identity.test.ts` (+2 alias cases; placeholder emails only — no real
  addresses committed, per the repo email-privacy rule)
- `.env.example`
- `STATUS.md`, this rollout note

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/auth-identity.test.ts test/admin-gate.test.ts test/request-user.test.ts` — 14/14.
- `npm test` — 805 pass, 1 fail = pre-existing unrelated `cache-provenance.test.ts`
  (date-sensitive; fails locally because today is 2026-06-22, green in CI).
- `npm run build` — succeeds.

## Owner action to finish (prod box `~/apps/trading-live/.env.local`)

Set the owner's Gmail as primary with the other two as aliases, then restart:

```bash
CF_ACCESS_TRUST_EMAIL_HEADER=1
PRIMARY_USER_EMAIL=jaywedgeworth22@gmail.com
PRIMARY_USER_EMAIL_ALIASES=mail@jaywedgeworth.com,mail@jays.services
# then: pm2 restart trading --update-env
```

Also ensure all three addresses are permitted in the Cloudflare Access policy
(the outer gate). With aliases set, `ALLOWED_EMAILS` is not needed for these three.

## Follow-ups

- Switching `PRIMARY_USER_EMAIL` from `mail@jays.services` to the Gmail is a
  config change only (both map to `"local"`), so the existing portfolio/history
  carries over to whichever address the owner signs in with.
