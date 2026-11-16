# 2026-11-06 - PR #5005 Kody review fixes (Alpaca PAPER `delayed_sip`)

## Context & Objective

`gb-trader/alpaca-paper-delayed-quotes` (PR #5005) moved the connected Alpaca PAPER
account onto Alpaca's account-scoped `delayed_sip` tape (expected ~900s publication
delay).  Kody's review of that PR raised eight findings against the branch head.  This
note records what was changed for each one, what was disputed, and the verification
state.  No deploy, no orders, no account/DB/credential changes.

## Changes Made

High level: the delayed tape is now **validated at every boundary it crosses** (vendor
payload, enrichment provider, scan quote, quote cascade), and an unusable delayed tape
is **no longer accepted as an authoritative venue price**.

### 1. Zod-validate the `stockLatestQuotes` response (Kody finding 1)

`src/lib/alpaca-sdk-legacy-client.ts` now validates the vendor envelope before it is
used:

- `AlpacaLatestQuotesResponseSchema` pins the `quotes` map (missing / `null` /
  non-map ⇒ **no** quotes, fail closed instead of a `TypeError`).
- `AlpacaLatestQuoteSchema` is deliberately **non-strict** (`.passthrough()`): Alpaca's
  quote rows carry vendor fields we do not model (`bp`/`ap`/`bs`/`as` and whatever the
  vendor adds next), and the legacy mapper forwards them verbatim.  Validation pins
  only the field we actually read (`t`, the observation stamp) and never strips or
  rejects a row because of a field we do not know about.
- Each row is validated individually, so one malformed symbol cannot discard a whole
  batch.

This mirrors the shape the same file already used for `stockLatestTrades`.

### 2. Connected-account lookup moves inside the Alpaca credential guard (Kody finding 2)

`getEnrichmentProvider` (`src/lib/data-providers.ts`) used to read the connected
account (and derive the account-scoped feed + cache identity) **unconditionally**, even
when the Alpaca snapshot provider was never registered because no Alpaca credentials
exist.  The lookup now lives **inside** the `alpacaData.apiKey && alpacaData.secretKey`
branch: no snapshot provider ⇒ no connected-account DB read on that path.

### 3. Delayed-tape metadata now reaches the scan quote (Kody finding 3)

Before this change the `delayed_sip` snapshot reached the market scan as a bare
`{price, bid, ask, asOf}` record.  The scan quote therefore looked like a realtime
observation whose `asOf` was ~900s old — i.e. stale — and the staleness gate rejected
healthy delayed rows.  The tape contract is now propagated end to end:

