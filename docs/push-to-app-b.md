# What App B (the trading app) needs pushed from congress.trade (App A)

> **For App A's implementer.** App A's existing `app/docs/fmp-data-sharing.md` covers the
> **pull** side (`/api/market/bundle/{T}`, `/api/transactions`, …). This file is the **push**
> side: the webhook + SSE contract App B subscribes to. App B is a long-running Next.js server
> (PM2; e.g. `socratictrade.com`), so **SSE is preferred**; the webhook is the equivalent
> fallback. Implement both — App B picks one per deployment.
>
> Field names/types below match App B's internal consumer shapes exactly (see
> `src/lib/web-sources/types.ts`), so a conforming push is drop-in.

## 1. Events App B wants (priority order)

### (a) `congress.trade` — new congressional disclosures — HIGHEST VALUE
Push per affected ticker. `signal` is a **full per-symbol snapshot**, not a delta.

```jsonc
data = {
  "ticker": "AAPL",
  "signal": {                          // App B's CongressSignal — used directly
    "netSignal": 2,                    // distinct-buy members − distinct-sell members in window
    "buyCount": 3, "sellCount": 1,
    "buyMembers": ["Jane Doe","John Roe"],
    "sellMembers": ["Sam Poe"],
    "windowDays": 90,                  // App A's window; App B respects whatever you send
    "lastTradedAt": "2026-06-10",
    "lastDisclosedAt": "2026-06-15",
    "bulletin": "3 members bought AAPL (net +2) in last 90d; latest disclosed 2026-06-15"
  },
  "trades": [                          // underlying disclosures (optional; App B's CongressTrade)
    { "symbol":"AAPL","member":"Jane Doe","chamber":"house","side":"buy",
      "amountLow":15000,"amountHigh":50000,"owner":"Self",
      "tradedAt":"2026-06-10","disclosedAt":"2026-06-15","source":"congress.trade" }
  ]
}
```
`chamber` ∈ `senate|house`, `side` ∈ `buy|sell`.

### (b) `insider.update` — SEC Form 4 net-buy sentiment
App B uses one 0–100 scalar per symbol (50 = balanced):
```jsonc
data = { "ticker":"AAPL", "insiderSentiment":67, "asOf":"2026-06-15",
         "bulletin":"Insider buying skew 67/100 over 90d" }
```
If App A only has raw Form 4 rows, push those (`{symbol,owner,buyTx,sellTx,buyShares,sellShares,filedAt,accession}`) and App B will compute the 0–100; the scalar is preferred.

### (c) `ref.upsert` — securities-reference change (low frequency)
Payload = the same shape as an import `refs[]` entry. Lets App B drop FMP/enrichment lookups for those fields.

### (d) `price.eod` / `spx.eod` — EOD closes ready (optional)
Payload = the import `prices[]` / `spx` shapes.

App B's **must-haves are (a) and (b)**; (c)/(d) are nice-to-have.

## 2. Event envelope (identical for SSE and webhook)
```jsonc
{ "type":"congress.trade",        // | insider.update | ref.upsert | price.eod | spx.eod
  "id":"evt_01H...",              // globally unique → App B dedupes on this
  "seq":84213,                    // monotonic per stream → gap detection
  "emittedAt":"2026-06-22T14:03:00Z",
  "data": { /* type-specific */ } }
```

## 3. Transport A — SSE (preferred)

> **Contract as actually implemented (mutually honored, 2026-07-01).** The envelope below (§2) is the
> *logical* contract; App A's live wire format differs, and App B adapts to it (Workstream C1):
> - App A's `GET /api/stream` **requires** `?subscription=<id>` and authenticates a **per-subscription
>   secret** (via `Authorization: Bearer <secret>` or `?token=`). A consumer first creates an SSE
>   subscription (`POST /api/subscriptions {delivery:"sse", clientId}` → `{id, secret, streamUrl}`) or
>   is given an operator-provisioned `id`+`secret`. There is no `?types=`/`?tickers=` query filter — use
>   the subscription's `filters`.
> - App A emits per trade: `id:<cursorSeq>\nevent: trade.new\ndata:<raw Transaction JSON>` (the bare
>   Transaction, **not** the §2 envelope), plus control frames `event: cursor|ping|reconnect|error`.
> - App B (`src/lib/congress-stream.ts`) connects with `?subscription=` + the Bearer secret, maps each
>   `trade.new` Transaction into a `congress.trade` envelope before ingesting, and treats the control
>   frames as no-ops. See `docs/congress-trade-consume.md` §4.
> App A's own dashboard consumes `event: trade.new` + bare-tx via `EventSource`, so that SSE shape is
> fixed — App B conforms to it rather than the peer re-enveloping its stream.

