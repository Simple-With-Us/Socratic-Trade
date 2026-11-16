# Brokers + Data-Cascade Reliability Audit

**Date:** 2026-08-17  
**Auditor roles:** broker API engineer, market-data engineer, integration reliability specialist, fintech incident reviewer  
**Method:** read-only code review at `main` HEAD `4980322b` plus open-PR inventory.  No broker mutations.  No live order placement, cancel, or replace.  
**Scope:** Alpaca (REST + MCP), Tradier, Robinhood MCP, execution quote cascade, enrichment cascade, FilingAPI / ROIC / SEC / other ingest, schema drift, retries / backoff, rate limits, reconciliation, symbol normalization, price precision, stale / fallback honesty, idempotency, health lanes, user-visible correctness.

---

## 0. How to read this report

Each finding has **severity**, **exact evidence** (path + function + lines), **impact**, **tests**, and a **recommended fix**.  Severity:

| Severity | Meaning |
|---|---|
| **High** | Money-path or quota-path defect that can reject a real order, over-burn a paid/free cap, or show a stale print as live |
| **Medium** | Correctness / resilience gap that degrades fills, health, or sizing under load or schema drift |
| **Low** | Ops noise, dead code, or display honesty that does not place a wrong order today |
| **Info** | By-design or already solid; recorded so the next agent does not "rediscover" it as a bug |

This is a **point-in-time** audit.  Several related PRs are open and one owner reversal is in flight.  Section 1 is binding: do not treat `main`'s FilingAPI retirement as the final product decision.

---

## 1. Current-PR ledger (do not make stale claims)

| PR | Branch | State (2026-08-17) | What it actually does | Audit implication |
|---|---|---|---|---|
| **#2787** `b4666e74` | merged to `main` | **On HEAD** | Retired FilingAPI.dev: no live HTTP, no cascade registration, health lane intentional-off, ROIC + SEC EDGAR cover the class.  Do not buy Plus. | This tree matches retirement. |
| **#2792** | `cursor/filingapi-soft-skip-de61` | **OPEN, CONFLICTING** | Owner reversed #2787.  Keep `FilingApiEnrichmentProvider` + `filingapi` health lane.  Missing / invalid / 401 keys **soft-skip** (health stays green).  A later valid key is used again.  Do **not** buy Plus / do **not** charge Stripe. | Preferred if the owner reversal stands.  Do not close as "already retired." |
| **#2788** | `grok/retire-filingapi` | OPEN | Re-retire FilingAPI (same direction as merged #2787). | Conflicts with #2792.  Close the loser after the owner pick. |
| **#2798** | `cursor/alert-noise-retired-boot-64c1` | OPEN | Stamp `intentionalOff` on leftover FMP / Quiver / UW / FilingAPI 401 rows; mute live-boot `connection failed` pages for 5 minutes when `DB_BOOTSTRAP=live`. | Complements either FilingAPI policy.  Stops leftover 401s from paging. |
| **#2800** | `cursor/pinecone-write-deadlock-64c1` | OPEN | Stop clamping the Pinecone daily fuse to a leftover local-MTD remainder; **do not re-probe `vix-yahoo` while `vix-cboe` is serving**. | Fixes finding B6 independently of FilingAPI. |
| **#2799** `4980322b` | merged | On HEAD | Stop treating the Pinecone Standard trial as the Starter 2M monthly wall. | Already on this tree.  Daily-remainder clamp is #2800, not this. |
| **#2720** `8d198450` | merged | On HEAD | Alpaca `UND_ERR_SOCKET` retry; 3-streak connectivity halt; abort=soft; 1.5s health credits budget. | Do not re-claim "one socket death auto-halts Autopilot." |
| **#2751** `d068d432` | merged | On HEAD | Alpaca ≥$1 limit/stop rounds to `$0.01` (T `24.865` → `24.87`). | Do not re-claim the 2026-08-16 sub-penny 422 as open. |
| **#2576** / fleet triage | merged | On HEAD | Robinhood MCP option-chain / historicals send schema-legal args only (`additionalProperties: false`). | Do not re-claim extra `symbol`/`symbols` args. |
| **#2750** `1867addd` | merged | On HEAD | ROIC transcript walk is single-flight + start watermark + incremental cursor. | Do not re-claim the 714-row crash loop as open. |

