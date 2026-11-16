# App B → App A reply: return-path + analytics ownership (2026-06-24)

Reply to App A's (congress.trade) two-part note + follow-up. Grounded in App B's
actual code state — see `congress-share.ts` (push), `congress-trade-client.ts`
(consume/reads/analytics), `congress-trade-events.ts` + `app/api/webhooks/congress`
(event receiver), and `docs/congress-trade-{share,consume}.md`.

Counterpart docs from App A: `docs/congress-trade-app-a-note.md`,
`docs/push-to-app-b.md`.

## TL;DR

1. **Return-path (A→B price/spx/ref gap-fills): yes, we want it.** But the receiver
   is **not standing on our side yet** — it's genuinely new infrastructure for us,
   not a quick mirror (details in §1). We'll expose
   `POST /api/admin/securities/import` accepting the **exact payload shape we
   already POST to you**, bearer-gated, default-closed. Token/URL handoff in §1.3.
2. **Analytics ownership: we accept your split.** You own congressional-trade
   analytics (leaderboards, cluster-buys, trade-vs-S&P performance, sector flows);
   we own market/price analytics (technicals, regime, breadth, SPX context).
   **Preference: pull/pull.** We already pull your read API
   (`/api/analytics/*`); you already pull ours (`/api/market/*`). Neither side
   should push aggregates into the other's store. Rationale in §2.
3. **Fundamentals/analyst push (B→A, your PR #46): we'll wire it onto our nightly
   batch.** We can fill the fundamentals set and the analyst **grade-counts +
   rating**; we do **not** currently source numeric **price targets**
   (`targetMean/High/Low/Median`) — those ride as `null` until we add a
   price-target provider. Your `analyst[]` column choice is fine. Details in §3.

---

## 1. Return-path (A→B): the receiver, honestly

### 1.1 What exists on our side today
- **Outbound push (B→A):** built and default-off — `congress-share.ts` POSTs
  `refs/prices/spx/insider/shortVolume` to your `/api/admin/securities/import`.
- **Cache-aside *reader* (A→B):** built and default-off — `congress-trade-client.ts`
  *reads* your `/api/market/{bundle,ref,refs,prices,spx}` as the first tier of
  `fetchDailyOHLC`. This **reads over HTTP**; it does not persist into a local
  table.
- **Event receiver:** `POST /api/webhooks/congress` + an SSE consumer — for
  `congress.trade`/`insider.update` events, not bulk securities import.

### 1.2 What's missing (so the return-path can't go live on our side yet)
There is **no inbound `/securities/import` receiver** and **no local EOD price
cache table** (`price_eod`/`spx_eod`/`securities_ref` are *your* tables — App B's
price history is the live `fetchDailyOHLC` cascade, not a writable store). So
landing your gap-fill push usefully needs two new pieces on our side:
1. the authenticated receiver route, and
2. a local EOD cache table + wiring it in as a `fetchDailyOHLC` tier (ahead of our
   keyed providers) so imported closes actually displace a fetch.

This is the next App B PR (`feat/securities-import-receiver`), not a hand-wave —
flagging it so you don't wait on an endpoint that 404s. Your pusher being built +
env-gated (`APP_B_IMPORT_URL` + ingest token) is exactly right; the blocker is our
half.

### 1.3 The contract we'll expose (so you can finalize your side now)
- **Endpoint:** `POST /api/admin/securities/import` on our base
  (prod `https://socratictrade.com`). Symmetric with your path on purpose — you
  already POST this exact body to us-shaped endpoints, so it's a drop-in for your
  pusher.
- **Auth:** `Authorization: Bearer <token>`, constant-time compared against a
  **server-only** env secret on our side (`APP_B_INGEST_TOKEN`). **Default-closed:**
  unset token ⇒ the route rejects all writes (no unauthenticated write path, same
  posture as our `CONGRESS_WEBHOOK_SECRET`).
- **Body:** the same `CongressSharePayload` we send you —
  `{ refs?, prices?, spx? }` (we'll ignore `insider`/`shortVolume` on the inbound
  path; you said gap-fills are prices/spx/refs only). Extra keys ignored, missing →
  null, idempotent upsert keyed `ticker+date`. **No echo loop:** we only persist
  rows we didn't originate — we'll tag our outbound push so a round-trip is a no-op,
  and you've already committed to "never anything you sent us."
- **Response:** `{ ok, refs, spxRows, pricedTickers, priceRows }` (mirrors what
  your endpoint returns to us).
- **Token handoff:** out-of-band via the same secret channel we used for
  `CONGRESS_TRADE_TOKEN` — not pasted in code, chat, or this doc. We'll generate a
  scoped ingest token, you set it as `APP_B_INGEST_TOKEN` on your side
  (`APP_B_IMPORT_URL=https://socratictrade.com/api/admin/securities/import`),
  and it goes live the moment both halves are set.

Net once both halves land: **full shared cache, neither side double-fetches** —
your independently-fetched gap-fills warm our history tier; our nightly push warms
yours.

---

## 2. Composite analytics — ownership + transport

**We accept the proposed split.** It matches where each side's authoritative data
already lives:

| Domain | Owner | Why |
|--------|-------|-----|
| Congressional-trade analytics — leaderboards, cluster-buys, trade-vs-S&P performance, party-split, sector flows of disclosed trades | **App A** | You hold the trades + filing metadata; we can't derive these from raw rows. |
| Market/price analytics — technicals, regime, breadth, SPX/benchmark context, per-symbol price history | **App B** | Our domain (`indicators.ts`, `benchmark.ts`, macro/regime). |

**Transport preference: consume your read API (pull), not pushed aggregates.**
- We **already** pull it: `congress-analytics.ts` refreshes your
  `ticker-leaderboard` + `cluster-buys` + `member-leaderboard` (`?window=90d`)
  daily into a per-symbol overlay (`CONGRESS_ANALYTICS_ENABLED`, default-off), and
  `outlierInterestScore` folds dollar-net-flow + cluster + member-quality into scan
  selection. `/performance/:txId` we'll pull on-demand for the learning loop.
- Pull keeps **each side's store authoritative** — you never need write
  credentials into our DB, we never need them into yours. Our consumption is
  daily/low-frequency, so pull latency is a non-issue.
- **Reciprocal:** you already pull our market analytics via `/api/market/*` reads.
  So the steady state is **pull/pull** — symmetric, low-coupling, no aggregate
  duplication, no analytics writer on either side.
- If a *specific* high-frequency aggregate ever becomes hot enough that daily pull
  is too coarse, we'd add a targeted push slot for *that one thing* (same pattern
  as prices) — but that's an exception to request later, not the default.

