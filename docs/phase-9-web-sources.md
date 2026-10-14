# Phase 9 - Backend Web Sources (scraped / no-free-API signals)

Status: implemented 2026-06-16 (branch `web-sources`). These are read-only data ingests; broker
paper/live execution remains intrinsic to the connected account.

## 2026-07-13 consumption update

Web-source presence is no longer treated as proof of decision value. The enrichment/strategy path
now retains per-field provenance and availability, provider failures, upstream-family deduplication,
per-run source coverage, and decision-time leave-one-winning-provider-out score receipts. Those
receipts join to matured realized/skipped outcomes as observational source-value telemetry. A failed
source remains distinguishable from a neutral or no-match result.

The same run timestamp is passed into filing retrieval, retrieved text is treated as untrusted data,
and Green/Red receive the same evidence manifest. This does not make source-value estimates causal
or complete the separate SEC corpus backfill; limitations are cataloged in
`docs/reviews/2026-07-13-decision-evidence-architecture.md`.

## Goal

Connect high-value signals that have **no reliable free key-based API** by reading
them server-side from public sources, on a low frequency, and feeding them to the
scoring engine, the agent prompt, and the dashboard — **without ever fabricating a
value**. If a source is down, the signal is simply absent (cells show `—`).

The headline source is **congressional trading**: politicians disclose stock trades
on a delay, and copycat retail flow tends to follow a disclosure. Surfacing fresh
disclosures lets the agent act on the same names *before* the copycats pile in.

## Architecture (`src/lib/web-sources/`)

- **`types.ts`** — `CongressTrade`, `CongressSignal`, `SymbolWebSignal`,
  `WebSourceRefreshResult`, `WebSourceConnector`.
- **`http.ts`** — polite fetch helpers: descriptive User-Agent (browser UA for
  scrape targets; SEC fair-access UA via `SEC_EDGAR_USER_AGENT`), per-request
  `AbortController` timeouts, light retry on 429/5xx, a **sequential rate limiter**
  (`runRateLimited`) so a refresh can't burst a .gov host, and cookie-jar helpers.
- **`congress.ts`** — congressional-trade ingestion. When `CONGRESS_TRADE_AS_CONGRESS_SOURCE` is on (the default), Congress.Trade is tried first.  If it returns trades, Senate eFD is not scraped.  If it throws, or returns no trades and the poll was not a successful empty incremental cursor, the free Senate eFD scrape runs.  Quiver's direct API is retired and is not called.  When the flag is off, adapters run in this order:
  1. **Senate eFD** (`efdsearch.senate.gov`) — authoritative, free, no key.
     Validated live: GET `/search/` (CSRF + cookies) → POST `/search/home/`
     (accept terms; the Django CSRF token **rotates** here) → POST
     `/search/report/data/` (PTR filings list) → GET each e-filed PTR view page →
     parse the transactions table. Parsing classifies each cell by *content*
     (ticker / date / amount / Purchase|Sale) rather than fixed column index, so
     it survives column reordering. Paper (PDF) filings are skipped.
  2. **Apify `johnvc` actor** (`us-congress-financial-disclosures-and-stock-trading-data`)
     — **HOUSE coverage** (the eFD gap). Keyed (`APIFY_API_TOKEN`), pay-per-result
     (~$0.00001/row ≈ $0.09/mo daily). Runs the actor synchronously
     (`run-sync-get-dataset-items`) with `Start_Date`=window + `Max_Results`, parses
     normalized House Clerk disclosures (`parseApifyCongress`), and is **House-only by
     default** so it complements eFD's Senate (`WEB_SOURCE_APIFY_CONGRESS_CHAMBERS=all`
     to include Senate). Date sanity-guards drop garbage future dates. Returns `[]` when
     no token. Live-verified: a forced refresh returned 125 House + 61 Senate trades.
  3. **Capitol Trades** (`bff.capitoltrades.com`) — public JSON back-end (House +
     Senate). Best-effort + configurable (`WEB_SOURCE_CAPITOLTRADES_URL`, or set
     it to `off` to disable); their CDN/security layer has returned 503/429 from
     server-side fetches, so it's a tertiary fallback now that Apify covers the House.
### Durable FTS completion invariant (corrected 2026-09-09, PR #3202)

