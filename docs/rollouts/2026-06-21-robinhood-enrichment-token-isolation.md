# 2026-06-21 - robinhood-enrichment-token-isolation

## Summary

Closed a tenant-isolation gap in the merged per-user Robinhood broker-token feature
(PR #42 / commit `0056f04`). The OAuth token is per-user (keyed by userId), but two
read-only enrichment paths called the `fetchRobinhood*` helpers with **no userId**, so
they fell through to `opts.userId ?? DEV_USER_ID` (`'local'`) and silently used the
operator's real broker credentials for every user:

1. `src/lib/history.ts` — the Robinhood tier of the OHLC cascade (`fetchDailyOHLC`),
   reached from the computed-technicals refresh (`web-sources/technical.ts`), which has
   **no per-user context** and writes a **global** dataset.
2. `src/lib/data-providers.ts` — `RobinhoodEnrichmentProvider.enrich` (the
   `robinhood-fundamentals` provider), gated behind `ROBINHOOD_ENRICHMENT_ENABLED`
   (default off).

Fix (threading + fail-closed):

- **`src/lib/robinhood.ts`** — `fetchRobinhoodHistoricals` and `fetchRobinhoodFundamentals`
  now take a **required** `userId` (removed the `DEV_USER_ID` default and the unused
  `DEV_USER_ID` import). The compiler now forces every caller to pass an explicit identity,
  so a silent `'local'` fallback can't be reintroduced.
- **`src/lib/history.ts`** — `fetchDailyOHLC` consults the private Robinhood tier **only
  when an explicit `userId` is in scope**, and forwards that `userId`. A shared/background
  pull (no userId — e.g. the computed-technicals refresh) omits the broker tier entirely and
  falls through to the public Yahoo/Stooq sources, so it never borrows `'local'`'s token.
- **`src/lib/data-providers.ts`** — `RobinhoodEnrichmentProvider` now takes the
  request-scoped `userId` in its constructor (wired from `getEnrichmentProvider(userId)`,
  matching every other provider), threads it into `fetchRobinhoodFundamentals`, and **fails
  closed** (returns empty enrichment, no broker call) when no user is in scope.

Folded-in lower-priority hardening (same feature):

- **`app/api/auth/robinhood/callback/route.ts` + `src/lib/mcp-oauth.ts`** —
  `completeMcpOAuthCallback` now accepts an `expectedUserId` and rejects the flow when it
  doesn't match the initiating session's `stateBlob.userId`. The callback route passes the
  session userId from `resolveRequestUserId(request)`. This prevents a freshly-minted broker
  token from being bound under a victim's userId via an attacker-initiated flow completed in
  the victim's session. The consumed state row is deleted before the check, so a mismatched
  attempt can't be replayed.

## Why

The leaked credential is a **real broker token**, not market data. Severity was sub-blocking
today because (a) both paths are read-only (no trade execution) and (b) the enrichment
provider is gated off by default — but it must be fixed before any multi-user deployment.
This complements the design doc's existing Risk #3 (the `ROBINHOOD_MCP_AUTH_TOKEN` global
override) by closing the *implicit* `DEV_USER_ID` fallback, which was the easier footgun to
trip accidentally.

Design choice: the computed-technicals refresh writes a **global** shared dataset and has no
per-user context, so threading a specific user into it would itself be a cross-tenant leak
(one user's broker-derived signals served to everyone). The correct semantics are to **omit
the private broker tier** when no user is in scope — public sources still populate the shared
dataset, so there is no functional regression.

## Files

- `src/lib/robinhood.ts` — required `userId` on both fetchers; removed unused `DEV_USER_ID` import + docstrings.
- `src/lib/history.ts` — private Robinhood OHLC tier gated on an explicit `userId` and forwards it.
- `src/lib/data-providers.ts` — `RobinhoodEnrichmentProvider(userId)` constructor + fail-closed + threaded fetch; wired in `getEnrichmentProvider`.
- `src/lib/mcp-oauth.ts` — `completeMcpOAuthCallback` accepts `expectedUserId` and asserts it matches `stateBlob.userId`.
- `app/api/auth/robinhood/callback/route.ts` — resolves the session userId once; passes it as `expectedUserId`.
- `test/robinhood-tenant-isolation.test.ts` — NEW. 7 regression tests (see below).
- `docs/design/per-user-broker-token.md` — added a "Post-merge hardening" section.
- `STATUS.md`, this rollout note.

## Verification

All run in the isolated worktree `~/apps/trading-fix-rh-token` (branch
`fix/per-user-robinhood-enrichment-token`, based on `origin/main`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` (vitest) — **674 passed** across 78 files (+7 new).
- `npm run build` — clean (exit 0).
- Focused: `npx vitest run test/robinhood-tenant-isolation.test.ts` — 7/7 pass.

New regression tests (`test/robinhood-tenant-isolation.test.ts`) assert, with a stubbed MCP
endpoint where user A's (`'local'`) token is the only credential that unlocks A's data:

1. `fetchRobinhoodHistoricals` — user B never transmits A's `Bearer` token; user A does (positive control).
2. `fetchRobinhoodFundamentals` — same isolation + positive control.
3. `RobinhoodEnrichmentProvider(userB)` — never resolves A's token; `(userA)` resolves A's fundamentals.
4. `RobinhoodEnrichmentProvider(undefined)` — fails closed: **no broker call at all**.
5. `fetchDailyOHLC` with no userId — omits the broker tier (broker never touched); with a real user, uses that user's own token.
6. `completeMcpOAuthCallback` — rejects a state belonging to a different session; binds nothing.
7. `completeMcpOAuthCallback` — allows the matching-session case (mismatch guard is a no-op there).

## Follow-ups

- `PLAN.md` needed no change — this is a follow-up hardening of an already-landed feature, no
  scope/timeline/approach change.
- Still open from the design doc (unchanged by this PR): the `ROBINHOOD_MCP_AUTH_TOKEN` env
  override remains a deliberate process-level global bypass — must NOT be set in a multi-user
  deployment (documented at `mcp-oauth.ts:getMcpAccessToken` and design-doc Risk #3).
- Orphaned PKCE state-blob TTL sweep is still unenforced (design-doc Risk #4) — out of scope here.

## Blockers

- None.