```
GET https://congress.trade/api/stream
Headers: Authorization: Bearer <read-token>        (optional; reads are public per App A's doc)
Query  : ?types=congress.trade,insider.update&tickers=AAPL,MSFT   (optional filters)
```
- `text/event-stream`: set SSE `event:` = envelope `type`, SSE `id:` = envelope `id`, `data:` = the JSON envelope.
- **Resume (critical):** honor the `Last-Event-ID` request header — on reconnect, replay everything after that id (keep ~24h backlog). Without it App B loses events across reconnects.
- Heartbeat (`: heartbeat` comment or a `heartbeat` event) every ~25s so App B detects dead connections.

## 4. Transport B — Webhook (alternative)
```
POST <APP_B_BASE>/api/webhooks/congress
Headers: Authorization: Bearer <CONGRESS_WEBHOOK_SECRET>   Content-Type: application/json
Body   : <event envelope>   (or { "events":[ ...envelopes... ] } for batches)
```
- App B replies `2xx` fast with a **consumption receipt** JSON body (see §4b). On non-2xx, a `422` consumption failure, missing/invalid receipt, or timeout, retry with backoff (~5 tries over ~15 min); `id` makes retries idempotent.

### 4b. Consumption receipt (App B → App A acknowledgement)

App B's webhook handler returns a versioned receipt so App A can distinguish **HTTP delivery** from **event consumption** (applied into App B's datasets).

```jsonc
{
  "receiptVersion": 1,
  "delivered": true,          // always true on HTTP 2xx
  "consumed": true,           // false → App A must retry (even if HTTP was 200)
  "ok": true,                 // mirrors per-event apply success
  "eventId": "evt_01H...",    // echo of envelope id when present
  "type": "congress.trade",
  "applied": 2,               // rows written this delivery
  "duplicate": false,
  "reason": "optional detail when consumed=false"
}
```

Batch bodies (`{ "events": [ ... ] }`) return the same envelope with `count`, `applied` (sum), and `results[]` per event. App A treats `consumed=false` or an unparseable body as a failed delivery.

Legacy pre-receipt responses (`{ ok, applied, type, reason }` without `receiptVersion`) are upgraded client-side for a rollout window; new deployments should emit `receiptVersion: 1`.

## 5. Auth & secrets
- **Webhook (A→B):** shared bearer `CONGRESS_WEBHOOK_SECRET` (App A stores, App B verifies) — required (it writes into App B).
- **SSE (B→A):** token optional (reads are public); issue a scoped read token if you want it gated.
- Keep these separate from the `INGEST_TOKEN`/`CONGRESS_TRADE_TOKEN` (push side) so one leak doesn't grant the other.

## 6. Idempotency, ordering, scope
- App B dedupes on `id`. Gap recovery today = the SSE `Last-Event-ID` resume (implemented): on reconnect
  App B replays everything after the last id it saw, so keep a ~24h backlog. Still send `seq` —
  explicit seq-gap detection with an automatic re-pull (via `GET /api/transactions?since=`) is a planned
  App B enhancement, not yet wired.
- Out-of-order is safe: each `signal` is a full per-ticker snapshot.
- Push all US-equity congress/insider events; App B filters to its own universe.

## 7. What this lets App B retire
Once (a)+(b) flow reliably, App B stops scraping Senate eFD / Capitol Trades / SEC Form 4
(`web-sources/congress.ts`, `web-sources/sec.ts`) and trusts App A's feed — one source of truth.