SEC filing ingest mirrors chunk text into the `document_chunks_fts` FTS5 table, resuming
across ticks so a large filing never pins the single Node event loop.  **The resume offset is
derived from CONTENT, never from a row count.**

`document_chunks_fts_index` is keyed `(content_hash, symbol, source, accession)`, so
byte-identical chunks inside one filing — repeated table headers, boilerplate, empty sections
— collapse onto ONE row.  A `COUNT(*)` of that table is therefore NOT the number of chunks
mirrored, and using it as a positional offset into the chunk array stalls permanently at the
first duplicate: the count can never reach the position, the same slice is re-mirrored on
every tick forever, `mirror.complete` never becomes true, and `insertIngestedAccession` never
runs.  That is exactly what caused the 2026-09-09 event-loop stall and the public 503
(`docs/rollouts/2026-09-09-fts-mirror-nonconvergence.md`).

The invariant now is:

- **Resume** = the first chunk whose `content_hash` is not yet mirrored for that occurrence
  (`ftsMirrorResumeOffset()`, `src/lib/db-learning.ts`).  Mirroring a chunk indexes its hash,
  so the next resume is strictly greater — progress is monotonic and the loop always terminates.
- **Mirrored** = the side-index key exists AND its `fts_rowid` still owns a live FTS row on
  all four identity columns.  A key alone is not proof: FTS5 reuses the max rowid after a
  DELETE, so an unpaired wipe of `document_chunks_fts` can leave keys pointing at nothing or at
  a later filing's chunk (`ftsRowidStillOwnsOccurrence`).  A stale key must never mask absent
  content, or the accession gets ledgered with text that was never indexed.
- **Complete** = every distinct content hash of the filing satisfies the above.  Do not test
  completeness with `COUNT(*) = chunk_count`; it under-reports every filing that repeats any
  chunk text.  `docs/designs/2026-08-16-proposer-corpus-storage.md` item 11 is corrected to match.

Occurrence lookups are served by `idx_document_chunks_fts_index_occurrence (symbol, source,
accession)` (migration 88); without it the lookup cannot seek, because the table's only other
index is a PK leading with `content_hash`.

- **`sec.ts`** + **`insider-bulk.ts`** — SEC EDGAR insider (Form 4) ingestion.
  The nightly refresh (`refreshDueWebSources`, insider TTL) downloads the quarterly
  insider-transactions ZIP (current quarter and the quarter covering the prior 90
  days) and merges the current Form 4 atom feed as a delta.  Only open-market `P`
  and `S` count.  The score is dollar-weighted over 90 days: `100 * buyValue /
  (buyValue + sellValue)`, which is `50 + 50 * (net / total)`.  Unpriced rows fall
  back to shares, then to transaction counts.  Signals are cached by symbol on the
  dataset.  The atom feed is uncapped unless `WEB_SOURCE_INSIDER_MAX_FILINGS` is
  set above 0.  The old default cap of 60 filings and the 20-symbol watchlist
  slice are gone.  The watchlist XML pass runs unless the current quarter's ZIP
  downloaded.  A previous quarter alone is not coverage.  Bulk and XML rows for
  one accession keep the larger dollar, share, and transaction totals, so an
  unpriced XML body cannot erase ZIP prices.  Requests still use the SEC limiter.
  Codes `M`/`A`/`F`/`G` are ignored.
