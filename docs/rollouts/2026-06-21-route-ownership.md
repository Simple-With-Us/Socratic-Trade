# Route Ownership 404 Hardening

## Summary

Response-semantics hardening for four API routes that previously returned 400
or 200 when a request targeted a resource that did not belong to the requesting
user. The DB-level `WHERE user_id = ?` tenant isolation was already correct; this
change adds proper HTTP 404 responses (instead of 400 or silent success) and
regression test coverage.

## Why

Routes silently conflated "resource missing" with "bad request" (both 400) or
returned 200 success even when no row was affected. Callers need reliable 404
semantics to distinguish "this proposal/profile/account does not exist for you"
from "your request was malformed", and to make cross-tenant isolation explicit
in the test suite.

## Changes

### Status code fixes (Part 1)

- `app/api/proposals/[id]/approve/route.ts` — catches `"Proposal not found."` from
  `executeProposal` and maps it to 404; all other errors remain 400.
- `app/api/proposals/[id]/reject/route.ts` — adds a `getProposal` pre-check
  before calling `rejectProposal`; returns 404 when the proposal is not found
  for the requesting user.
- `app/api/connected-accounts/[id]/route.ts` — uses the boolean return value
  of `deleteConnectedAccount` to return 404 when nothing was deleted.
- `app/api/profiles/[id]/route.ts` (PUT) — catches `"Strategy profile not found."`
  from `updateStrategyProfile` and maps it to 404; validation failures remain 400.
  The GET handler already returned 404 correctly.

### DB function change

- `src/lib/db.ts` — `deleteConnectedAccount` changed from `void` to `boolean`
  (returns `result.changes > 0`). Callers that ignored the return value are
  unaffected; the route now checks it.

### Tests (Part 2)

- `test/route-ownership.test.ts` (new, 6 tests) — cross-tenant negative matrix:
  - Proposal approve: `getProposal` returns `undefined` for a foreign `userId`.
  - Proposal reject (x2): `getProposal` returns `undefined`; `rejectProposal`
    does not mutate a foreign proposal's status.
  - Connected-account delete: `deleteConnectedAccount` returns `false` for a
    foreign `userId`.
  - Profile GET: `getStrategyProfile` returns `undefined` for a foreign `userId`.
  - Profile PUT: `updateStrategyProfile` throws `"Strategy profile not found."`
    for a foreign `userId`.

## Files

- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/[id]/reject/route.ts`
- `app/api/connected-accounts/[id]/route.ts`
- `app/api/profiles/[id]/route.ts`
- `src/lib/db.ts` (deleteConnectedAccount return type)
- `test/route-ownership.test.ts` (new)
- `docs/rollouts/2026-06-21-route-ownership.md` (this file)

## Verification

```
npx tsc --noEmit    # clean, no errors
npm test            # 470 passed (61 files), up from 464 (6 new tests)
```

## Follow-ups

- No remaining cross-tenant gaps identified in these routes. DB WHERE clauses
  already enforce isolation; this change makes the HTTP surface match.
- The `rejectProposal` function in `strategy.ts` does not throw on a missing
  proposal (by design, for idempotency); the route now pre-checks explicitly.
