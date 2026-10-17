# 2026-10-15 — Quote observation and unknown-age gate (ST-2584)

## Context & Objective

Quote paths were stamping the fetch clock as `asOf` and sometimes treating a size, a one-sided book, or a prior close as the price.  An opening on a quote of unknown age was converted to a limit and left approved.  Tradier live could still be overlaid by Alpaca or Yahoo.  This keeps each provider's real observation time, picks last then mid, and blocks openings whose age cannot be read.  Price data stays on Socratic Trade's existing pipeline.  No new vendor was added.

## Changes Made

- Price selection lives in `src/lib/quote-observation.ts` (`selectObservedQuotePrice`, `providerObservationIso`).  Last print wins.  Otherwise the mid of a two-sided book.  Missing or unparseable times stay undefined.
- Alpaca equity quotes read last trades from the existing Alpaca market-data client (`stockLatestTrades`), then the two-sided quote mid.  Trade size is not the price.  Alpaca and Tradier no longer call `fillMissingQuotesWithClose`.
- Tradier quotes use last, then mid, with `trade_date` or the bid/ask time.  Close, previous close, and a one-sided book are not the price.
- The cascade treats a missing `asOf` as not fresh, including a venue-authoritative quote.  `quoteAgeSecForStalenessGate` returns `missing` before it will age `fetchedAt`.  Tradier live is `venue_locked`.  Tradier paper stays `venue_delayed`.  Both clear the rest of the cascade so Alpaca and Yahoo cannot overlay.
- The staleness gate blocks an opening with `quote_age_unknown` when the observation time is missing or unparseable.  A known-old time still converts to a limit and stays approved.  Exits stay ungated.  The reason does not contain "broker", so it stays a preference block.
- Chat draft preview still has no market scan.  `from-draft` treats `quote_age_unknown` the same way it treats `staleness_gate`: a draft blocked only by that preview miss still stages.  Approve-time `executeProposal` re-runs the gate on the fresh scan and blocks the order if that scan has no observation time.
- Robinhood, Public, eToro, Kalshi, Webull, Nasdaq, Tiingo, Finnhub, Twelve Data, ROIC, Yahoo quote rows, the approval scan, and the price/bid/ask field-store rows follow the same rule.  `stampFieldObservation` was left alone.

Files:

- `src/lib/quote-observation.ts`
- `src/lib/alpaca.ts`
- `src/lib/alpaca-sdk-legacy-client.ts`
- `src/lib/tradier.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/policy.ts`
- `app/api/proposals/from-draft/route.ts`
- `src/lib/dashboard.ts`
- `src/lib/approval-quote-scan.ts`
- `src/lib/robinhood.ts`
- `src/lib/public-broker.ts`
- `src/lib/etoro.ts`
- `src/lib/kalshi-broker.ts`
- `src/lib/market.ts`
- `src/lib/market-realtime.ts`
- `src/lib/data-providers.ts`
- `src/lib/keyless-options-enrichment.ts`
- `test/quote-observation.test.ts`
- `test/staleness-gate.test.ts`
- `test/quotes-cascade.test.ts`
- `test/alpaca-nbbo-mid.test.ts`
- `test/tradier.test.ts`
- `test/data-providers.test.ts`
- `test/keyless-options-enrichment.test.ts`
- `test/keyless-options-vendor-fetch.test.ts`
- `test/chat-draft-policy.test.ts`
- `test/placement-reconcile.test.ts`
- `test/order-confirmation-status.test.ts`
- `test/approval-limit-reprice.test.ts`
- `test/broker-minimum-bump-execute.test.ts`
- `test/account-mutation-pr2.test.ts`
- `test/retry-red-team.test.ts`
- `test/protective-exit-reprice.test.ts`
- `test/order-position-invariant-lanes.test.ts`
- `test/final-size-red-autonomous.test.ts`
- `test/approval-lock.test.ts`
- `test/account-questionnaire-run-loop.test.ts`
- `test/exit-stop-release-approval.test.ts`
- `docs/phase-4-market-data-scoring.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- Unknown age blocks.  Known-old quotes keep the 2026-08-04 limit conversion.  That is narrower than "never block on staleness" and matches the owner instruction for this issue.
- Tradier live is locked to Tradier quotes and is not stamped venue-authoritative, so a real `asOf` still hits `maxQuoteAgeSec`.  Paper still ages the fetch when `asOf` parses, because the sandbox OMS fills the delayed tape.
- Alpaca `stockLatestTrades` is the same provider's last print, not a new source.  Polygon, FMP, and other vendors were not added.
- One-sided books no longer become the price.  Quiet names with a real last print still price off that print.
- Webull unofficial `close` stays a current-print candidate after the explicit last fields.  `preClose` is still not the price.  Tradier `close` stays off the price.  A Tradier miss does not fall through to Alpaca or Yahoo.
- Test-broker quotes in `robinhood.ts` still stamp the current time so existing strategy tests stay inside the freshness window.  The real Yahoo path does not.
- `stampFieldObservation` still falls back to `fetchedAt` for non-quote evidence.  Quote price, bid, and ask rows are skipped when they have no provider observation.
- Approval-scan test fixtures that mean "this quote is fresh" now carry `asOf`.  The scan no longer copies `generatedAt` onto a quote that has no provider time.

## Verification State

```bash
npx tsc --noEmit
```

Exit 0.

```bash
npx eslint app/api/proposals/from-draft/route.ts src/lib/quote-observation.ts src/lib/policy.ts src/lib/quotes-cascade.ts src/lib/alpaca.ts src/lib/tradier.ts --quiet
```

Exit 0.  Touched files have no lint errors.  Grandfathered warnings remain.

```bash
npx vitest run test/placement-reconcile.test.ts test/order-confirmation-status.test.ts test/approval-limit-reprice.test.ts test/broker-minimum-bump-execute.test.ts test/account-mutation-pr2.test.ts test/chat-draft-policy.test.ts test/keyless-options-vendor-fetch.test.ts test/staleness-gate.test.ts test/quote-observation.test.ts test/quotes-cascade.test.ts test/tradier.test.ts test/alpaca-nbbo-mid.test.ts
```

11 files passed and `test/order-confirmation-status.test.ts` failed one bulk-approve case because the stub quoted AAPL only.  After MSFT got its own `asOf`, `test/order-confirmation-status.test.ts` and `test/chat-draft-policy.test.ts` passed 16/16.

An earlier full `npm test` was 73 failed, 9343 passed, 51 skipped.  The failures this change caused were `quote_age_unknown` on approval fixtures that omitted `asOf`, plus scan-less chat drafts.  Those files were re-run green.  The rest match the existing OpenRouter-key, notify, server-metrics, and cpuprofile failures.  Twelve Data passed when `test/data-providers.test.ts` was run alone.

```bash
npm run build
```

Exit 0.

## Merge with main (2026-10-15)

Merged `origin/main` at `3c74cd81` with a merge commit.  PLAN.md and STATUS.md auto-merged.  Both the quote-observation note and the ST primary-bridge removal note remain.

Follow-up on this merge:

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/alpaca-sdk-client-timeout.test.ts test/alpaca-nbbo-mid.test.ts test/chat-draft-policy.test.ts test/quote-observation.test.ts test/staleness-gate.test.ts test/quotes-cascade.test.ts test/tradier.test.ts
```

`npm run lint` exit 0.  `npx tsc --noEmit` exit 0.  Those seven files passed, 186 tests.

Alpaca latest trades are Zod-parsed, and a bad trade row is skipped.  The chat-draft assertion no longer casts `reasons`.  Webull `close` was already the current print.  Kalshi authority, Tradier fetch-age, and a missing-asOf live book still fail closed.

Merged `origin/main` again at `df7e6d10` (Congress.Trade push receipt).  `AlpacaLatestTradeSchema` and `AlpacaLatestTradesResponseSchema` are exported with inferred types.  The schema is not strict, because a real trade also carries size and a strict object would drop the print.

Merged `origin/main` again at `3f4ef5e5` (honest approve).  The placement-reconcile stub kept its provider `asOf`.  Auto-merge was disabled.  `do-not-automerge` stays.

Merged `origin/main` again at `2075c857` (ST-4531 Slack callers now post to Zulip).  STATUS.md auto-merged.  No quote-path conflict.  CI on `2a2ed285` was green (classify, verify-hosted, verify).  Webull `close` and the Alpaca schema export are resolved.

