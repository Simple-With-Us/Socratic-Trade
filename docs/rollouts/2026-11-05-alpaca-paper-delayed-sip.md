# Alpaca PAPER — account-scoped `delayed_sip` quote tape (2026-11-05)

## 1. Context & Objective

Jay authorized **account-scoped delayed quote behavior for the connected Alpaca PAPER account only**
(`broker=alpaca`, `environment=paper`). The connected paper account's market data must come from
Alpaca's `delayed_sip` feed — a tape with an expected **~900s (15 minute)** publication delay — and
the app must treat that delay as the venue's behavior rather than as broken/live data.

Measured in prod on 2026-11-05 ~1:58pm CT with the connected paper account
(`(value redacted)` — account identifier redacted for privacy; not an API secret;
no rotation required):

| feed | asOf age | note |
| --- | --- | --- |
| `data.alpaca.markets` `feed=iex` | 0–10s | near-realtime |
| `data.alpaca.markets` `feed=delayed_sip` | 900–902s | exact ~15m; `extraLagVs900 ≈ 0` |

Before this change the app resolved `realtime` for Alpaca paper, the cascade's Level-2
`AlpacaSnapshotEnrichmentProvider` used the global `alpacaDataFeed()` allowlist (`iex|sip|otc` —
`delayed_sip` was silently rejected → `iex`), and the broker gateway's `getLatestQuotes` passed no
feed at all. The Tradier paper account already had the equivalent `venue_delayed` pattern; this
change mirrors those semantics for Alpaca paper and touches nothing else.

**Scope guardrails honored:** no production deploy, no Coolify, no order place/cancel, no strategy
change, no DB cleanup, no account-activation flip, no credential change, no learning pending-row
touch.

## 2. Changes Made

New account-scoped tape module + feed plumbing through the broker gateway, the quote cascade, the
market-scan enrichment, and the freshness/staleness gates.

- **New** `src/lib/alpaca-paper-quotes.ts` — the single owner of the decision:
  `isAlpacaPaperAccount`, `alpacaPaperFeedForAccount`, `alpacaSnapshotCacheIdentity`, and
  `delayedTapeStatus` (fresh-retrieval + excess-delay evaluation). Constants:
  `ALPACA_PAPER_DELAYED_FEED = "delayed_sip"`, `ALPACA_PAPER_EXPECTED_DELAY_SEC = 900`,
  `ALPACA_PAPER_DELAY_TOLERANCE_SEC = 120`.
- `src/lib/quotes-cascade.ts`
  - `resolveVenueQuoteMode` — the connected Alpaca **paper** account now resolves `venue_delayed`
    (same semantics as Tradier paper). Alpaca **live** stays `realtime`; Tradier and every other
    broker are unchanged.
  - `isQuoteFresh` — a quote carrying a documented `expectedDelaySec` is evaluated by the delayed
    rules (fresh retrieval AND no excess lag) instead of the 120s real-time bar.
  - `quoteAgeSecForStalenessGate` — still ages the venue-delayed snapshot by `fetchedAt` (expected
    ~900s is **not** stale), and now reports `excessDelaySec` / `expectedDelayedTape` independently.
  - Level 1a: the venue tape is kept and the cascade stops — no realtime overlay.
  - Level 1b: a **secondary** paper account (Tradier paper *or* Alpaca paper) is marked
    `venueDelayedTape` and stripped of venue-authoritative / expected-delay flags so it can never
    masquerade as the active execution venue.
  - Level 2: the Alpaca snapshot enrichment uses the operating account's feed + cache identity.
- `src/lib/alpaca.ts` — the broker gateway resolves its own connected account; for Alpaca paper it
  requests `feed=delayed_sip` on `getLatestQuotes` / `getLatestTrades` and stamps the result
  `venuePriceAuthoritative` + `expectedDelaySec: 900` + `delayToleranceSec: 120`.
- `src/lib/alpaca-sdk-legacy-client.ts` — `getLatestQuotes` / `getLatestTrades` accept an optional
  `{ feed }` and forward it to the v5 SDK (`stockLatestQuotes` / `stockLatestTrades`, whose
  `StockLatestFeed` type includes `delayed_sip`).
- `src/lib/data-providers.ts` — `alpacaDataFeed()` keeps its `iex|sip|otc` global allowlist
  (`delayed_sip` is deliberately NOT env-selectable); new
  `alpacaSnapshotFeedForAccount`; `AlpacaSnapshotEnrichmentProvider` takes an optional
  `{ feed, cacheIdentity }` and folds the identity into the cache prefix;
  `getEnrichmentProvider(userId, { connectedAccountId })` resolves the operating account.
- `src/lib/market.ts` / `src/lib/strategy-gather.ts` — `scanMarket` / the scan options carry
  `connectedAccountId`, so the market scan enriches on the operating account's tape.
- `src/lib/policy.ts` — the order-opening staleness gate **fails closed** on excess delay
  (reason `quote_last_print_beyond_delayed_sla` — renamed from `quote_feed_excess_delay` in the
  continue pass, see the readiness-gaps note §7) instead of converting to a limit; a CLOSED market
  session is blocked separately as `quote_delayed_tape_session_closed`.
- `src/lib/alerts.ts` — price alerts do not fire off an excessively delayed tape, and (continue
  pass) run against the operating account's tape rather than the process-global path.
- `src/lib/types.ts` — `BrokerQuote.expectedDelaySec` / `delayToleranceSec`; scan options gain
  `connectedAccountId`.

Exact touched files:

```
src/lib/alpaca-paper-quotes.ts        (new)
src/lib/alpaca-sdk-legacy-client.ts
src/lib/alpaca.ts
src/lib/alerts.ts
src/lib/data-providers.ts
src/lib/market.ts
src/lib/policy.ts
src/lib/quotes-cascade.ts
src/lib/strategy-gather.ts
src/lib/types.ts
src/lib/approval-quote-scan.ts
test/alpaca-paper-delayed-sip.test.ts  (new)
test/alpaca-paper-gateway-feed.test.ts  (new)
test/data-providers.test.ts
test/quotes-cascade.test.ts
docs/rollouts/2026-11-05-alpaca-paper-delayed-sip.md  (new)
STATUS.md
```

## 3. Decisions & Trade-offs

- **Account row, never the env var.** The switch is the connected account's `broker` +
  `environment`. `ALPACA_DATA_FEED` stays `iex|sip|otc` only — flipping it would repoint every
  account's tape process-wide, which the authorization explicitly rules out. A dedicated test pins
  that `delayed_sip` is still rejected by the global allowlist.
- **`alpaca-mcp` is excluded.** The MCP transport is a different data path and was not part of the
  authorization; `isAlpacaPaperAccount` matches `broker === "alpaca"` only.
- **Expected-900 tolerance = 120s.** Excess lag is flagged when `asOfAge > 900 + 120 = 1020s`.
  120s matches the app's default `maxQuoteAgeSec`, so a single stale-feed episode does not flip
  every symbol to "excess" at once. The tolerance is a named constant, not a magic number.
- **Two INDEPENDENT checks, never one.** A delayed quote is usable only when (a) the retrieval is
  fresh (`fetchedAt` within the 120s fetch window) **and** (b) the `asOf` age is within
  expected + tolerance. A fresh fetch can never mask an old timestamp, and an old timestamp can
  never be ignored by pointing at the fetch time.
- **No realtime overlay, fail closed.** For the connected Alpaca paper account the cascade stops
  after Level 1a (same as Tradier paper): Yahoo / IEX / Finnhub / Tiingo / ROIC can never replace a
  symbol the delayed tape priced, and a symbol the delayed feed did **not** price stays **missing**
  rather than silently becoming a realtime quote.
- **Secondary paper accounts are not the venue.** Level 1b treats another paper account's book as a
  delayed tape (`venueDelayedTape`) and strips venue-authoritative / expected-delay flags, so it
  can neither stop the cascade nor outrank the active venue.
- **Cache identity.** The enrichment cache key is `scope + prefix + symbol`; scope derives from the
  credential source only. The delayed tape therefore gets a distinct prefix
  (`alpaca-snapshot:<accountId>:delayed_sip`) so a `delayed_sip` snapshot can neither be served to
  nor overwrite an `iex` snapshot of the same symbol within the ~30s snapshot TTL.
- **`alpaca-mcp` / ops paths untouched.** `src/lib/ops-performance.ts` still constructs the
  snapshot provider without a feed override (operator-level live marks).
- **Test fixture change (deliberate).** `test/quotes-cascade.test.ts` defaulted its cascade fixture
  to an Alpaca **paper** account with the comment "Default: Alpaca realtime venue". Under the new
  (authorized) semantics that fixture means a venue-delayed tape, so it was switched to an Alpaca
  **live** account to keep the pre-existing realtime-cascade coverage meaningful; the Alpaca paper
  path has its own coverage in the new test files.
- **No new dependency.** The Alpaca v5 SDK already supports `feed: "delayed_sip"` on
  `stockLatestQuotes` / `stockLatestTrades`.

## 4. Verification State

```
npx tsc --noEmit                                   → PASS (exit 0)
npx vitest run test/alpaca-paper-delayed-sip.test.ts test/quotes-cascade.test.ts test/data-providers.test.ts
                                                    → 216 passed (3 files)
npx vitest run test/alpaca-paper-gateway-feed.test.ts
                                                    → 3 passed
npx vitest run test/data-providers.test.ts          → 142 passed
```

Full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`) was run at commit time
— see the commit message and the branch state for the final result.

## 5. Next Steps & Blockers

- **PR (operator):** open a PR for `gb-trader/alpaca-paper-delayed-quotes` (suggested title/body
  below). `gh` was not used, per the task constraint.
- **Merge → auto-deploy:** merging to `main` auto-deploys (weekday RTH latch applies). The owner
  decides when to land it; this branch was **not** deployed.
- **Post-deploy verification (owner/operator):** confirm the connected paper account's quotes now
  carry `asOf` ages ~900s, that the approval card shows the venue-delayed tape, and that the
  staleness gate does not trip on the expected delay.
- **Linear:** the live effort board is Linear team `ST`; this session could not reach the Linear
  MCP connector, so no issue was created/moved. The operator should open/move the corresponding `ST`
  issue when the PR is raised.
- **Blockers:** none for the code path. Open items are the deploy/verification steps above.

## 6. Zero-Code Findings

- `alpacaDataFeed()` is a **process-global** env read and its allowlist rejects `delayed_sip`
  (pinned by `test/data-providers.test.ts`). Left global and unchanged on purpose — the delayed
  tape is now an account-scoped override, not an env setting.
- `resolveAlpacaMarketData()` returns `{ apiKey, secretKey, source }` with **no** environment or
  account id, so paper-vs-live was invisible downstream of it. Left as-is (it is a *market-data*
  credential resolver, deliberately shared); the account-scoped decision is made from the connected
  account row instead.
- The v5 SDK's `StockLatestFeed` type already includes `"delayed_sip"`, and both
  `stockLatestQuotes` and `stockLatestTrades` accept `feed` — no SDK workaround was needed.
- The Alpaca snapshot enrichment cache is an in-process `Map` keyed by
  `scope + prefix + symbol` with a ~30s quote-family TTL; feed/account identity was absent from
  the key and is now folded in for the account-scoped tape.