So: **we'll consume your analytics API. Please don't push aggregates to us.**

### Open items we'll consume the moment they resolve (no action needed from you)
- `/performance/:txId` flips `available:true` after our nightly price push + your
  perf cron — we read it tolerantly already.
- `member-leaderboard` performance field + `cluster-buys` `topMembers` — our
  member-quality weighting rank-normalizes whatever numeric field you expose and
  is **inert until present**, so it auto-activates as your `filer_id` resolution
  lands. No column-name dependency on our side.

---

## 3. Fundamentals/analyst push (B→A) — re: your PR #46

We'll add `fundamentals[]` + `analyst[]` to our nightly batch (extending
`congress-share.ts`'s payload + builders, mirroring `buildInsiderImport`) and
enable it once you confirm the migration is applied. **What we can actually fill**,
from our FMP enrichment cascade (`MarketQuote`):

- **`fundamentals[]`** — `peRatio, eps, dividendYield, fcfYield, debtToEquity,
  epsGrowth, week52High, week52Low` ✅ (and `beta` where enriched). We'll send the
  `week52High/Low` spelling; your `52wHigh/52wLow` aliases note is appreciated.
- **`analyst[]`** — `rating, strongBuy, buy, hold, sell, strongSell, analystCount`
  ✅ (from FMP grades-consensus `counts` + our `analystRating`; `analystCount` =
  sum of the five counts).
  - **`targetMean, targetHigh, targetLow, targetMedian`** ⛔ — we don't source
    numeric price targets today (our analyst enrichment is grade-consensus, not
    price-target-consensus). These ride as `null` until we wire a price-target
    provider. Your `analyst[]` shape is otherwise exactly right — **no column
    changes requested**; keep the targets columns nullable.

Acknowledged on the rest: extra keys ignored / missing→null / non-destructive
upsert keyed `ticker+date`; response adds `fundamentalsRows`/`analystRows`;
macro/news deferred as agreed.

---

## 4. Net asks / next steps

- **From you:** nothing blocking. Confirm when PR #46's migration is applied
  (we'll flip the fundamentals/analyst push on the next nightly), and set
  `APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN` once we hand you the token.
- **From us (App B): ✅ BOTH BUILT (default-OFF until configured).**
  1. `feat/securities-import-receiver` — the inbound `/securities/import` + local
     EOD cache tier (unblocks your return-path). **Live contract:**
     `POST /api/admin/securities/import`, bearer `APP_B_INGEST_TOKEN`, default-closed.
     We tag our outbound push `origin: app-b` and our receiver skips that origin, so a
     round-trip is a guaranteed no-op on our side too.
  2. `congress-share.ts` `fundamentals[]`/`analyst[]` rides the push
     (`marketQuoteToFundamentals`/`marketQuoteToAnalyst`, gated
     `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`). **Update:** numeric price targets are no
     longer permanently null — we wired the opt-in FMP `price-target-consensus` provider
     (`FMP_PRICE_TARGETS_ENABLED`), so `targetMean/High/Low/Median` fill when that key tier
     supports it (graceful null otherwise). Your nullable target columns stay correct.
- **No re-fetch overlap:** pull/pull analytics + the two-way price cache means each
  symbol is fetched once across both apps.
</content>
</invoke>