**FilingAPI owner intent (this audit's working rule):** Plus checkout is **not** required.  On `main`, the lane is retired and sockets are refuse-closed.  Open #2792 restores the lane as **optional** and fail-soft on 401.  Until one of those PRs lands, operators will see both "retired" copy on `main` and "keep + soft-skip" copy on #2792.  This report describes **both** and does not pick.

**Also do not claim:**

- FilingAPI Plus is an owner action item (superseded 2026-08-17).
- Yahoo VIX 429s are "fine" while Cboe is up (that is the #2800 gap).
- Pinecone trial is the Starter 2M monthly wall (#2799 already landed; remaining deadlock is #2800).
- Local simulation / `paperMode` / fake fills exist as a product path (removed).
- Real data is labeled "mock" on user-facing quote cells (Yahoo floor or `—` / `n/a`).

---

## 2. Executive summary

The money path is **architecturally strong**: one `getBrokerGateway()` choke point (live preflight → declarative constraints → mutation-lease receipt), `client_order_id` / Tradier `tag` / Robinhood `ref_id` idempotency, Alpaca penny rounding at the broker boundary, hyphen↔dot share-class conversion at the Alpaca boundary only, honest Yahoo delayed tags, free-first enrichment waves, and retired-vendor URL refuse in `fetchWithRetry`.

The highest-value remaining defects on this HEAD:

1. **Alpaca REST/MCP still send `type: "stop_market"`.**  Tradier maps that word to `"stop"`.  Alpaca's OpenAPI enum is `market | limit | stop | stop_limit | trailing_stop`.  Protective stops call `placeEquityOrder({ type: "stop_market" })`.  The current test **asserts the wrong wire type**.
2. **Tradier plain (non-bracket) limit/stop prices are not cent-rounded**, while bracket legs are.
3. **Marketstack history and ROIC financials skip `admitProviderRequests`**, so documented quotas are not enforced at those call sites.
4. **ROIC execution-quote `asOf` and Yahoo quote-only scan `asOf` are fetch clocks**, so delayed prints can pass a 120s freshness gate.
5. **Neither Tradier nor Robinhood MCP retries HTTP 429**; Alpaca SDK `trackHealth` retries sockets but not 429s.
6. **FilingAPI product decision is unresolved** (#2792 vs #2788 vs merged #2787).  Runtime on `main` is fail-closed (no socket).  Ops noise from leftover 401 rows is #2798.

No finding in this pass shows a path that **places a buy when the user asked for a sell**, or that fabricates a price labeled as live broker data.

---

## 3. Findings

### A. Brokers

#### A1. Alpaca outbound order type is not mapped (`stop_market` → `stop`)

| | |
|---|---|
| **Severity** | **High** |
| **Evidence** | `AlpacaBrokerGateway.placeEquityOrder` REST payload sets `type: input.type` (`src/lib/alpaca.ts:660–666`).  MCP `orderArgs` does the same (`:721–727`).  Inbound mapper already translates Alpaca `"stop"` → `"stop_market"` (`mapAlpacaOrderType`, `:885–894`).  Tradier write path maps correctly: `mapTradierTypeWrite` (`src/lib/tradier.ts:162–165`).  Protective stops place `type: "stop_market"` (`src/lib/broker-protective-stops.ts:1520–1524`).  Alpaca SDK `createOrder` posts the body unchanged. |
| **Impact** | REST stop-market orders (fixed protective stops, any non-trailing stop) can 422 at Alpaca.  Native trailing on REST uses `trailPercent` and is a different type.  MCP uses `place_stop_order` but still forwards `type: "stop_market"`. |
| **Tests** | `test/alpaca-limit-stop-price-guard.test.ts` **"DOES set stop_price on a stop_market order"** asserts `expect(lastCreateOrderOpts.type).toBe("stop_market")` — it pins the defect.  `test/broker-protective-stops.test.ts` mocks the gateway and never hits Alpaca REST. |
| **Recommended fix** | Add `toAlpacaOrderType(type)` (`stop_market` → `stop`) and use it on REST + MCP payloads.  Flip the existing test to expect `"stop"`.  Do not change inbound `mapAlpacaOrderType`. |

#### A2. Alpaca MCP omits `extended_hours`

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | REST sets `extended_hours: true` when `input.marketHours === "extended_hours"` (`src/lib/alpaca.ts:682`).  MCP `orderArgs` (`:721–750`) never includes the flag.  Constraint table documents the gap (`src/lib/broker-order-constraints.ts:146–148`). |
| **Impact** | An `alpaca-mcp` extended-hours **limit entry** may execute in regular hours.  Exits are reshaped upstream by constraints, so the money-path risk is entries, not protective stops. |
| **Tests** | `test/broker-order-constraints.test.ts` covers the constraint reshape.  `test/alpaca-mcp.test.ts` does not assert `extended_hours` forwarding. |
| **Recommended fix** | Forward `extended_hours: true` on MCP limit orders when `marketHours === "extended_hours"`.  Add an MCP test mirroring the REST flag. |

#### A3. Alpaca `getEquityTradability` is a hardcoded stub

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `src/lib/alpaca.ts:561–563` returns `{ tradable: true, fractional: true }` for every symbol. |
| **Impact** | Sizing / pre-trade UI can propose fractional or shortable size on a halted, non-fractionable, or non-shortable name.  Failure is deferred to a broker 422. |
| **Tests** | None for Alpaca.  Tradier has `test/tradier.test.ts` "getEquityTradability reports fractional:false". |
| **Recommended fix** | Call `/v2/assets/{symbol}` (or the batch assets endpoint).  Map `tradable`, `fractionable`, `shortable`, `status`.  Cache with a short TTL. |

#### A4. Alpaca SDK `trackHealth` retries sockets, not HTTP 429

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `trackHealth` (`src/lib/alpaca.ts:255–286`) retries twice only when `isTransientNetworkError` (UND_ERR_SOCKET / "other side closed").  Market-data `fetchWithRetry` retries 429 with backoff and logs the final 429 soft (`src/lib/data-providers.ts:699–724`).  Broker SDK path does not. |
| **Impact** | A trading-API 429 can fail a placement or account read on the first hit and feed `order_place_infrastructure_failed` / connectivity streaks.  Socket death is already handled (#2720). |
| **Tests** | `test/transient-network-resilience.test.ts` covers socket retry.  No 429 case on `trackHealth`. |
| **Recommended fix** | Detect 429 in the SDK error shape; retry 2–3 times with jitter; log intermediate 429s soft.  Mirror `fetchWithRetry` policy. |

#### A5. Tradier plain-order limit/stop prices skip `roundCents`

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | Bracket legs: `bracketForm["price[0]"] = roundCents(...)` (`src/lib/tradier.ts:733–734`, `:742`, `:750–751`).  Plain single-leg: `form.price = input.limitPrice` and `form.stop = input.stopPrice` with **no** rounding (`:789–790`).  Write type mapping is correct (`mapTradierTypeWrite`, `:162–165`). |
| **Impact** | An LLM-emitted sub-cent limit (same class as the Alpaca T `24.865` 422) can reject a Tradier single-leg order while the identical price on a bracket would be accepted. |
| **Tests** | Bracket rounding is implied by OTOCO tests in `test/tradier.test.ts`.  No test asserts plain-order cent rounding. |
| **Recommended fix** | Apply `roundCents` to plain `form.price` / `form.stop`.  Add a unit test next to the bracket cases. |

#### A6. Tradier unknown order side defaults to `"buy"` on read-back

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `mapTradierSideRead` default branch (`src/lib/tradier.ts:147–159`) returns `"buy"`.  Write map is exhaustive for the four app sides. |
| **Impact** | Schema drift, or an option-class row leaking into the equity flatten, can appear as a **buy** in the dashboard and in exit-coverage math. |
| **Tests** | Known sides covered in `test/tradier.test.ts`.  No unknown/default case. |
| **Recommended fix** | Omit the row (or throw into `recordRecoverableIssue`) instead of defaulting to buy.  Add a regression test. |

#### A7. No HTTP 429 / retry on Tradier or Robinhood MCP

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `TradierBrokerGateway.request` throws on non-2xx with no retry.  `callRobinhoodMcpMethod` uses `AbortSignal.timeout(30_000)` only.  Documented as an open follow-up in `docs/rollouts/2026-07-10-tradier-broker.md`. |
| **Impact** | Scheduler bursts can fail a strategy run, health probe, or placement on a transient 429/5xx.  Safer than silent retry-into-duplicate **if** idempotency keys are honored — still an availability hole. |
| **Tests** | None in `test/tradier.test.ts` or `test/robinhood-mcp.test.ts`. |
| **Recommended fix** | Shared broker retry helper (429 + limited 5xx, jitter, cap).  Rely on existing `client_order_id` / `tag` / `ref_id` so a retried POST cannot double-fill. |

#### A8. Robinhood `getEquityOrders` casts `side` / `type` without validation

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `src/lib/robinhood.ts:335–339` — `side: item.side as OrderSide`, `type: item.type as OrderType`.  Tradier filters `class === "equity"` and maps sides.  Robinhood does not. |
| **Impact** | If `get_equity_orders` ever returns option rows or a new side string, dashboard / coverage sees an invalid `OrderSide`.  TypeScript trust is false. |
| **Tests** | `test/robinhood-orders-error-throws.test.ts` maps a populated list.  No option-pollution or unknown-side case. |
| **Recommended fix** | Validate `side ∈ {buy, sell}` (Robinhood has no native short/cover).  Drop or tag non-equity rows. |

#### A9. Robinhood `ordersListIncludesTerminal` is deliberately unset

| | |
|---|---|
| **Severity** | Medium (by design; operational cost) |
| **Evidence** | Comment on `HttpMcpRobinhoodGateway` (`src/lib/robinhood.ts:183–187`): terminal-inclusion window is unverified without a live token, so `reconcilePlacementError` must **not** conclude `not_placed` from an absent order.  Alpaca sets `ordersListIncludesTerminal = true` (`src/lib/alpaca.ts:174–178`) and paginates `status: "all"`. |
| **Impact** | Aged-out Robinhood fills stay in **uncertain** / `pending_reconciliation` longer.  Safer than a false `not_placed` retry that would duplicate. |
| **Tests** | Implied by `test/robinhood-orders-error-throws.test.ts`.  No live inclusion-window probe. |
| **Recommended fix** | Live-token probe of the inclusion window.  If confirmed, set the flag.  Until then, leave conservative. |

#### A10. `crossCheckRealizedPnl` is built and unwired

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `src/lib/robinhood-pnl-crosscheck.ts` exports `crossCheckRealizedPnl`.  Production callers: **none** (only `test/robinhood-pnl-crosscheck.test.ts`).  Alpaca / Tradier have no equivalent.  Fill reconcile is order-id matching only (`reconcilePendingFills` in `src/lib/strategy-execution.ts:1520–1584`) and **never** auto-flips from position math. |
| **Impact** | Manual trades, splits, and wash-sale differences vs Robinhood `get_realized_pnl` never surface.  Alpaca / Tradier have no read-only portfolio-vs-FIFO compare either. |
| **Tests** | `test/robinhood-pnl-crosscheck.test.ts` (7 cases).  `test/reconciliation-risk.test.ts` for order-id reconcile. |
| **Recommended fix** | Wire the RH check to a scheduled / admin diagnostic (read-only).  Optional Alpaca positions-vs-lots compare later.  Do not auto-mutate fills from a PnL delta. |

#### A11. Expiring Robinhood OAuth token without `refresh_token` is still returned

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `src/lib/mcp-oauth.ts:231–235`: if expiring and no `refreshToken`, return `tokens.accessToken`.  Env-migrated bearer tokens (`migrateLocalRobinhoodToken`) often have no expiry / refresh. |
| **Impact** | Silent MCP failures until 401, then `clearMcpOAuthTokens` forces reconnect.  Window of "connected" UI with dead calls. |
| **Tests** | Refresh path in `test/mcp-oauth.ts`.  No expiring-without-refresh case. |
| **Recommended fix** | If `isExpiring` and no refresh token, treat as needs-reauth (clear or throw with Connections copy).  Do not keep serving the stale bearer. |

#### A12. Robinhood quotes omit close fallback; failure returns `{}`

| | |
|---|---|
| **Severity** | Low |
| **Evidence** | Price chain is `last_trade_price ?? last_non_reg_trade_price ?? price ?? last_price` (`src/lib/robinhood.ts:371`).  No `close` / `previous_close`.  Catch returns `{}` (`:380–391`).  Tradier uses `last ?? close ?? ask ?? bid`. |
| **Impact** | After-hours / thin names can show missing broker prices; cascade may then pick Yahoo (honest, delayed).  Positions already fall back to average cost. |
| **Tests** | Quote mapping in `test/robinhood-mcp.test.ts`. |
| **Recommended fix** | Add `close` / `adjusted_previous_close` to the chain.  Prefer partial quotes over empty `{}` when some symbols succeed. |

#### A13. Robinhood health copy still mentions `ROBINHOOD_MCP_AUTH_TOKEN`

| | |
|---|---|
| **Severity** | Low |
| **Evidence** | `src/lib/robinhood.ts:508`.  Runtime token resolve no longer reads env (migrated to `local` at boot). |
| **Impact** | Misleading reconnect instructions for non-`local` users. |
| **Tests** | Missing-auth path in `test/robinhood-mcp.test.ts` does not assert the string. |
| **Recommended fix** | User-facing copy: "Connect Robinhood in Connections." |

#### A14. Alpaca trade-updates stream is operator-scoped

| | |
|---|---|
| **Severity** | Medium (multi-tenant) |
| **Evidence** | `startAlpacaTradeUpdatesStream` keys creds via `resolveAlpacaStreamAccount("local")` (`src/lib/streams/alpaca-trade-updates-stream.ts:47–50`).  `onBrokerFill` then reconciles the active Alpaca account (`src/lib/fills.ts:11–21`). |
| **Impact** | Real-time fill booking is for the operator's active Alpaca account.  Other users rely on scheduler `reconcilePendingFills` (delayed, still correct). |
| **Tests** | Price-stream tests in `test/alpaca-price-events.test.ts`.  No multi-user fill-stream test. |
| **Recommended fix** | Document the single-lane limit.  Optional: periodic reconcile for every Alpaca-connected account, or per-user stream fan-out. |

#### A15. Alpaca portfolio sets `optionMarketValue: 0`

| | |
|---|---|
| **Severity** | Low |
| **Evidence** | `src/lib/alpaca.ts:433–439`.  `totalMarketValue` still comes from Alpaca `portfolio_value`. |
| **Impact** | Options MV breakdown is understated; total equity is still the broker number. |
| **Tests** | None for the options split. |
| **Recommended fix** | Sum option position `market_value` from `getOptionPositions` when options exist. |

#### A16. Tradier multi-leg response shape is unverified live

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | Comment at `src/lib/tradier.ts:973–974`: nested `leg` shape follows docs, not a live multi-leg account. |
| **Impact** | User-placed OTOCO/OCO protective exits might not flatten into `getEquityOrders` → synthetic-stop double-exit risk (same class the pagination fix already addressed for option-only pages). |
| **Tests** | Mocked `leg` arrays in `test/tradier.test.ts`. |
| **Recommended fix** | Capture a sandbox multi-leg envelope and pin `equityRowsFromTradierOrder` to it.  Read-only. |

#### A17. Alpaca / Robinhood `ref_id` idempotency — sent, not dual-submit proven

| | |
|---|---|
| **Severity** | Low / Info |
| **Evidence** | Alpaca REST `client_order_id: input.refId` (`src/lib/alpaca.ts:665`).  Placement reconcile matches `clientOrderId === refId` (`src/lib/strategy-execution.ts:1974`).  Robinhood `ref_id: input.refId` (`src/lib/robinhood.ts:448–449`).  Tradier `tag: sanitizeTag(input.refId)`.  Protective-stop intent is persisted **before** the network call (`broker-protective-stops.ts:1515–1518`). |
| **Impact** | Alpaca + Tradier idempotency is strong.  Robinhood depends on the MCP broker honoring `ref_id`; a broker ignore would allow a duplicate after a lost reply (mitigated by the pre-network intent row). |
| **Tests** | `test/placement-reconcile.test.ts`, `test/placement-reconcile-sweep.test.ts`, `test/order-replacement.test.ts`. |
| **Recommended fix** | Optional live probe: same `ref_id` twice on Robinhood paper.  Document the result.  Do not change the conservative RH terminal-list flag until then. |

---

### B. Market-data cascade

#### B1. Duplicate `AlpacaNewsEnrichmentProvider` registration

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `getEnrichmentProvider()` pushes Alpaca news when `apiKey && secretKey` (`src/lib/data-providers.ts:1066–1068`) **and again** when `apiKey` (`:1073–1075`). |
| **Impact** | Wave A can fire two Benzinga news HTTP calls on a cold cache.  `activeSources` may credit `alpaca-news` twice.  Cache usually absorbs the second hit. |
| **Tests** | `test/data-providers.test.ts` does not assert single registration. |
| **Recommended fix** | Keep one registration (the `apiKey && secretKey` guard).  Delete the second block. |

#### B2. ROIC execution-quote `asOf` is fetch time

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | Quotes cascade Level 5 (`src/lib/quotes-cascade.ts:375–403`) stamps `asOf: new Date().toISOString()` and `provider: "roic"`.  A positive price then runs `isQuoteFresh` (default 120s) against **now**. |
| **Impact** | A delayed ROIC profile print can pass the accept window and stop the cascade as if it were a live tape.  Policy staleness gates then under-warn. |
| **Tests** | `test/quotes-cascade.test.ts` covers Tradier venue-delayed and Yahoo freshness.  No ROIC `asOf` case. |
| **Recommended fix** | Tag `provider: "roic-delayed"` and either omit `asOf` or never treat ROIC as fresh for the 120s accept window. |

#### B3. Yahoo quote-only scan rows overwrite market `asOf` with fetch clock

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `toQuoteOnlyMarketQuote` (`src/lib/market.ts:1407`) sets `asOf: new Date().toISOString()` even though Yahoo chart meta already carries a trade time (`src/lib/yahoo-finance.ts` chart `asOf`). |
| **Impact** | Custom-watchlist quote-only rows look "just now" on staleness chips and `fieldObservations` when the print is delayed. |
| **Tests** | No dedicated `asOf` propagation test on the quote-only path. |
| **Recommended fix** | Use `quote.asOf ?? fetchedAt`.  Keep `sources.asOf = "yahoo-finance"`. |

#### B4. Alpha Vantage fully deregistered when an Alpaca news key exists

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `src/lib/data-providers.ts:1076–1093`.  Inline comment already says this also drops AV `EARNINGS_CALENDAR` / `daysToEarnings`.  Nasdaq calendar is registered later and covers much of that field. |
| **Impact** | Users with both keys never get AV's market-wide earnings CSV.  `daysToEarnings` gaps depend on Yahoo / Finnhub / Nasdaq / ROIC.  AV daily quota alerts disappear (intentional). |
| **Tests** | None for this registration gate. |
| **Recommended fix** | If Nasdaq calendar coverage is accepted as sufficient, delete the lingering "AS-IS" comment.  Otherwise register AV in calendar-only mode (`suppliesFields: ["daysToEarnings"]`) when Alpaca news is present. |

#### B5. `mockEnrichmentProvider` / `MOCK_METRICS` still live in the production module

| | |
|---|---|
| **Severity** | Medium (footgun, not currently wired) |
| **Evidence** | `MOCK_METRICS`, `getFallbackMetrics`, `mockEnrichmentProvider` (`src/lib/data-providers.ts:429–473`, `:1255–1266`).  Aliased as `noopProvider` (`:1270`).  **Not** pushed in `getEnrichmentProvider()`. |
| **Impact** | One mistaken `providers.push(mockEnrichmentProvider)` would fabricate P/E, headlines, and sentiment and violate "never label real data mock." |
| **Tests** | `test/data-providers.test.ts` uses the export on purpose. |
| **Recommended fix** | Move to `test/fixtures/` or export only when `NODE_ENV === "test"`. |

#### B6. Health re-probe hits `vix-yahoo` while Cboe is serving

| | |
|---|---|
| **Severity** | Low–Medium |
| **Evidence** | `runHealthLaneReprobeIfDue` walks hard-stopped lanes; `probeFnForService("vix-yahoo")` (`src/lib/health-lane-reprobe.ts:271–284`) has no "skip if `vix-cboe` is green" guard.  Live macro path already prefers Cboe (`src/lib/macro.ts:523–527`). |
| **Impact** | Scheduled re-probes burn Yahoo VIX from datacenter IPs and paint 429 soft failures while Cboe is healthy. |
| **Tests** | `test/health-lane-reprobe.test.ts` on `main` has no skip case.  **#2800** adds the guard + tests. |
| **Recommended fix** | Merge #2800.  Do not re-probe `vix-yahoo` while the latest `vix-cboe` probe succeeded inside the interval. |

#### B7. Marketstack quota is defined but not admitted at the fetch site

| | |
|---|---|
| **Severity** | High (quota) |
| **Evidence** | `RATE_QUOTAS.marketstack` is 100 req / 30d (`src/lib/provider-rate-limit.ts:295–298`) with an explicit comment that `history.ts`'s `fetchMarketstack` does not call `admitProviderRequests`.  `fetchMarketstack` (`src/lib/history.ts:743–759`) calls `politeFetchJson` only.  Tiingo and ROIC history **do** admit (`:459–460`, `:699`). |
| **Impact** | Free-tier monthly cap can be exceeded on burst history failover.  Real HTTP 429 / account throttle with no local gate. |
| **Tests** | Quota resolver tests exist.  No history-path admission test. |
| **Recommended fix** | `admitProviderRequests("marketstack", credKey, 1)` before fetch; refund on transport skip. |

#### B8. Scan stale fallback wording is honest

| | |
|---|---|
| **Severity** | Info (correct) |
| **Evidence** | When Nasdaq screener fails, `market.ts:326–331` uses `persistedMarketQuotes` with warning "stale fallback" and provider `persisted-strategy-scan`.  Not labeled mock. |
| **Impact** | User sees stale-but-real last scan.  Correct. |
| **Tests** | Partial via scan tests. |
| **Recommended fix** | None. |

---

### C. FilingAPI / ROIC / SEC / ingest

#### C1. FilingAPI on `main` is refuse-closed; owner reversal is #2792

| | |
|---|---|
| **Severity** | Medium (product / ops, not a live socket) |
| **Evidence** | `RETIRED_DIRECT_VENDORS` includes `filingapi` (`src/lib/retired-direct-vendors.ts:21–26`).  `fetchWithRetry` refuses `filingapi.dev` (`src/lib/data-providers.ts:656–658`).  Cascade warns and does not register (`:1113–1118`).  No `RATE_QUOTAS.filingapi` (`src/lib/provider-rate-limit.ts:290`).  Health: `isIntentionalOffHealthService("filingapi")` (`retired-direct-vendors.ts:80–82`); public `/api/health` skips intentional-off rows (`app/api/health/route.ts:237–239`).  Catalog status `retired` (`src/lib/data-catalog.ts:73`).  Leftover metadata remains in `provider-tier-plan.ts`, `db-api-keys.ts` env-name map, and Connections archaeology. |
| **Impact** | On this HEAD: no FilingAPI spend, no 401 from a new probe.  Historical 401 rows can still look noisy until #2798.  #2792 would restore the provider and treat 401 as `unauthorized-skip` / green.  #2788 would re-assert retirement. |
| **Tests** | `test/retired-direct-vendors.test.ts`, `test/data-providers.test.ts` "never registers FMP, Quiver, or FilingAPI", `test/health-alert-noise-gate.test.ts` "a retired filingapi 401 never alerts", `test/source-capability-matrix.test.ts`. |
| **Recommended fix** | Owner pick: land #2792 (soft-skip, keep lane) **or** keep `main` + close #2788.  Do not buy Plus.  Land #2798 either way.  Re-audit health/alert behavior if #2792 merges (fingerprint skip, no `node:crypto` in `db-health`). |

#### C2. ROIC financials skip request-quota admission

| | |
|---|---|
| **Severity** | High (quota) |
| **Evidence** | `fetchRoicFinancials` (`src/lib/web-sources/roic-financials.ts:154–174`) uses `fetchWithRetry` only.  Transcript `roicGetJson` admits first (`src/lib/web-sources/roic-transcripts.ts:421–427`).  History `fetchRoic` admits (`src/lib/history.ts:459–460`).  Default quota is 5/min (`RATE_QUOTAS.roic`). |
| **Impact** | Multi-year financial pulls can burn the Individual plan without sharing the transcript / enrichment budget. |
| **Tests** | `test/roic-financials.test.ts` is parse/format only. |
| **Recommended fix** | Mirror `roicGetJson` admission (and refund on null / suppressed status). |

#### C3. ROIC retrieval gate is env-only

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `roicEnvKeyPresent` / `roicTranscriptsEnabled` (`src/lib/web-sources/roic-transcripts-gate.ts:42–54`) read `ROIC_API_KEY` / `ROIC_KEY` env only.  Producer uses `resolveApiKeyWithSource("roic", userId)`. |
| **Impact** | Ingest can run on a Connections-stored key while the RAG retrieval gate stays off unless env is set — corpus / retrieval asymmetry. |
| **Tests** | Producer due logic in `test/roic-transcripts.test.ts`.  No gate-vs-Connections test. |
| **Recommended fix** | Document as intentional, or expose a cycle-free "key configured" bit for the vector-db gate. |

#### C4. ROIC admit is not refunded on suppressed HTTP statuses

| | |
|---|---|
| **Severity** | Low |
| **Evidence** | `roicGetJson` admits 1 then returns `null` on `!res.ok` without `refundProviderRequests`. |
| **Impact** | 400/404/429 still consume the minute budget.  Minor coverage loss on free / Individual rpm. |
| **Tests** | None. |
| **Recommended fix** | Refund when the upstream call should not count (mirror enrichment cascade). |

#### C5. SEC submissions `JSON.parse` is uncaught on the primary response

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `fetchRecentFilings` (`src/lib/web-sources/sec-filings.ts:300–310`): network errors return `[]`, then `JSON.parse(raw)` has no try/catch.  Shard fetches **are** wrapped (`:326–337`). |
| **Impact** | Truncated / HTML-error EDGAR JSON aborts the filing-refresh tick instead of recording a per-symbol error. |
| **Tests** | `test/sec-filings.test.ts` covers helpers and ingest idempotency.  No malformed-JSON case on the primary body. |
| **Recommended fix** | Wrap primary parse like the shard path; push to `result.errors`. |

#### C6. CIK miss falls back to placeholder `0000000000`

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `getCikForTicker` (`src/lib/web-sources/sec-filings.ts:77–90`) returns `"0000000000"` on miss.  Callers: `maybeRefreshSecFilingAbstract` (`:470–471`) does `if (!cik) return` — **never true** for this placeholder.  `ingest` path (`:551`) writes artifacts under that CIK. |
| **Impact** | Unknown tickers get EDGAR URLs / `sec-artifacts/` under a bogus CIK.  Failures look like "fetch failed" rather than "no CIK."  Wastes embed budget. |
| **Tests** | None for this fallback. |
| **Recommended fix** | Return `null`.  Skip discovery.  Surface explicit "no CIK" in refresh errors. |

#### C7. SEC / ROIC ingest idempotency and single-flight are solid

| | |
|---|---|
| **Severity** | Info |
| **Evidence** | SEC: `hasIngestedAccession` (`sec-filings.ts:518–528`), commit-proof before ledger (`:647–693`), `runWithOperationLease` (`:804–814`), budget preflight before EDGAR (`:536–548`).  ROIC: `roicRefreshDueFromState` (`roic-transcripts.ts:233–240`), `LAST_ATTEMPT_KEY` stamped at start (`:746–747`), module `__roicTranscriptRefreshInFlight` (`:717–733`). |
| **Impact** | The 2026-08-16 714-row ROIC crash loop is closed on this HEAD.  Duplicate 10-K/10-Q accessions are not re-embedded. |
| **Tests** | `test/sec-filings.test.ts`, `test/sec-ingest-worker.test.ts`, `test/vector-db-lease-fencing.test.ts`, `test/roic-transcripts.test.ts:139–175`. |
| **Recommended fix** | None.  Do not "simplify" the start watermark. |

#### C8. Vendor JSON is defensive parsing, not shared schemas

| | |
|---|---|
| **Severity** | Low |
| **Evidence** | ROIC: `parseRoicTranscriptResponse`, `parseRoicEarningsCallList`, `parseRoicFinancialStatements`.  SEC: `parseRecentFilings` on untyped JSON.  Zod `safeParse` is used on Congress / Usage-Monitor peers, not on these ingest paths. |
| **Impact** | Shape drift fails soft (null / empty) rather than at a schema boundary.  Harder to detect a silent field rename. |
| **Tests** | `test/roic-transcripts.test.ts`, `test/roic-financials.test.ts`, `test/sec-xbrl.test.ts`, `test/sec-filings.test.ts`. |
| **Recommended fix** | Optional Zod at ROIC list/body and SEC submissions boundaries.  Keep fail-soft. |

---

### D. Cross-cutting reliability

#### D1. Two outbound budget systems

| | |
|---|---|
| **Severity** | Medium |
| **Evidence** | `admitProviderRequests` / `RequestQuota` (`src/lib/provider-rate-limit.ts:383–490`, SQLite namespace `provider-request-quota`).  Crash-durable `reserveProviderDispatch` (`src/lib/db-provider-dispatch.ts:186–475`).  Pacers (`HARD_DEFAULTS`) are a third layer. |
| **Impact** | Operators must know which path each provider uses.  Redeploy resets in-memory quota (durable map mitigates).  Dispatch leases are the Pinecone / Voyage / OpenRouter fence. |
| **Tests** | `test/provider-rate-limit.test.ts`, `test/provider-dispatch-durability.test.ts`. |
| **Recommended fix** | Add a one-page matrix (admit vs dispatch vs pacer-only) to `docs/source-capability-matrix.md`.  Do not collapse the two systems in this audit. |

#### D2. Symbol normalization is boundary-correct for equities

| | |
|---|---|
| **Severity** | Info |
| **Evidence** | Internal canonical is hyphen (`BRK-B`) via `normalizeSymbol` (`src/lib/money.ts:24–26`).  Alpaca boundary: `toAlpacaSymbol` / `fromAlpacaSymbol` (`:32–41`).  Tradier has a matching dotted wire form.  Crypto is out of scope (`cryptoTrading: false` on Alpaca accounts).  Options use OCC strings on Alpaca only. |
| **Impact** | Share-class 422s from hyphenated Alpaca symbols are closed.  Crypto / malformed OCC remain untested edges. |
| **Tests** | `test/alpaca-order-mapping.test.ts` (BRK.B round-trip).  Tradier BRK-B/BRK.B in `test/tradier.test.ts`. |
| **Recommended fix** | Keep conversion at the broker boundary only.  If crypto is ever enabled, add an explicit constraint block first. |

#### D3. Price precision: Alpaca boundary is correct; Tradier plain path is not

| | |
|---|---|
| **Severity** | Info (Alpaca) / see A5 (Tradier) |
| **Evidence** | `roundAlpacaPrice` (`src/lib/money.ts:18–22`): ≥$1 → pennies; <$1 → four decimals.  Applied on Alpaca REST/MCP limit/stop/bracket fields.  Internal proposals may still show unrounded values until the gateway. |
| **Tests** | `test/alpaca-limit-stop-price-guard.test.ts` "rounds a sub-penny T limit … to 24.87".  No isolated `money.test.ts` for the <$1 four-decimal path. |
| **Recommended fix** | Add `roundAlpacaPrice` unit cases for `0.12345` → `0.1235`.  See A5 for Tradier. |

#### D4. P/E display: `n/a` vs `—` is implemented

| | |
|---|---|
| **Severity** | Info |
| **Evidence** | Ingest drops non-positive P/E (Yahoo / Finnhub / RapidAPI parsers).  Scan table: `eps <= 0` → `n/a`, missing → em dash (`app/console/scan/columns.tsx:194–211`).  Drilldown `peDisplay()` matches (`drilldown-data.ts:246–253`). |
| **Impact** | User-visible correctness matches AGENTS.md.  Edge: negative EPS with missing `eps` shows `—` not `n/a`. |
| **Tests** | `test/console-drilldown.test.ts`, `test/wisesheets-provider.test.ts`. |
| **Recommended fix** | None required. |

#### D5. Source attribution is contributing-providers only

| | |
|---|---|
| **Severity** | Info |
| **Evidence** | Per-field `sources` + `fieldObservations` via `takeScalar` / `arbitrateFieldObservation` (`data-providers.ts:1539–1682`).  `MarketScan.source` is built from providers that actually contributed (`market.ts:605–615`).  Synthetic bid/ask stay tagged through `applyEnrichment` (`:1434–1437`).  Yahoo close fallback on Alpaca quotes uses `provider: "yahoo-finance-delayed"` (`src/lib/alpaca.ts:42–59`). |
| **Impact** | Honest.  Duplicate Alpaca news (B1) can double-credit the same id. |
| **Tests** | `test/alpaca-quote-fallback.test.ts`, quotes-cascade / on-demand-quote tests. |
| **Recommended fix** | Fix B1. |

#### D6. Health lanes: critical vs soft vs intentional-off

| | |
|---|---|
| **Severity** | Info |
| **Evidence** | Critical liveness (`app/api/health/route.ts:213–217`): `pinecone`, `alpaca-broker`, plus `rag-embed` / `rag-rerank` when the embed provider is configured.  Soft: `[expected-limit]`, HTTP 429, abort/timeout (`src/lib/db-health.ts:26–46`).  Intentional OFF: FMP / Quiver / UW / FilingAPI (`retired-direct-vendors.ts:67–83`).  Re-probe skips intentional-off (`health-lane-reprobe.ts:9`).  Broker lanes: `alpaca-broker`, `tradier-broker`, `robinhood-broker` (plus `alpaca-snapshot`, `alpaca-account-insights`). |
| **Impact** | A FilingAPI leftover 401 must not 503 the container (it does not, on this HEAD).  Alpaca broker hard-stop **can** 503 — correct for a trading host. |
| **Tests** | `test/soft-health-failures.test.ts`, `test/health-lane-reprobe.test.ts`, `test/health-alert-noise-gate.test.ts`, `test/connection-health-routing.test.ts`. |
| **Recommended fix** | Land #2798 for leftover-row mute.  Land #2800 for VIX re-probe. |

#### D7. Cancel is not wrapped in the mutation-lease / constraint proxy

| | |
|---|---|
| **Severity** | Info |
| **Evidence** | `getBrokerGateway()` wraps **`placeEquityOrder` only** (`src/lib/broker.ts:65–83`, `:106–156`, `:174–187`).  `cancelEquityOrder` / `cancelBracketSiblingLegs` go straight to the adapter. |
| **Impact** | By design: cancels must not be blocked by entry-shape constraints.  Cancel responses invent a random `refId` on Alpaca (`alpaca.ts:820–829`) — tracing only. |
| **Tests** | `test/alpaca-brackets.test.ts` (404 → no-op on sibling cancel). |
| **Recommended fix** | None for money path.  Optional: return `refId: orderId` on cancel for audit join. |

---

## 4. What is solid (do not "fix")

1. **Single placement choke point.**  `getBrokerGateway()` → live preflight → `withOrderConstraints` → `withMutationLeaseReceipt` → adapter.  Cancels are intentionally unwrapped.
2. **Alpaca placement idempotency.**  `client_order_id = refId`, `status: "all"` pagination, `ordersListIncludesTerminal = true`, pre-network protective-stop intent.
3. **Alpaca penny rounding and share-class conversion** at the broker boundary (`roundAlpacaPrice`, `toAlpacaSymbol` / `fromAlpacaSymbol`).  Sub-penny T 422 is closed (#2751).
4. **Known Alpaca 422 traps.**  TIF forced to `day` on fractional/notional; `stop_price` only on stop-family types; bracket-on-exit reshape; extended-hours entry block on REST.
5. **Tradier paper vs live host.**  `environment` is authority (`sandbox.tradier.com` vs `api.tradier.com`).  No env-token fallback.  Dollar market orders refuse a non-Tradier quote.
6. **Robinhood OAuth.**  Per-user tokens, PKCE, refresh singleflight, encrypted-at-rest when `ENCRYPTION_KEY` is set, 401 clears tokens, 30s MCP timeout, tenant isolation tests.
7. **Robinhood #2576.**  Option chain / historicals send schema-legal args only.
8. **Robinhood short/cover fail-closed.**  `toMcpOrder` throws; constraint table blocks.
9. **UND_ERR_SOCKET.**  One retry, first miss not logged; connectivity halt is a 3-streak (#2720).
10. **Free-first enrichment waves** + `quotaScarce` + `suppliesFields`.  RapidAPI is wave C only.
11. **`fetchWithRetry`.**  Retired-host refuse, 429 soft health, secret scrubbing, circuit breaker.
12. **Execution quote cascade.**  Active broker → other brokers → Alpaca snapshot → Yahoo batch → Yahoo single → ROIC → stale best-quote.  Tradier sandbox is venue-authoritative delayed.  Never empty if any level had a real price.  Never labeled mock.
13. **P/E `n/a` vs `—`.**  Implemented on scan + drilldown.
14. **ROIC single-flight + SEC accession idempotency + vector lease fencing.**
15. **Paper/live Alpaca credential scoping.**  Connected account keys win; no operator-key trading fallback for a selected account; WS host matches `environment`.

---

## 5. Inventories

### 5.1 Broker gateway surface (`BrokerGateway`)

| Read | Write |
|---|---|
| `getAccounts`, `getPortfolio`, `getEquityPositions`, `getOptionPositions?`, `getEquityOrders`, `getEquityQuotes`, `getEquityTradability`, `reviewEquityOrder`, `probeOrderCapability?` | `placeEquityOrder`, `cancelEquityOrder`, `placeOptionOrder?`, `cancelOptionOrder?`, `cancelBracketSiblingLegs?` |

Option **place** is Alpaca-only.  Tradier and Robinhood are positions-read / enrichment only for options (`optionsOrders: false`).

This audit did **not** call any write method against a live or paper broker.

### 5.2 `RATE_QUOTAS` (`src/lib/provider-rate-limit.ts:280–312`)

| Key | Default windows | Wired at fetch? |
|---|---|---|
| `twelvedata` | 8/min, 800/day | Yes (enrichment) |
| `tiingo` | 50/hour, 1000/day | Yes (`history.ts`) |
| `fmp` | 290/min | Retired HTTP; quota leftover |
| `roic` | 5/min | Transcripts + history yes; **financials no** (C2) |
| `marketstack` | 100/30d | **No** (B7) |
| `fintechstudios` | 50/day | Placeholder |
| `marketaux` | 80/day | Enrichment (scarce) |
| `earningscalls` | 8/day | Placeholder |
| `rapidapi` | 30/min, 200/day | Shared RapidAPI bucket |
| `fred` | 100/min | Yes |
| `apify` | 50/day | Yes |
| `logodev` | 5000/day | Yes |
| `filingapi` | *(none on main)* | Retired.  #2792 would restore a quota + fingerprint skip. |

Pacer-only (not `RATE_QUOTAS`): `finnhub`, `alpha-vantage`, `yahoo-finance`, `nasdaq-quote`, RapidAPI hosts, `roic` burst 200ms / concurrency 1.

### 5.3 Enrichment / quote cascade (this HEAD)

```
Scan:  Nasdaq screener → Yahoo quote-only → CascadingEnrichmentProvider → web-source overlay
       ↑ symbol_field_latest seed

Enrichment waves:
  A  free / keyless / broker (Nasdaq, Yahoo, Alpaca snapshot+news, RH fundamentals, …)
  B  paid gap-only (Finnhub, ROIC, SEC XBRL, Massive SI, …)
  C  quotaScarce RapidAPI / Marketaux / Wisesheets

Execution quotes:
  active broker → other brokers → Alpaca snapshot → Yahoo batch → Yahoo single → ROIC → stale best
```

FilingAPI is **not** in any wave on this HEAD.  #2792 would insert it as a keyed lane that no-ops without a live key.

### 5.4 Test files that already pin this area

| Area | Files |
|---|---|
| Alpaca | `test/alpaca-limit-stop-price-guard.test.ts`, `test/alpaca-order-mapping.test.ts`, `test/alpaca-tif-normalization.test.ts`, `test/alpaca-quote-fallback.test.ts`, `test/alpaca-brackets.test.ts`, `test/alpaca-mcp.test.ts`, `test/alpaca-account-insights.test.ts`, `test/transient-network-resilience.test.ts` |
| Tradier | `test/tradier.test.ts` |
| Robinhood | `test/robinhood-mcp.test.ts`, `test/robinhood-orders-error-throws.test.ts`, `test/robinhood-order-checks.test.ts`, `test/robinhood-pnl-crosscheck.test.ts`, `test/robinhood-tenant-isolation.test.ts`, `test/mcp-oauth.test.ts` |
| Constraints / sides | `test/broker-order-constraints.test.ts`, `test/broker-protective-stops.test.ts`, `test/broker-side.test.ts`, `test/broker-held-orders.test.ts`, `test/broker-status-conformance.test.ts` |
| Reconcile | `test/placement-reconcile.test.ts`, `test/placement-reconcile-sweep.test.ts`, `test/reconciliation-risk.test.ts`, `test/order-replacement.test.ts` |
| Cascade | `test/quotes-cascade.test.ts`, `test/on-demand-quote.test.ts`, `test/data-providers.test.ts`, `test/source-capability-matrix.test.ts`, `test/enrichment-scarce-tier-gate.test.ts` |
| Quotas / health | `test/provider-rate-limit.test.ts`, `test/provider-tier-plan.test.ts`, `test/soft-health-failures.test.ts`, `test/health-lane-reprobe.test.ts`, `test/health-alert-noise-gate.test.ts`, `test/retired-direct-vendors.test.ts` |
| ROIC / SEC | `test/roic-transcripts.test.ts`, `test/roic-financials.test.ts`, `test/sec-filings.test.ts`, `test/sec-xbrl.test.ts`, `test/sec-ingest-worker.test.ts` |

---

## 6. Recommended fix order (not this PR)

This PR is **report-only**.  Suggested follow-up lanes, smallest first:

1. **A1** — `toAlpacaOrderType` + flip the test that pins `stop_market` on the wire.  Money path.
2. **A5** — `roundCents` on Tradier plain `price` / `stop`.
3. **B7 + C2** — admit Marketstack history and ROIC financials.
4. **B2 + B3** — stop stamping fetch-time `asOf` on delayed ROIC / Yahoo quote-only rows.
5. **B1** — drop the duplicate Alpaca news registration.
6. **A6 + A8** — fail-closed read-back sides.
7. **A4 + A7** — 429 backoff on broker SDK / Tradier / RH MCP (idempotent retries only).
8. **C5 + C6** — SEC primary JSON parse + CIK null (not `0000000000`).
9. **Owner:** #2792 vs #2788; then #2798; then #2800.
10. **A10** — wire `crossCheckRealizedPnl` as a read-only admin/scheduler diagnostic.

Do not re-open Plus checkout.  Do not re-add a mock enrichment tier to the live cascade.  Do not auto-mutate fills from a PnL crosscheck.

---

## 7. Verification (this audit)

Read-only.  Commands actually run:

```text
git log -5 --oneline
# 4980322b fix(rag): stop treating the Pinecone Standard trial as the Starter 2M monthly wall (#2799)
# 5f9b4aaf feat(console): wire settings-search catalog into command palette (#2791)
# b4666e74 fix(data): retire FilingAPI.dev; ROIC + EDGAR cover the class (#2787)

gh pr list --state open
gh pr view 2792 --json title,state,mergeable,headRefName
```

Line-level confirmation (this session, not agent hearsay):

- `src/lib/alpaca.ts:561–563`, `:660–682`, `:721–737`, `:255–286`
- `src/lib/broker-protective-stops.ts:1520–1524`
- `src/lib/tradier.ts:147–165`, `:733–734`, `:789–790`
- `src/lib/data-providers.ts:1066–1118`, `:699–724`
- `src/lib/quotes-cascade.ts:375–403`
- `src/lib/market.ts:1407`
- `src/lib/history.ts:743–759`
- `src/lib/web-sources/roic-financials.ts:154–174`
- `src/lib/web-sources/sec-filings.ts:77–90`, `:300–310`, `:470–471`
- `test/alpaca-limit-stop-price-guard.test.ts:115–130`
- `src/lib/retired-direct-vendors.ts:19–26`, `:80–82`

No `npm test` / `npm run build` in this PR (docs only).  No broker HTTP writes.

---

## 8. Out of scope

- Kalshi event contracts, Webull / eToro / Public.com (not on this HEAD as live execution venues).
- LLM Green/Red failover and OpenRouter slug bugs (separate 2026-08-17 lanes).
- Pinecone WU fuse math beyond noting #2799 landed and #2800 is open.
- iOS / website UI chrome except P/E display and Connections health copy.
- Live production ops snapshot (not required for a static integration audit; no broker mutations).