- **`fmp-transcripts.ts`** — default-off FMP earnings-call transcript discovery and body ingest.
  It requires both endpoint enablement and explicit storage/display-rights confirmation, uses the
  stable dates/body endpoints with header authentication, preserves first-content-observed time for
  point-in-time retrieval, accepts documented strict `period: "Q1".."Q4"` bodies plus numeric
  quarters, keeps content hashes separate from ticker-period occurrences, and records typed entitlement,
  bounded retry, quota, embedding-budget, and capability receipts without logging transcript content.
  Fatal UTF-8 and endpoint-specific envelope validation precede green telemetry; embedded provider errors,
  malformed/oversized bodies, and wrong endpoint rows produce one bounded redacted failure per attempt.
  Voyage document responses are accepted only as an exact request/response bijection; malformed batches
  fail atomically. Store errors, empty/incomplete writes, and invalid embeddings receive one priority
  retry before cursor rotation. Guarded fetch, Pinecone bootstrap/write, notification, usage-alert, and
  Sentry paths are awaited and re-prove the shared lease after every async boundary. Every completed
  occurrence has a real deterministic Pinecone vector with its own ticker/accession/PIT metadata; exact
  embeddings may be reused, but completion requires exact vector cardinality plus an atomic local
  content/occurrence receipt transaction. Edge-safe Web Crypto SHA-256 credential identities keep
  provider attempts and quota/cost reservations durable
  before each network/SDK boundary and replay `succeeded`/`failed`/crash-`unknown` outcomes. Managed
  vectors remain query-ineligible until exact provider and relational receipts agree. Transcript body
  revisions retain distinct content-version/PIT rows instead of overwriting history. A bounded,
  dry-run-default rights tool inventories provider ghosts plus local receipts/observations/tagged
  derivatives and performs provider-first verified purge. Rights generations also ledger exact derived
  chat, prompt-safety audit, decision, and framework artifacts plus unresolved derived provider work, so
  withdrawal blocks new writes, waits for terminal external receipts, and removes only proven transcript-
  derived state. A proven pre-upsert short circuit records `no_provider_write`; any timeout/error after
  dispatch records `provider_write_unknown` and retains the immutable authority-bound deletion obligation.
  Private managed-vector writes hold a durable account-operation claim from provider identity
  through receipt commit; account erasure requires current index authority and consecutive clean provider
  observations before deleting local evidence. Commercial rights and a genuinely shared cross-app FMP quota
  authority remain activation gates.
- **`index.ts`** — registry + the three entry points the app uses:
  `refreshDueWebSources()` (scheduler), `getSymbolWebSignals()` (scan overlay,
  cache-only / no network), `collectEvidenceBulletins()`, `getWebSourcesStatus()`, plus the separately
  paced `refreshFmpTranscripts()` corpus producer.

## Persistence + cadence

Datasets persist in the SQLite `settings` KV via `setInternalSetting` (survives
restart), each carrying its own `fetchedAt`. The scheduler tick calls
`refreshDueWebSources()` every 60s, but each connector **no-ops until its cadence
elapses** (default daily; congressional disclosures trickle in daily and getting
ahead of copycats rewards promptness). A refresh **never overwrites a good cached
dataset with nothing** on a transient outage.

Cost per refresh is small and bounded: Senate eFD ≈ 1 search + ≤80 PTR pages
(capped, rate-limited 350ms); SEC ≈ 1 feed + ≤30 filings × 2 reqs (rate-limited
250ms). Both run in the background, independent of whether autonomous trading is on. FMP transcripts
have their own exact-attempt cap, rotating demand-first symbol cursor, retry cadence, response-byte
limits, and remain entirely inert with either opt-in disabled.

### Cross-entry single-flight

Manual admin requests and scheduler/background calls converge at durable operation boundaries,
not only at the route layer. `src/lib/operation-lease.ts` stores owner-token leases in the existing
SQLite `settings` KV and uses an immediate transaction for atomic acquisition, a TTL heartbeat for
long work, and owner-checked release. Congress and SEC 8-K refreshes have separate dataset groups;
Congress daily sharing has its own group; 8-K reindex, 10-K/10-Q filing ingest, and enabled FMP
transcript ingest deliberately share the `rag-reindex` group because they spend the same
embedding/corpus-write capacity.

Contention in a background caller is a typed benign skip: it performs no provider request and does
not advance the connector attempt/daily marker. Admin admission acquires the durable lease before
debiting its per-admin rate budget, passes an opaque claim into the matching core function, and maps
busy outcomes to the shared operation-guard HTTP 409 contract. The detached best-effort embedding
started by `refreshEightK` remains detached; its summary/full-body work can continue after the
primary dataset-refresh lease is released, preserving the established non-blocking refresh contract.
That detached tail does not currently acquire `rag-reindex`; making it fully exclusive requires a
durable pending/retry job or awaiting it, and remains an explicit follow-up rather than a silent claim.

### Corpus re-embed purge safety

