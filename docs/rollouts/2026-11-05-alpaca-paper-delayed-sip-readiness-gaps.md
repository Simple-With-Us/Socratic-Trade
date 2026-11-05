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
- **No `/api/scan` route-level test.**  (Resolved in the continue pass — see §7.)  The route is exercised only indirectly today; the required regression test covers the freshness lane, and the route fix is the same one-line forwarding.  Flagged below as a remaining gap.
- **No secret handling in this change.**  The redacted `PA…` value shown in the sibling note (`2026-11-05-alpaca-paper-delayed-sip.md`) is an Alpaca PAPER ACCOUNT IDENTIFIER, not an API key (`PK…`/`AK…`) or secret key: account identifier redacted for privacy; not an API secret; no rotation required.  It is not echoed anywhere in this repo, and no credential/secret was created, rotated, or inspected by this work.

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

## 7. Continue pass — alerts scope, dashboard paper, lag honesty, API scan test

A second review thread raised five more findings on the same branch.  All five are closed here.

### A. Alerts — account-scoped quote path

`src/lib/alerts.ts` `checkPriceAlerts` called `fetchFreshQuotesCascade(symbols, userId)` — the
process-global path, NOT the operating account's tape.  It now calls
`fetchFreshQuotesCascade(symbols, userId, policy.accountNumber, policy.connectedAccountId)`, so a
price alert on the Alpaca PAPER account evaluates against that account's `delayed_sip` tape.
`test/price-alerts-evaluation.test.ts` asserts both the no-account case and a case where
`accountNumber` + `connectedAccountId` are set on the policy and must reach the cascade.

### B. Dashboard — the silent paper price fill

`src/lib/dashboard.ts` filled every missing symbol from `position.marketValue / position.quantity`.
On a VENUE-DELAYED tape that number is a derived COST BASIS, not a quote: when the paper broker
did not price a symbol, the console was showing a cost basis as if it were the venue's live price.
The fill now lives in `src/lib/dashboard-price-fallback.ts` (`applyPositionPriceFallback`) and is
SKIPPED for `venue_delayed`; realtime and venue-locked keep the historical behaviour.  Covered by
`test/dashboard-price-fallback.test.ts`.

### C. Lag honesty — illiquid last print vs lagging tape, and the closed session

Two distinct things were being reported as one:

- **"The feed is broken."**  The policy reason `quote_feed_excess_delay` claimed the tape was
  definitively broken.  A print beyond `expected + tolerance` during RTH can equally be an ILLIQUID
  LAST PRINT (a quiet name simply has not traded) — the number cannot tell them apart.  The reason
  is now `quote_last_print_beyond_delayed_sla` with honest wording ("illiquid last print or excess
  tape lag").  The opening is still blocked either way; only the claim changed.
- **Closed session.**  With the market shut there are no prints at all, so an old `asOf` is
  EXPECTED, not excess delay.  `delayedTapeStatus` now takes a `marketOpen` argument and reports
  `marketSessionOpen`; when the session is closed it reports NO excess (`excessDelaySec: undefined`)
  and stays unusable (fail closed).  `quoteAgeSecForStalenessGate` passes `isMarketOpen(now)` and
  surfaces `marketSessionOpen`, and the policy blocks a closed-session tape with its own reason,
  `quote_delayed_tape_session_closed` — never the excess reason.  A price alert on a closed-session
  tape stays unfired, as before.

### D. Cascade — `pendingSymbols` vs `skipActiveBroker`

`if (venueMode !== "realtime") pendingSymbols = [];` also ran when the caller had passed
`skipActiveBroker: true` — but then L1a never ran, so clearing the pending list dropped EVERY
fallback and left the caller with an empty result (the Sentry `pendingSymbols` thread).  The guard
is now `if (venueMode !== "realtime" && !options?.skipActiveBroker) pendingSymbols = [];`: the
execution path (L1a attempted) keeps its intentional fail-closed overlay protection, and the
`skipActiveBroker` path keeps its fallbacks.

### E. API scan account-scope test

`test/scan-route-account-scope.test.ts` (new) drives `GET /api/scan` with a connected account and
asserts `scanMarket` receives `options.connectedAccountId === policy.connectedAccountId`.

### F. Docs honesty on the redacted identifier

The redacted `PA…` value in `2026-11-05-alpaca-paper-delayed-sip.md` is an Alpaca PAPER ACCOUNT
IDENTIFIER, not an API key (`PK…`/`AK…`) or secret key: account identifier redacted for privacy;
not an API secret; no rotation required.  The note no longer calls it a credential, and the value
is still not echoed anywhere.

Files touched in this pass:

- `src/lib/alerts.ts`
- `src/lib/dashboard.ts`
- `src/lib/dashboard-price-fallback.ts` (new)
- `src/lib/alpaca-paper-quotes.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/policy.ts`
- `test/price-alerts-evaluation.test.ts`
- `test/dashboard-price-fallback.test.ts` (new)
- `test/scan-route-account-scope.test.ts` (new)
- `test/alpaca-paper-delayed-sip.test.ts`
- `test/staleness-gate.test.ts`
- `test/quotes-cascade.test.ts`
- `docs/rollouts/2026-11-05-alpaca-paper-delayed-sip.md`
- `docs/rollouts/2026-11-05-alpaca-paper-delayed-sip-readiness-gaps.md`
- `STATUS.md`, `PLAN.md`

### Verification (continue pass)

```
npx vitest run test/scan-route-account-scope.test.ts test/alpaca-paper-delayed-sip.test.ts \
  test/staleness-gate.test.ts test/quotes-cascade.test.ts test/price-alerts-evaluation.test.ts \
  test/dashboard-price-fallback.test.ts test/market-scan-freshness.test.ts \
  test/alpaca-paper-gateway-feed.test.ts test/data-providers.test.ts test/scan-empty-screener.test.ts
  → Test Files 10 passed (10), Tests 322 passed (322)

npx vitest run test/washsale-modes.test.ts test/strategy-hardening.test.ts \
  test/run-state-override.test.ts test/quote-delayed-fallback.test.ts test/policy.test.ts \
  test/p0-safety-fixes.test.ts test/pdt.test.ts test/persistence-hardening.test.ts \
  test/hard-gate-classification.test.ts test/broker-minimum-bump-execute.test.ts \
  + the four files above
  → Test Files 16 passed (16), Tests 455 passed (455)   (every suite that touches
    evaluateTradeProposal / quoteAgeSecForStalenessGate / checkPriceAlerts)

npx tsc --noEmit
  → clean (no output)

npx eslint <the twelve touched source/test files>
  → 0 errors, 13 warnings (pre-existing patterns in the touched files)

npm run build
  → success (Next.js production build, exit 0)
```

The FULL local `npm test` suite was not completed inside this session's time box; the
authoritative full gate is the CI workflow on PR #5005.

### Next steps (continue pass)

- The Linear team-`ST` issue still has to be created/moved by an operator with Linear
  access (no Linear connector is reachable from this lane).
- Sentry/Kody thread replies and resolves happen outside this lane — the commit body is
  the evidence trail for all five findings.
