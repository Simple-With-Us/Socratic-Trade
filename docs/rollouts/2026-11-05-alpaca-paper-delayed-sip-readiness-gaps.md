# Alpaca PAPER `delayed_sip` — PR #5005 readiness gaps

## 1. Context & Objective

PR #5005 (`gb-trader/alpaca-paper-delayed-quotes`) landed the account-scoped Alpaca PAPER `delayed_sip` tape on 2026-11-05.  The pre-merge review surfaced three readiness gaps the branch had to close: a shared-path bypass that left the full-universe market-scan enrichment unbound from the operating account's tape, future provider timestamps that were clamped to "age 0" instead of failing closed, and a missing regression matrix around the expected 900s ± 120s window.  This note records that work.  No deploy, no orders, no account/DB/credential changes.

## 2. Changes Made

**Shared-path bypass closed — the scan now binds to the operating account's tape.**

- `src/lib/market-scan-freshness.ts` — `refreshUserMarketScanIfDue` now passes `connectedAccountId: policy.connectedAccountId` into `scanMarket`'s options object.  The lane already persisted its audit under `policy.connectedAccountId`, but the scan itself ran unbound, so the full-universe enrichment could run on the wrong feed (and the wrong account-scoped cache identity).
- `app/api/scan/route.ts` — same one-line forwarding on the interactive scan, including the `enrichmentMode: "skip"` path, for consistency with `src/lib/strategy-gather.ts` (which was already correct).

**Future timestamps now fail closed.**

- `src/lib/alpaca-paper-quotes.ts` — new `ALPACA_PAPER_CLOCK_SKEW_SLACK_SEC` (2s) and `isFutureProviderStamp()`.  In `delayedTapeStatus`, an `asOf` ahead of the wall clock (beyond the skew slack) now leaves `asOfAgeSec` undefined → `excessDelaySec` undefined → `usable: false`; a `fetchedAt` ahead of the wall clock leaves `fetchAgeSec` undefined → `retrievalFresh: false` → `usable: false`.  Previously both were clamped with `Math.max(0, …)`, so a future stamp read as age 0 and the tape looked healthy.
- `src/lib/quotes-cascade.ts` — `quoteAgeSecForStalenessGate` returns `missing: true` for a future `asOf` or a future fetch stamp instead of handing the gate a negative `ageSec` (a negative age sails through every `age <= max` comparison).  This is fail-closed only; no path was loosened.

**Regression coverage.**

- `test/alpaca-paper-delayed-sip.test.ts` — added the expected-900 ± 120s edge matrix: missing `fetchedAt`, future `asOf`, future `fetchedAt`, and a market-closed / post-session print (`asOf` 4h old, `fetchedAt` fresh) that must NOT be accepted as a healthy delayed tape.  The same future-stamp cases were added to the `isQuoteFresh` and `quoteAgeSecForStalenessGate` blocks.
- `test/market-scan-freshness.test.ts` — new regression test proving the freshness lane forwards `policy.connectedAccountId` into `scanMarket` (spied via the existing `scanMarket` mock).

Files touched:

- `src/lib/alpaca-paper-quotes.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/market-scan-freshness.ts`
- `app/api/scan/route.ts`
- `test/alpaca-paper-delayed-sip.test.ts`
- `test/market-scan-freshness.test.ts`
- `docs/rollouts/2026-11-05-alpaca-paper-delayed-sip-readiness-gaps.md`
- `STATUS.md`, `PLAN.md`

## 3. Decisions & Trade-offs

- **2s clock-skew slack.**  A provider stamp up to 2s ahead of the wall clock is treated as ordinary jitter (age 0); anything further ahead is bad data and fails closed.  Chosen so a slightly-drifted provider clock does not trip the gate on every quote, while a mis-stamped or replayed snapshot can never pass as fresh.
- **The staleness gate now fails closed for ANY future stamp, not only the delayed tape.**  The gate is shared with Tradier paper and real-time quotes, so a future provider stamp there now blocks an order opening (`quote_age_unknown`) instead of being treated as age 0.  This is the fail-closed direction the review asked for; the tape-selection paths (live Alpaca feed selection, Tradier paper/live routing) are untouched.
- **No carve-out for overnight / last-session prints.**  A market-closed print whose `asOf` age is far beyond `expected + tolerance` is reported as excess delay and is unusable.  There is no session-aware exemption — stale session data is never accepted as a healthy delayed tape.
- **No dependency added, no scope widened.**  Order placement, sizing formulas, risk gates, credentials, learning rows, the global `ALPACA_DATA_FEED` env behavior for non-paper accounts, and the live Alpaca / Tradier tape selection are all unchanged.
- **No `/api/scan` route-level test.**  The route is exercised only indirectly today; the required regression test covers the freshness lane, and the route fix is the same one-line forwarding.  Flagged below as a remaining gap.

## 4. Verification State

Commands run in `/workspace/trader/gb-trader-wt-alpaca-paper-delayed-quotes`:

```
npx vitest run test/alpaca-paper-delayed-sip.test.ts test/market-scan-freshness.test.ts test/staleness-gate.test.ts test/quotes-cascade.test.ts test/data-providers.test.ts
  → Test Files 5 passed (5), Tests 280 passed (280)

npx vitest run test/alpaca-paper-delayed-sip.test.ts test/staleness-gate.test.ts test/data-providers.test.ts test/quotes-cascade.test.ts
  → 242 passed (242)   (the four-file command from the readiness prompt)

npx tsc --noEmit
  → clean (no output)

npm run lint
  → 0 errors, 856 warnings (the grandfathered backlog; the gate fails on errors only)

npm run build
  → success (Next.js production build, exit 0)
```

A full local `npm test` run was started but did NOT finish inside this session's time box — it was canceled mid-run, so it proves nothing either way.  The full gate is the CI workflow on PR #5005 (`lint` → `tsc` → `vitest` → `next build`); treat CI, not this lane, as the authority for the whole suite.  The Swift/iOS compiler is irrelevant here (no `ios/**` change) — CI's hosted macOS job remains the authority for that.

## 5. Next Steps & Blockers

- **Linear issue not created from this session.**  No Linear connector is reachable from this lane, so the team-`ST` issue required by the repo pre-commit protocol still has to be created/moved by an operator with Linear access before merge.
- **Remaining coverage gap:** `/api/scan`'s `connectedAccountId` forwarding has no dedicated route-level test (the route has no existing unit harness).
- **Owner next step:** open the PR for `gb-trader/alpaca-paper-delayed-quotes` and let CI run the full gate (`lint` → `tsc` → `vitest` → `next build`).  Merging to `main` auto-deploys under the weekday RTH latch; nothing was deployed from this lane.

## 6. Zero-Code Findings

- `scanMarket` already accepted `connectedAccountId` and forwarded it into the enrichment provider (`src/lib/market.ts`), and `src/lib/strategy-gather.ts` already passed it.  The bypass was strictly the two callers that omitted it — the freshness lane and the interactive scan route — which is why the fix is two one-line option additions rather than a plumbing change.
- `isQuoteFresh` for REAL-TIME quotes still accepts a future stamp as clock skew (`src/lib/quotes-cascade.ts`).  That path is outside this branch's scope (it is not the delayed tape) and was deliberately left alone; only the delayed tape (via `delayedTapeStatus`) and the staleness gate now fail closed on future stamps.