The bge-m3/Voyage embedding-space migration uses `POST /api/admin/reembed` to backfill locally
held corpus rows into the active embedding space before any legacy vectors are deleted. A
symbol-scoped run is useful for testing or targeted repair, but it is not proof that an entire
docType has been backfilled. `purge-legacy` must remain blocked until an unscoped docType run
records completion under the active embed revision; scoped runs deliberately do not write
`completedForEmbedRevision`.

## Wiring into the app

- **Scoring/UI/prompt** — `scanMarket` overlays `getSymbolWebSignals` onto the top
  candidates: it fills `senateTrades` (net distinct buy members − sell members)
  when a keyed provider didn't, fills `insiderSentiment` from SEC Form 4, and
  attaches `evidenceBulletins`. The Market Scan table gained a **Congress** column
  (bulletin as tooltip). The agent prompt now emits `smartMoneyEvidence` per
  candidate with guidance to treat a cluster of recent congressional/insider BUYS
  as a positioning tailwind worth front-running (and SELLS as a caution), as one
  input among many — not a standalone trigger.
- **Dashboard** — `getWebSourcesStatus()` (freshness, record counts, sources, due)
  is on the snapshot for a health indicator. Transcript status separately exposes the feature gate,
  rights gate, endpoint capability, cadence, and ingested count.
- **Strategy/Coach RAG** — transcript chunks are retrievable only while storage/display rights remain
  confirmed. Turning future ingestion off preserves already licensed evidence; withdrawing rights
  adds a global metadata exclusion so broad Coach/chat retrieval cannot bypass the Strategy filter.
  New `storeDocument` writes materialize repeated content per occurrence, so they retain queryable
  PIT/source provenance without inventing a missing vector ID. Reconcile any corpus written by the older
  content-only shortcut before treating legacy coverage as complete. Shared/public and private/account
  records now carry authoritative tenant scopes; local operator decision/experience memory is explicitly
  private, and legacy account-memory markers are exact-user filtered before receipt validation, rerank,
  candidate persistence, or prompting. Stale managed generations expand bounded provider topK using a
  local rejected-generation upper bound and emit a typed degraded receipt when the cap can still hide
  eligible evidence. Private and shared query tiers retain independent bounded candidate pools until
  cross-encoder reranking so dense-score saturation in one tier cannot erase recall from the other.
  Tenant visibility, relational receipt validity, and transcript-rights generation are enforced inside
  every tier before its share of Voyage's 1,000-document cap is allocated; stale/ineligible records therefore
  cannot consume quota and hide lower-scoring current evidence already returned by the provider. Multi-query
  RRF carries those tier identities into one final fair 1,000-document cap instead of collapsing the fused
  pool back to the single-query fetch count before reranking. Relational receipt validation batches
  candidate IDs below SQLite's portable host-parameter ceiling; a legal six-tier provider response can
  contain 60,000 raw IDs, so one unbounded `IN (...)` statement is not safe.
  Transcript-derived decision memory uses an immutable rights-generation vector ID plus a durable work
  lease bound to the exact Pinecone provider and SQLite namespace authority. Retrieval requires the
  currently active rights generation; provider/manifest rotation fails closed. Rights withdrawal keeps
  local receipts until provider delete/fetch/list verification is clean for multiple consecutive
  observations, resetting the streak if an eventually-consistent vector reappears. Account deletion
  holds the shared RAG-write lease and completes provider inventory,
  delete, and fetch-verification before removing local vector receipts or provider keys; globally deduplicated
  chunk text remains while any preserved shared occurrence references it, while durable local receipts recover
  private hashes on a retry after provider deletion. Provider-only inventory and
  erasure require the Pinecone credential but do not depend on a Voyage embedding credential.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `WEB_SOURCE_CONGRESS` | `on` | `off` disables the congress connector |
