# 2026-06-19 — Pinecone RAG fix (v8 upsert) + Robinhood MCP data wiring

Branch: `agent/claude` (worktree `~/apps/trading-claude`). Not yet committed/merged at time of writing.

## Summary
1. **Fixed the empty-Pinecone RAG pipeline end-to-end** and backfilled the index
   (0 → 83 vectors live). Root cause was two stacked problems: (a) Voyage embedding
   calls 429'd because billing wasn't on the account when ingestion ran, and the
   failure was swallowed to `console.error`; (b) a **latent Pinecone SDK v8 API bug** —
   `index.upsert(records)` (bare array) is wrong for `@pinecone-database/pinecone@8`,
   which requires `index.upsert({ records })`. The upsert line had **never executed
   before** because Voyage 429'd first every time, so the v8 mismatch was invisible.
2. **Wired Robinhood MCP market data** (`get_equity_historicals` → OHLC cascade,
   `get_equity_fundamentals` → enrichment) behind the existing `ROBINHOOD_ADAPTER=mcp`
   gate. Inert until OAuth is connected (adapter currently `mock`).
3. **Added Alpaca's free Benzinga news as an enrichment provider** (`AlpacaNewsEnrichmentProvider`,
   keyed by the existing Alpaca paper key/secret). One batched call covers all scan symbols;
   supplies `headlines` + `sentiment`. Placed ahead of Alpha Vantage in the cascade, which
   demotes AV's redundant NEWS_SENTIMENT (AV can now be dropped). Live-verified: `alpaca-news`
   appears in `MarketScan.source`, and a direct API probe returned real symbol-tagged Benzinga
   headlines with the present keys.
4. **Closed the HOUSE-congress gap via an Apify actor adapter.** Added `fetchApifyCongress` +
   `parseApifyCongress` to `web-sources/congress.ts`, running the `johnvc/us-congress-financial-
   disclosures-and-stock-trading-data` actor (pay-per-result, ~$0.00001/row). House-only by
   default (eFD stays authoritative for the Senate; `WEB_SOURCE_APIFY_CONGRESS_CHAMBERS=all`
   to include Senate). Wired as the 2nd congress adapter (eFD → apify → capitol). Live-verified
   end-to-end: forced refresh returned **186 trades = 125 House + 61 Senate** (House was 0 before).

## Data-source findings (no code change)
- **FMP free tier 429s on all congress endpoints** (`v4/senate-trading`, `v4/senate-disclosure`,
  `stable/senate-trades`, `stable/house-trades` all returned `Limit Reach`). So House congress
  data is NOT reliably available on the current FMP plan — the House gap needs Apify `johnvc`
  (~free) or QuiverQuant Hobbyist API ($30), or a paid FMP tier.

## Why
- The user reported app.pinecone.io showed zero vectors. Investigation (workflow,
  pm2 logs, live probes) proved the scrape ran (83 fresh 8-Ks) but no vectors stored.
- Robinhood MCP is the richest first-party data source we already have transport for;
  `get_equity_historicals`/`get_equity_fundamentals` were exposed but unused.

## Files (all in `~/apps/trading-claude`)
- `src/lib/vector-db.ts` — **v8 upsert fix** (`index.upsert({ records })`); `storeContexts`
  now returns `StoreContextsResult` and persists outcome via `audit("vector_store", …)`
  + `setInternalSetting("vectorStore:lastIngest", …)` (no more silent failures); added
  `getVectorStoreStats()` (live `describeIndexStats`).
- `src/lib/web-sources/sec8k.ts` — added `reindexEightKDataset(userId, limit)` to backfill
  the **persisted** dataset (normal refresh only embeds newly-`fresh` filings).
- `src/lib/robinhood.ts` — added `robinhoodMcpDataEnabled()`, `fetchRobinhoodHistoricals()`
  + `parseRobinhoodHistoricals()` (→ `OHLCBar[]`), `fetchRobinhoodFundamentals()`; all
  return null/{} unless `ROBINHOOD_ADAPTER=mcp`.