`parseAlpacaSnapshot(snap, tape)` → `SymbolEnrichment` → cascade merge →
`applyEnrichment` → `MarketQuote` (and the cascade's Level-2 `BrokerQuote`).

New fields on `SymbolEnrichment` / `MarketQuote`:

| field | meaning |
| --- | --- |
| `expectedDelaySec` | documented publication delay of the tape (Alpaca PAPER `delayed_sip` ≈ 900s) |
| `delayToleranceSec` | tolerance on top of it (120s) before lag counts as **excess** |
| `venuePriceAuthoritative` | the tape IS the active execution venue's own tape |
| `fetchedAt` | wall-clock stamp of the **retrieval** (when the snapshot was pulled) |

`fetchedAt` is what makes the delayed tape age correctly.  A delayed tape is aged by
*when it was pulled*, never by its ~900s-old trade print — so the retrieval stamp has
to travel with the enrichment all the way onto the `MarketQuote`.  It is stamped **only**
for the account-scoped `delayed_sip` feed, so a realtime snapshot keeps its observation
time as its freshness signal and is byte-for-byte unchanged.

They are stamped **only** for the account-scoped `delayed_sip` feed
(`AlpacaSnapshotEnrichmentProvider.tapeMetadata()`), which is the only feed that can
ever resolve to `delayed_sip` — the global `ALPACA_DATA_FEED` allowlist is
`iex|sip|otc`.  Every other feed (iex / sip / otc, and therefore every Alpaca LIVE,
Tradier, Robinhood account) is byte-for-byte unchanged.

### 4. `quotes-cascade.ts` is explicitly server-only (Kody finding 4)

`import "server-only";` is now the first line of `src/lib/quotes-cascade.ts`.  The module
resolves connected accounts, reads the trading policy and calls broker gateways; the
marker makes that boundary fail loudly at build time instead of shipping
credential-bearing code to a browser bundle.  Every importer is server-side
(`src/lib/*`, `app/api/*`); no client component imports it.

### 5. Dispute — the lag reason and the closed-session split (Kody finding 5)

**Disputed: no change needed — the finding is already addressed at branch head.**

The branch head already implements exactly what the finding asks for:

- The policy reason is `quote_last_print_beyond_delayed_sla` ("illiquid last print or
  excess tape lag" — a number cannot tell the two apart), not `quote_feed_excess_delay`
  ("feed broken"), so a last-print age is never reported as a broken feed.
- `delayedTapeStatus` takes `marketOpen` and reports `marketSessionOpen`; while the
  market is shut an old print is **not** excess delay (no prints happen while the
  market is closed) but the tape stays **unusable**, and the gate blocks it with the
  distinct `quote_delayed_tape_session_closed` reason.
- During RTH, a print beyond expected + tolerance is **excess delay** and **fails
  closed** — the opening is blocked, not silently accepted.

`src/lib/alpaca-paper-quotes.ts` and `src/lib/policy.ts` are therefore untouched by this
pass; the behaviour is pinned by the existing edge-matrix tests
(`test/alpaca-paper-delayed-sip.test.ts`).

### 6. An unusable delayed tape is not accepted as the authoritative venue price (Kody finding 6)

`src/lib/quotes-cascade.ts`, Level-1a `venueDelayed` accept path.  The path used to
stamp `venuePriceAuthoritative` on whatever the venue returned, without asking whether
the delayed tape was actually usable.  It now evaluates the delayed-tape usability
**before** the authoritative stamp — through `isQuoteFresh`, the same helper the finding
names, which routes a tape with a documented expected delay into
`delayedTapeStatus`:

- **Usable** (fresh retrieval, no excess lag) ⇒ accepted and stamped authoritative —
  unchanged behaviour.  The expected ~900s print is still accepted: the delay is the
  venue, not staleness.
- **Unusable** (lag beyond `expectedDelaySec + delayToleranceSec`, or a
  stale / future / missing retrieval stamp) ⇒ **not** accepted as the authoritative
  venue price.  The observation is kept (as a non-authoritative quote) so the staleness
  gate can report *why* it was refused, but it never becomes the venue's price.
- **No documented delay** (e.g. the Tradier sandbox tape) ⇒ unchanged: the active
  execution venue's price is authoritative by owner rule.

The closed-session nuance is deliberately **not** applied at this accept path: the
cascade decides only *whether the tape may be called authoritative*, while the honest
"the market is shut, so this print is not tradable" reason belongs to the policy
staleness gate (`quote_delayed_tape_session_closed`), which owns the market-session
awareness.  Applying it here as well would have made the accept path depend on the
wall clock (the same tape would be accepted or refused depending on the hour it was
evaluated) and would have turned the honest closed-session block into a missing-quote
block.

The `skipActiveBroker` guard is untouched, and a symbol the delayed tape could not
price still stays **missing**: no Yahoo/IEX overlay may fill it on the execution path.

### 7 + 8. Test-hygiene fixes (Kody findings 7 and 8)

- `test/alpaca-paper-delayed-sip.test.ts`: the `apiKeyFingerprint` mock returned
  `` `fp:${key}` `` — i.e. it echoed the credential it was fingerprinting.  It now
  returns a fixed synthetic `"fp:test"`.
- `test/data-providers.test.ts`: the `delayed_sip` test deleted `ALPACA_DATA_FEED` from
  the environment without restoring it.  It now saves and restores the variable in a
  `try` / `finally`.

## Files

- `src/lib/alpaca-sdk-legacy-client.ts`
- `src/lib/data-providers.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/market.ts`
- `test/alpaca-paper-delayed-sip.test.ts`
- `test/alpaca-sdk-client-timeout.test.ts`
- `test/data-providers.test.ts`
- `test/market.test.ts`
- `docs/rollouts/2026-11-06-pr5005-kody-review-fixes.md` (new)
- `STATUS.md`

## Decisions & Trade-offs

- **Non-strict quote schema on purpose.**  A strict schema would reject vendor rows
  that carry fields we do not model yet, which is the opposite of what the legacy
  mapper needs.  Only the envelope shape and the one field we read are pinned.
- **Per-row validation.**  Validating the whole `quotes` map in one go would let one
  bad symbol discard every other symbol's quote.  Rows are validated individually.
- **`venuePriceAuthoritative` on the enrichment.**  It is set only for the
  account-scoped `delayed_sip` tape, where the tape genuinely is the active execution
  venue's tape.  It is *not* set for any other feed, so no realtime snapshot changes
  meaning.
- **Closed-session tapes are judged by the gate, not by the cascade accept path.**  The
  cascade now asks one question — "is this documented delayed tape usable?" — through
  `isQuoteFresh`, exactly as the finding asks.  The market-session split stays where it
  already lived (`delayedTapeStatus` + the policy gate's
  `quote_delayed_tape_session_closed`), so the honest closed-session reason survives
  while the accept path stays deterministic (no wall-clock dependence).
- **Unusable tapes are kept as non-authoritative observations.**  Dropping them
  outright would erase the reason the gate can report.  They are never treated as an
  authoritative venue price and never trigger an overlay.
- **The cascade merge carries the tape metadata first-wins**, like the price-family
  scalars: the Alpaca snapshot provider is seated first (tier 1) and is the only
  provider that carries tape metadata.
- **No new dependencies.**  Zod was already a dependency and `server-only` was already
  installed and aliased in `vitest.config.ts` for the test stub.
- **No behaviour change for Alpaca LIVE, Tradier (live + paper), Robinhood or any other
  account**: those tapes carry no `expectedDelaySec`, so the delayed-tape branch of
  `delayedTapeStatus` never engages.

## Verification State

Commands run in this worktree (`/workspace/trader/gb-trader-wt-alpaca-paper-delayed-quotes`):

- `npx tsc --noEmit` — **clean** (exit 0, no output).
- `npx vitest run test/alpaca-paper-delayed-sip.test.ts test/alpaca-paper-gateway-feed.test.ts test/quotes-cascade.test.ts test/data-providers.test.ts test/staleness-gate.test.ts test/market.test.ts test/alpaca-sdk-client-timeout.test.ts`
  — **297 passed / 297**, 7 files (the 5 files named in the finding, plus the two files
  that carry the new client-validation and `applyEnrichment` tests).
- `npx vitest run test/alpaca-paper-delayed-sip.test.ts test/data-providers.test.ts --reporter=verbose -t "delayed"`
  — 34 passed (confirms the new delayed-tape tests are collected and passing).
- `npx vitest run test/data-providers.test.ts --reporter=verbose -t "credential guard"`
  — 2 passed (confirms the credential-guard tests are collected and passing).
- `npm run lint` — see the STATUS.md entry for the final state.

New tests added:

- `test/alpaca-paper-delayed-sip.test.ts` — "does NOT accept an UNUSABLE delayed tape as
  the authoritative venue price" (excess lag ⇒ not venue-authoritative, tape
  metadata preserved, no realtime overlay).
- `test/alpaca-sdk-client-timeout.test.ts` — "Alpaca legacy client — latest quotes
  validation": vendor fields preserved, malformed envelope fails closed, and one bad
  row does not discard the batch.
- `test/data-providers.test.ts` — "stamps the DELAYED-TAPE metadata on a delayed_sip
  snapshot", "does NOT stamp delayed-tape metadata on a realtime (iex) snapshot",
  "stamps the delayed-tape metadata onto the parsed snapshot", "leaves a realtime
  snapshot without any tape metadata", "stamps the delayed-tape metadata onto the
  enriched snapshot", and the two `getEnrichmentProvider — Alpaca credential guard`
  tests (no connected-account DB read without Alpaca credentials; the read still
  happens with them).
- `test/market.test.ts` — `applyEnrichment` carries the delayed-tape metadata and the
  retrieval stamp onto the quote, and leaves a realtime enrichment without them.

Not run in this pass: `npm test` (full suite) and `npm run build` — the branch is
pre-merge and the operator/CI runs the full gate; the focused suite above covers every
file this change touches.

## Next Steps & Blockers

- Operator reviews the PR and lets CI run the full gate.  Merging to `main` auto-deploys
  under the weekday RTH latch (evening / weekend / hotfix lands immediately).
- The Linear team-`ST` issue was **not** created from this session (no Linear connector
  is reachable here) — the operator still has to open it.
- After a deploy, watch the Alpaca PAPER account's scan rows: they should carry
  `expectedDelaySec ≈ 900` and must NOT trip the realtime-stale branch of the gate.

## Zero-Code Findings

- The `stockLatestQuotes` response was the only Alpaca SDK payload read without
  validation (`stockLatestTrades` was already validated in the same file).
- `applyEnrichment` already had the `expectedDelaySec` / `delayToleranceSec` /
  `venuePriceAuthoritative` fields on `MarketQuote`; they were simply never populated
  on the enrichment path, which is why the delayed tape looked realtime-stale.
- `quotes-cascade.ts` had no `server-only` marker even though it is imported only by
  server-side modules and handles credential-bearing lookups.