| `WEB_SOURCE_CONGRESS_TTL_MS` | 24h | refresh cadence |
| `WEB_SOURCE_CONGRESS_WINDOW_DAYS` | 60 | how long a trade counts toward the signal |
| `WEB_SOURCE_CONGRESS_LOOKBACK_DAYS` | 45 | how far back to pull new filings |
| `WEB_SOURCE_CONGRESS_MAX_FILINGS` | 80 | PTR pages fetched per refresh |
| `WEB_SOURCE_CAPITOLTRADES_URL` | bff default | override Capitol Trades; set `off`/`disabled` to skip the flaky fallback adapter |
| `APIFY_API_TOKEN` | — | enables the Apify House-congress adapter (no token → adapter skipped) |
| `WEB_SOURCE_APIFY_CONGRESS_CHAMBERS` | `house` | `all`/`both` to also keep the actor's Senate rows |
| `WEB_SOURCE_APIFY_CONGRESS_MAX` | 300 | `Max_Results` requested from the actor per refresh |
| `WEB_SOURCE_APIFY_CONGRESS_ACTOR` | johnvc actor | override actor id; `off` to disable |
| `WEB_SOURCE_APIFY_TIMEOUT_MS` | 180000 | actor run-sync timeout |
| `WEB_SOURCE_INSIDER` | `on` | `off` disables the SEC insider connector |
| `WEB_SOURCE_INSIDER_TTL_MS` | 24h | refresh cadence |
| `WEB_SOURCE_INSIDER_WINDOW_DAYS` | 90 | dollar-weighted rolling window |
| `WEB_SOURCE_INSIDER_MAX_FILINGS` | 0 | atom XML cap; 0 means uncapped. Bulk rows are never capped |
| `WEB_SOURCE_INSIDER_WATCHLIST` | `on` | Form 4s for watchlist tickers when the current quarter ZIP did not load |
| `WEB_SOURCE_13F` | `on` | official 13F-HR books for curated superinvestors |
| `WEB_SOURCE_13F_TTL_MS` | 7d | 13F refresh cadence (incomplete `okFilers` stay due after 1h backoff) |
| `WEB_SOURCE_ARK` | `on` | official ARK daily holdings CSVs |
| `WEB_SOURCE_ARK_TTL_MS` | 24h | ARK refresh cadence (`recordCount` 0 stays due) |
| `SEC_EDGAR_USER_AGENT` | `Socratic Trade research jay@socratic.trade` | SEC fair-access UA. Override with your own contact |
| `WEB_SOURCE_FMP_TRANSCRIPTS` | `off` | enables transcript endpoint use; still requires rights confirmation |
| `FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED` | `off` | operator assertion that persistence, embedding, retrieval, and display are permitted |
| `FMP_TRANSCRIPT_TTL_HOURS` | 24h | independent successful-refresh cadence |
| `FMP_TRANSCRIPT_MAX_REQUESTS_PER_RUN` | 12 | exact cap across discovery, body requests, and retries; `0` pauses calls |
| `FMP_TRANSCRIPT_MAX_PER_SYMBOL` | 2 | newest un-ingested fiscal periods attempted per symbol |
| `VECTOR_ERASURE_VERIFY_ATTEMPTS` | 4 | bounded provider-absence observations before erasure may commit |
| `VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN` | 3 | required consecutive clean observations; reappearance resets the streak |
| `VECTOR_ERASURE_VERIFY_DELAY_MS` | 500 | initial delay between erasure observations (bounded exponential backoff) |

## Adding another source

1. Add a connector module exposing `refresh*`, `is*RefreshDue`, `get*Signals`,
   `get*Dataset`, plus pure parsers (unit-tested with captured real-shape fixtures).
2. Register it in `index.ts`: refresh in `refreshDueWebSources`, merge its
   per-symbol contribution into `getSymbolWebSignals`, add to `getWebSourcesStatus`.
3. If it produces a new numeric field, follow the enrichment add-a-field checklist
   in `docs/phase-4-market-data-scoring.md` / `AGENTS.md` (`CLAUDE.md` symlinks
   there) (interface → union →
   EMPTY_SOURCED → cascade → MarketQuote → market.ts `applyEnrichment` → summary
   projection → prompt → UI).

## Follow-ups

- SEC **8-K** material-event bulletins are now implemented as coarse per-symbol
  "filed an 8-K" catalysts; richer per-item 8-K document summaries remain open.
- Sector is now threaded onto fills and has a scorecard; the composite thesis ×
  regime × **sector** × factor view remains open.
- Substantially-identical / House coverage for congress once a stable free House
  feed is available (the eFD scrape is Senate-only; Capitol Trades adds House when
  its back-end is up).
- Optional providers behind paid keys (Quiver, FMP paid senate/insider) as extra
  adapters in the same connectors.