- `src/lib/history.ts` — added a Robinhood tier to the OHLC cascade
  (Massive → Tradier → Marketstack → **Robinhood** → Yahoo → Stooq).
- `src/lib/data-providers.ts` — added `RobinhoodEnrichmentProvider` (opt-in via
  `ROBINHOOD_ADAPTER=mcp` + `ROBINHOOD_ENRICHMENT_ENABLED`); maps only high-confidence
  fields (P/E, sector/industry, 52wk, avg volume) to avoid unit-ambiguity surprises.
  Also added `AlpacaNewsEnrichmentProvider` (free Benzinga news via Alpaca paper keys),
  inserted ahead of Alpha Vantage in the cascade.
- `src/lib/web-sources/congress.ts` — NEW `fetchApifyCongress` + `parseApifyCongress` +
  `saneIsoDate` (guards garbage future dates like 2036); wired Apify as the 2nd adapter.
- `src/lib/db.ts` — registered `apify` → `APIFY_API_TOKEN` in the key map + alias.
- `test/web-sources.test.ts` — added `parseApifyCongress` tests (P/S incl. partial, chamber
  tag, garbage-date + exchange + no-ticker drops).
- `app/api/admin/reindex-8k/route.ts` — NEW dev-gated GET (stats) + POST (backfill).
- `app/api/admin/robinhood-probe/route.ts` — NEW dev-gated GET dumping raw
  `get_equity_historicals`/`get_equity_fundamentals` for one symbol (verify shapes
  before trusting the parsers).
- `app/api/admin/refresh-websource/route.ts` — NEW dev-gated POST to force a congress/sec8k
  refresh (bypasses TTL) for verification/ops.
- `.env.local` (claude worktree) — `APIFY_API_TOKEN`, `ROBINHOOD_MCP_REDIRECT_URI` (port 4100).
- `test/vector-db.test.ts` — mock now stubs `audit`/`setInternalSetting`; upsert assertion
  updated to the v8 `{ records }` shape.
- `.env.local` (claude worktree only) — `VECTOR_EMBED_BATCH_DELAY_MS=0`,
  `VECTOR_EMBED_BATCH_SIZE=16`, `WEB_SOURCE_SEC8K_RAG_LIMIT=64` (Voyage now billed).

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 226 passed (30 files).
- `npm run build` — compiled successfully.
- Live: `POST /api/admin/reindex-8k` → `{indexed: 83}`, `GET` confirms
  `vectorStore.totalVectorCount: 83` on index `robinhood-agentic` (was 0).
- Robinhood path not live-tested: adapter is `mock` (no OAuth token). Code is inert
  until `ROBINHOOD_ADAPTER=mcp` + token; verify shapes via `/api/admin/robinhood-probe`
  once connected, then enable `ROBINHOOD_ENRICHMENT_ENABLED`.

## Follow-ups
- **Propagate the v8 upsert fix to production / other worktrees** — the bare-array
  `index.upsert(records)` is wrong everywhere `@pinecone-database/pinecone@8` is installed.
  Any agent touching `vector-db.ts` must keep the `{ records }` form.
- For ongoing fresh-filing ingestion outside the claude worktree, set the same paid-Voyage
  env (`VECTOR_EMBED_BATCH_DELAY_MS=0`, larger `WEB_SOURCE_SEC8K_RAG_LIMIT`) where the
  scheduler runs (production `trading-live`).
- Consider surfacing `vectorStore:lastIngest` + live vector count in the dashboard /
  `getWebSourcesStatus()` so RAG health is visible without the admin route.
- Robinhood: connect OAuth (or set `ROBINHOOD_MCP_AUTH_TOKEN`), set `ROBINHOOD_ADAPTER=mcp`,
  hit `/api/broker/mcp/health` then `/api/admin/robinhood-probe?symbol=AAPL` to confirm
  tool availability + field shapes before relying on the historicals/fundamentals mapping.