Merged `origin/main` again at `e3ba1507` (ASC env credentials for hosted TestFlight ship).  PLAN.md and STATUS.md auto-merged.  No quote-path conflict.  `npm run lint` exit 0.  `npx tsc --noEmit` exit 0.  `node --test scripts/ios-fleet/asc-api.credentials.test.mjs` 8/8.

The four remaining review threads are not code changes.  Each suggestion would put a non-venue price or the fetch clock on an opening.  The thread replies state the money path, the risk, and that no follow-up issue is opened to weaken the gate.  The threads are then resolved.

Merged `origin/main` again at `49a76da4` (Congress webhook receipt, ST-3846).  STATUS.md auto-merged.  No quote-path conflict.

Merged `origin/main` again at `d1053ad6`.  Three quote-path conflicts came from #4715 (bounded broker calls): `src/lib/etoro.ts`, `src/lib/kalshi-broker.ts`, and `src/lib/public-broker.ts`.  In each, `getEquityQuotes` keeps main's `chunkBrokerSymbols` loop, abort-signalled `fetch`, and Zod-parsed eToro body, and builds each row with this lane's `etoroQuoteFromRate`, `kalshiQuoteFromMarket`, and `publicQuoteFromRow`.  Main's inline `price: last ?? mid` and `asOf: typeof date === "string"` lines are dropped, because they would put a placeholder price or an unparsed time back on the quote.  Kalshi stays non-authoritative (no `venuePriceAuthoritative`, no `asOf`), so the gate still blocks a Kalshi opening whose age is unknown.  The `import` lines from both sides were kept.  PLAN.md and STATUS.md auto-merged.

Verification after the `d1053ad6` merge.  `npm run lint` exit 0 (0 errors, 871 grandfathered warnings).  `npx tsc --noEmit` printed no diagnostics.  `npx vitest run` over quote-observation, staleness-gate, quotes-cascade, tradier, alpaca-nbbo-mid, alpaca-sdk-client-timeout, chat-draft-policy, data-providers, keyless-options-enrichment, placement-reconcile, etoro-boundary-schema, inflight-deadline, the kalshi suites, and the two scheduler inflight-guard suites: 19 files, 434 passed, 9 skipped.  #4715's own tests (protective-lane-isolation, robinhood-orders-error-throws, synthetic-stops, etoro-boundary-schema): 4 files, 85 passed.  `src/lib/alpaca.ts`, `robinhood.ts`, and `tradier.ts` auto-merged with only deadline and page-cap changes, and a grep found no restored `fillMissingQuotesWithClose` on a quote read, no `?? 0.5` price, and no Tradier `venuePriceAuthoritative`.

Merged `origin/main` again at `1cbe9f06` (2026-10-17 sweep, PR #4718).  Clean merge: only `PLAN.md` and `STATUS.md` were touched on both sides and both auto-merged.  No quote-path file changed on main since the last merge.  `npx tsc --noEmit` printed no diagnostics.  `npm run lint` exit 0 (0 errors, 873 grandfathered warnings).  `npx vitest run` over quote-observation, staleness-gate, quotes-cascade, tradier, alpaca-nbbo-mid, alpaca-sdk-client-timeout, chat-draft-policy, data-providers, keyless-options-enrichment, keyless-options-vendor-fetch, placement-reconcile, order-confirmation-status, approval-limit-reprice, branch-protection-gate, proxy-use-log, and persistence-hardening: 16 files, 446 passed, 9 skipped.  Kalshi orders use `evaluateKalshiOrderPolicy`, not `evaluateTradeProposal`, so the unknown-age gate does not touch them.  Main then moved to `2a2fb150` (#4661 free-data gaps) and merged cleanly; `PLAN.md`, `STATUS.md`, and `docs/phase-4-market-data-scoring.md` auto-merged and `npx tsc --noEmit` printed no diagnostics.  Owner ruling 2026-10-17 is to merge unless the owner is needed.  `do-not-automerge` only stops auto-merge, so the sweep squash-merges directly after green CI.

## Next Steps & Blockers

Squash-merge PR #4718 once CI is green, then move ST-2584 to Completed with a one-line deploy note.

## Zero-Code Findings

None.  This note accompanies the code change.
