# SEC/RAG 1,000-stock high-yield backfill plan

**Status:** implementation plan; no bulk backfill authorized or started
**Prepared:** 2026-07-12
**Baseline audited:** `origin/main@c9023ea6` and production release `c9023ea613aa4df0e650c3a5de69081ac479aade`
**Scope:** SEC primary-source documents and derived evidence for a frozen 1,000-issuer universe

## Implementation status (2026-07-13)

Implementation is active on `codex/sec-rag-program`; bulk corpus writes remain blocked. The first local slice
adds a versioned/checksummed universe acceptance contract and durable SQLite ingest jobs/tasks with leases,
bounded retries, dead-letter/quarantine states, verification receipts, and replay identity. Focused tests and
Node 24 type-checking pass. The committed legacy universe intentionally fails the new acceptance gate because
it is an unversioned bare array without source hashes, eligibility evidence, ranking inputs, aliases, or dated
snapshot truth. Historical SEC discovery/pacing, DOM/iXBRL parsing/chunking, and the corrected issuer census
are under isolated review; no SEC bulk fetch, object-store write, embedding, vector upsert, or production
backfill has started.

## Decision

The best design is **not** “turn every filing byte into a vector.” It is:

1. **Catalog every filing** and retain selected immutable SEC originals.
2. **Store exact facts and transactions structurally** when the source is XBRL/XML/tabular.
3. **Embed retrieval-worthy narrative, tables, and material exhibits** with occurrence-level provenance.
4. **Create derived summaries and filing-to-filing deltas only as cited children** of primary evidence.
5. **Retrieve through intent routing, dense plus true lexical recall, wide reranking, and compact evidence packets.**

This gives the LLM broad source coverage without paying to embed repetitive XBRL linkbases, signatures,
certifications, boilerplate, and thousands of near-identical ownership rows. It also preserves exact numbers
outside a probabilistic vector search.

Do **not** run the current recent-filings scheduler/admin path across 1,000 issuers merely because PR #1478
raised its caps. Those caps are useful circuit breakers, not a historical-ingestion architecture.

## Assumptions and non-goals

- “1,000 stocks” means a frozen snapshot of 1,000 US-listed operating issuers, keyed by CIK. Multiple share
  classes share one filing corpus but retain ticker aliases and effective dates.
- Owner holdings, watchlists, pending proposals, and frequent strategy candidates lead each breadth round.
- Remaining issuers rank by strategy relevance, 90-day dollar volume, and free-float market capitalization.
- ETFs, CEFs, preferreds, warrants, units, OTC securities, and shell/SPAC vehicles are excluded unless held or
  explicitly requested.
- Foreign private issuers are included when they are in the universe; their 20-F/40-F and 6-K families are
  mapped to annual/interim/current-report equivalents.
- The universe snapshot and selection reason are persisted. Historical evaluation must use the universe that
  existed at the evaluation date, not today's membership.
- This plan does not ingest unlicensed transcripts, estimates, research, or news. Those belong in separately
  licensed and labeled corpora.

## Current implementation: usable foundations and blocking gaps

The app already has Voyage `voyage-finance-2` document/query embeddings, Pinecone storage, tenant and as-of
metadata, reranking, a 10-K/10-Q body path, deterministic filing document IDs, daily budget fuses, demand-first
symbol ordering, and healthy production Pinecone/Voyage dependencies. These are useful foundations.

The following issues must be treated as work, not as assumptions that the current path already handles:

| ID | Priority | Finding | Consequence at 1,000 issuers |
|---|---:|---|---|
| RAG-B01 | P0 | `sec-filings.ts` reads only `filings.recent` and exact `10-K`/`10-Q`; it ignores SEC history shards, amendments, exhibits, and other form families. | Historical coverage is silently incomplete. |
| RAG-B02 | P0 | The 8-K source is a current 100-entry market feed with a four-day local window. Full bodies are default-off and the body path fetches the filing-detail page without resolving primary documents or exhibits. | It cannot perform a historical 8-K/exhibit backfill. |
| RAG-B03 | P0 | `document_chunks.content_hash` is a global primary key and hashes only normalized text. | Identical text in a second filing/issuer loses its own ticker, accession, and date; historical/as-of retrieval can lose the only eligible occurrence. |
| RAG-B04 | P0 | Regex HTML stripping destroys heading/table structure; the chunker only recognizes already-pipe-delimited tables. | SEC tables become ambiguous prose and citations cannot reliably address cells/sections. |
| RAG-B05 | P0 | Chunk “tokens” are whitespace words. Recognized tables are atomic and exempt from trimming. | Provider token/metadata limits are estimated incorrectly and large tables can exceed them. |
| RAG-B06 | P0 | `ingested_accessions` is only a coarse success ledger; it cannot represent artifacts, partial stages, parser/embed revisions, amendments, retries, or verification. The 8-K path can record success without proving vectors exist. | Jobs are not safely resumable or auditable. |
| RAG-B07 | P0 | Form 4 disclosure metadata can use `periodOfReport` as the retrieval timestamp; strict rejection of undated evidence is off by default. | Point-in-time evaluation can see information before it became public. |
| RAG-B08 | P1 | Discovery calls every supplied symbol before applying the document cap and queues up to 20 periodic filings for an early symbol before later issuers. | A capped 1,000-name run still makes roughly 1,000 metadata calls and starves the tail. |
| RAG-B09 | P1 | There is no durable raw-artifact store or canonical filing/document/section manifest. | Reparse/re-embed requires refetching SEC; coverage and lineage cannot be proven. |
| RAG-B10 | P1 | Company Facts is an optional one-ratio enrichment, not a persistent XBRL fact store. Form 4/13F/13D/G are not modeled as complete structured histories. | Exact numeric and ownership questions are forced into lossy text retrieval. |
| RAG-B11 | P1 | “Hybrid BM25” reranks only the dense candidate pool. | An exact accession, GAAP concept, product name, or phrase missing from dense top-K is unrecoverable. |
| RAG-B12 | P1 | Reranking requests only the final result count; strategy uses three final chunks and deduplicates after truncation. | Duplicate/boilerplate results cannot be backfilled from the wider ranked pool. |
| RAG-B13 | P1 | Strategy uses one generic query, retrieves shallowly for top candidates/holdings, and concatenates all symbols into one text blob. | A large corpus will add cost without reliably improving decisions. |
| RAG-B14 | P1 | The admin coverage view infers per-symbol counts from only the latest 200 accession rows; the offline coverage script lacks public/acceptance-date truth. | Operators cannot certify 1,000-stock completeness or freshness. |
| RAG-B15 | P1 | The golden retrieval suite uses hand-authored candidate pools and a mock lexical reranker. | Passing tests do not prove SEC discovery, parsing, embeddings, ANN recall, tables, or amendments. |
| RAG-B16 | P1 | Code, `.env.example`, comments, and operating docs disagree on daily text/WU limits and per-run filing limits. | Backfill cost and duration cannot be controlled from documented configuration. |
| RAG-B17 | P1 | SEC throttling is per loop, not aggregate across SEC consumers/processes; retry behavior is not a shared host-wide token bucket. | Concurrent 8-K, Form 4, XBRL, and filing workers can exceed aggregate fair-access limits. |
| RAG-B18 | P2 | Retrieval does not isolate incompatible embedding revisions, and the code requests `earnings-transcript` although no producer exists. | Corpus migrations can mix spaces; configuration claims coverage that cannot exist. |

Primary code evidence: `src/lib/web-sources/sec-filings.ts`, `src/lib/web-sources/sec8k.ts`,
`src/lib/web-sources/sec.ts`, `src/lib/web-sources/disclosure-rag.ts`, `src/lib/rag/chunk.ts`,
`src/lib/vector-db.ts`, `src/lib/db.ts`, `src/lib/strategy.ts`,
`app/api/admin/rag-coverage/route.ts`, and `scripts/eval/corpus-coverage.ts`.

## Target corpus architecture

### 1. Immutable raw-artifact layer

Store selected source artifacts once in R2/S3 using a content-addressed path such as:

```text
sec/{cik}/{accession}/{sequence}-{document_name}-{sha256}.{ext}
```

Retain the filing index/manifest, primary HTML/iXBRL document, complete-submission file when useful,
selected exhibits, MIME type, byte count, SHA-256, SEC URL, fetch time, and response metadata. Raw artifacts
are immutable; a corrected parser creates a new normalized generation instead of rewriting source truth.

### 2. Canonical relational manifest

Minimum entities:

- `issuers`, `securities`, `ticker_aliases`, and `universe_snapshots`;
- `filings` keyed by accession, with filer CIK, subject CIK, form/family, amendment parent, filed time,
  exact accepted time, report period, fiscal year/period, and supersession state;
- `filing_documents` keyed by accession plus sequence/document name, with exhibit type and raw-object URI;
- `sections` and `tables` with normalized Item/Part, hierarchy, source locators, hashes, and parser revision;
- `chunk_occurrences` with stable neighbors/parents and evidence identity;
- `content_objects` or an embedding cache keyed by normalized text hash plus model/revision;
- `facts` and `events` for XBRL, insider, ownership, financing, and filing metadata;
- `ingest_jobs`/`ingest_tasks` with state, lease, attempts, retry time, errors, observed cost, and checksums.

Identity rules:

```text
filing_id          = accession
artifact_id        = accession:sequence:document_name
chunk_occurrence   = accession:artifact:section:ordinal:parser_rev
embedding_cache    = normalized_text_hash:embed_model:embed_rev
vector_id          = corpus_rev:chunk_occurrence:embed_rev
```

`content_hash` may prevent duplicate **embedding computation**, but it must never erase a second evidence
occurrence. Every filing occurrence keeps independent symbol/date/accession metadata.

### 3. Structured facts and events

Do not embed raw XBRL JSON/XML, Form 4 XML, or 13F rows. Persist normalized records with source accession,
accepted time, period, units/dimensions, amendments, and source location. Render compact, cited evidence cards
only when a query or strategy run needs them.

Use this path for:

- SEC Company Facts and filing-level XBRL facts;
- Forms 3/4/5 and Form 144 transactions;
- Schedules 13D/G positions and amendments;
- 13F issuer-level manager/position deltas from SEC structured datasets;
- offering terms, share issuance, debt/covenants, and other fields that can be normalized reliably.

### 4. Narrative and table search indexes

- Dense semantic index: keep `voyage-finance-2` initially, 1,024-dimensional cosine.
- True corpus-wide lexical index: FTS/BM25 or a managed sparse index, not BM25 over the dense shortlist.
- One shared SEC corpus generation is the default for cross-issuer research. During the pilot, benchmark a
  shared namespace against a modest deterministic CIK-hash sharding scheme; do not create 1,000 ticker
  namespaces without measured RU savings and an explicit cross-issuer fan-out design.
- Keep public SEC evidence separate from private user decision memory. Query them in parallel when needed.
- A model/dimension/metric change gets a new index. Parser/chunker-only changes in the same vector space may
  use a shadow namespace/generation.

### 5. Derived evidence

Derived section summaries, filing briefs, KPI snapshots, and filing-to-filing deltas are optional acceleration
layers. Every derived item stores its model, prompt revision, generation time, source chunk IDs, and as-of time.
The LLM must be able to fall through to primary evidence; derived text never becomes the only citation.

## What to retain, structure, embed, and skip

| Priority | Source family | Primary handling | Highest-yield content |
|---|---|---|---|
| A0 | XBRL Company Facts/financial statements | Structured facts; source artifacts archived | Five annual periods, 12 quarters, dimensions, units, amendments, source accession |
| A1 | 8-K Item 2.02 + EX-99.1/99.2 | Embed selected primary/exhibits; extract facts/events | Earnings release, guidance, segment/KPI tables, presentation |
| A1 | Latest 10-Q | Section/table embeddings + facts | Part I 1/2/3/4; Part II 1/1A/2/5; footnote/MD&A changes |
| A1 | Latest 10-K / 20-F / 40-F | Section/table embeddings + facts | Items 1, 1A, 3, 7, 7A, 8/notes, 9A and foreign equivalents |
| A1 | Other material 8-K/6-K | Event record + selected narrative/exhibits | 1.01/1.02/1.03/1.05; 2.01-2.06; 3.01-3.03; 4.01/4.02; 5.01/5.02; material 7.01/8.01 |
| A2 | DEF 14A | Section/table embeddings + structured fields | Ownership, incentives, governance, related parties, proposals, pay-versus-performance |
| A2 | 13D/A, 13G/A | Structured ownership + selected narrative | Position changes, Item 4 purpose/plans, contracts/exhibits |
| A2 | Forms 3/4/5 and 144 | Structured events; compact cited aggregates | Transaction code, price/shares, ownership, role, 10b5-1, post-transaction holdings |
| A2 | S-1/F-1, S-3/F-3, 424B | Event-driven narrative + structured terms | Capitalization, dilution, proceeds, selling holders, final debt/equity terms |
| A2 | S-4, DEFM14A, SC TO, SC 14D-9 | Event-driven narrative + structured terms | Deal terms, financing, background, fairness, conditions, termination rights |
| A2 | Selected EX-10 | Embed only when newly material | Credit agreements, covenants, economics, termination/change-of-control |
| B | 13F | SEC structured dataset + issuer/manager deltas | Lagged positioning context; never treat as current holdings truth |
| C | Long-tail/routine forms | Catalog/archive; lazy parse/embed | Only on query, holding, watchlist, or detected event demand |

For 8-K, Item 9.01 is an exhibit index, not useful standalone evidence. Also retain cyber incidents (1.05),
new debt (2.03), defaults (2.04), restructuring (2.05), impairments (2.06), delisting (3.01), and dilution
(3.02); the current allowlist misses several of these high-signal events.

Do not embed by default:

- EX-31/32 certifications, EX-101 linkbases, signatures, consents, graphics, and duplicate annual-report PDFs;
- cover pages, table-of-contents duplicates, page furniture, and generic safe-harbor boilerplate;
- raw XBRL JSON/XML, Form 4 XML, 13F XML, or repetitive transaction rows;
- routine S-8s and 9.01-only shells;
- duplicate IR and SEC copies when hashes prove they are identical;
- older unchanged boilerplate unless the request is historical or the text changed materially.

## Parsing and chunking specification

1. Resolve each accession through its filing index/`index.json`; enumerate primary and exhibit documents.
2. Parse HTML/iXBRL with a DOM parser. Remove scripts, hidden inline-XBRL noise, empty layout cells, repeated
   headers/footers, and TOC duplicates while preserving headings, lists, paragraphs, captions, footnotes,
   anchors, and table coordinates.
3. Normalize sections to stable SEC Item/Part codes. Keep original headings and a source locator.
4. Reconstruct tables as cells plus a compact textual render. Split large tables into row groups without
   splitting a row; repeat caption, headers, units, periods, and required footnotes in every group.
5. Use the provider tokenizer, not whitespace counts:
   - prose child: 350-550 tokens;
   - overlap: 50-80 tokens, only within the same section;
   - table child: 150-400 tokens;
   - parent section/window: 1,000-1,800 tokens;
   - section summary: 150-300 tokens;
   - filing brief: 400-700 tokens;
   - filing-to-filing change summary: 300-800 tokens.
6. Embed concise deterministic context with each child: issuer, form, report period, Item/section, exhibit,
   and table caption. Keep source text and citations unchanged.
7. Store `cik`, ticker aliases, accession, form/family, accepted epoch, filed time, report period, FY/FP,
   amendment/supersession state, Item/section, artifact/exhibit, parent/neighbor IDs, chunk kind, content hash,
   parser/chunker/embed revisions, language, importance, primary/derived, and source URL.

Generate filing-to-filing section deltas after the complete latest baseline exists. Changed MD&A, risk,
footnote, proxy, and covenant passages should receive a retrieval prior; unchanged history remains available.

## Retrieval optimized for LLM use

### Intent routing

1. Resolve the requested issuer to canonical CIK and aliases.
2. Classify the query as exact fact, semantic narrative, change-over-time, event, ownership/financing, or
   historical-as-of.
3. Route exact numeric/transaction questions to structured facts/events first.
4. Route narrative questions to dense plus lexical retrieval; join structured facts when the answer mixes
   numbers and explanation.
5. Enforce `accepted_at <= asOf` at the source/manifest and index-filter layers. Unknown dates fail closed for
   historical evaluation.

### Candidate and context pipeline

Starting values to validate on the real golden set:

1. Build 2-4 deterministic facets when useful: earnings/guidance, liquidity/debt, risk/legal/cyber,
   capital allocation/dilution, and governance/ownership. Do not use HyDE for exact-number/accession queries.
2. Retrieve 60-100 dense and 60-100 lexical candidates per facet.
3. Fuse by reciprocal rank into 100-200 unique occurrence IDs.
4. Rerank 40-100 candidates, not only final K.
5. Apply semantic MMR (`lambda` 0.65-0.80), hard duplicate suppression, and caps such as two chunks per
   section and three per filing for broad questions.
6. Return 8-12 evidence chunks; normally pack the best 4-8 plus relevant parent windows/summaries inside a
   6,000-12,000-token global evidence budget.
7. Preserve counterevidence: reserve 15-25% of evidence slots for relevant contradictory/negative material.
8. Return typed evidence packets with `chunk_occurrence_id`, source URL, accepted time, section, and fact IDs.

For strategy runs, use two stages:

- **Scout:** up to 30 symbols with approximately 100-150 evidence tokens per symbol.
- **Deep:** 1-3 finalists plus held positions, with 1,500-2,500 RAG tokens per symbol.

Require material proposal/rationale claims to return `evidenceRefs`. Verify that cited IDs were retrieved,
numbers exist in cited facts/text, and no source is newer than the run's as-of time. Replace the current generic
three-chunk/cross-symbol blob with compact per-symbol issuer dossiers and task-specific deep retrieval.

## Highest-yield 1,000-stock backfill

### Frozen universe

Create and review one manifest containing CIK, tickers/aliases, exchange, security type, sector/industry,
market cap, dollar volume, held/watchlist/candidate flags, inclusion reason, and effective date. Resolve dual
classes to one issuer corpus but keep every ticker alias. Quarantine unresolved/ambiguous mappings; do not
silently drop them.

### Breadth-first rounds within every tranche

For each tranche, complete one round for every issuer before deepening an early issuer:

1. latest annual (10-K/20-F/40-F);
2. latest quarter/interim (10-Q/material 6-K equivalent);
3. most recent earnings 8-K/6-K plus EX-99.1/99.2;
4. other two current-cycle quarters;
5. trailing 12 months of selected material 8-K/6-K plus exhibits;
6. latest DEF 14A;
7. structured Company Facts, ownership, insider, offering, and filing-event records;
8. deeper history only after the 1,000-issuer current baseline passes coverage and retrieval gates.

### Execution waves

| Wave | Universe and scope | Purpose | Planning volume |
|---|---|---|---:|
| 0A | 10 deliberately difficult issuers, up to five years | Parser/table/amendment/exhibit canary; no cutover | 3k-15k vectors |
| 0B | 25 sector/cap/form-stratified issuers | 200-300 human-labeled queries; throughput/cost census | 10k-30k vectors |
| 1 | All 1,000: bulk filing manifest + five annual/12 quarterly XBRL periods | Complete structured breadth before narrative spend | No raw-JSON vectors |
| 2A | Priority 100: latest annual, three quarters, 12-month material events | Owner/strategy relevance first | 25k-120k vectors |
| 2B | Next 200, same current baseline | Validate scale and sector variance | cumulative 120k-350k |
| 2C | Remaining 700, same current baseline | Complete 1,000-issuer breadth | cumulative 600k-1.2m |
| 3 | All 1,000: latest proxy, selected offerings/ownership, eight earnings exhibits where available | Add governance, dilution, and operating history | +250k-700k |
| 4 | Highest-value 100-250: two prior annuals, eight total quarters, three years of material events/proxies | Selective depth after measured lift | total 1.1m-2.5m typical |
| 5 | Long-tail forms and older history | Lazy/on-demand or evidence-triggered | Only if ablation proves lift |

The first production-worthy target is Wave 2C: every issuer has current annual/quarterly/event coverage. Do
not spend the first days putting ten annual reports into the first ticker while ticker 1,000 has none.

### Discovery and pacing

- Use SEC nightly `submissions.zip` and `companyfacts.zip` to build manifests efficiently, then per-filer APIs,
  current feeds, daily/master indexes, and nightly reconciliation for deltas. SEC documents these ZIPs as the
  most efficient bulk path and notes that older submission history is referenced outside `filings.recent`.
  [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- Use master/dataset sources for forms filed by a third-party CIK about the issuer, including ownership forms;
  issuer submissions alone are insufficient.
- Use one host-wide SEC limiter for all consumers. Start at 3-5 requests/second with a real application/contact
  User-Agent, honor `Retry-After`, exponential backoff with jitter, circuit breaking, and immutable-object
  caching. SEC's published maximum is 10 requests/second across machines.
  [SEC fair access](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
- Start Voyage with token-aware batches of 32-64 items, then benchmark 64-128 while staying under request-token
  limits. Keep live-query capacity separate and retry 429s with jitter. Voyage documents up to 1,000 texts and
  120,000 total tokens per request for `voyage-finance-2`.
  [Voyage embeddings](https://docs.voyageai.com/docs/embeddings)
- Upsert 100-200 Pinecone records per request after measuring payload sizes. For a shadow generation above
  roughly one million vectors, benchmark Parquet bulk import against online upsert.
  [Pinecone bulk import](https://docs.pinecone.io/guides/data/import-data)

## Durable worker and state machine

Run the backfill in a dedicated worker process with a database-backed queue and bounded tranches. Do not depend
on a long-lived admin HTTP request, detached scheduler promise, or process uptime.

```text
discovered
  -> fetched
  -> validated
  -> parsed
  -> facts_extracted
  -> chunked
  -> embed_queued
  -> embedded
  -> index_queued
  -> indexed
  -> verified
  -> complete
```

Every state transition is transactional and idempotent. Additional terminal/holding states:
`failed_retryable`, `failed_terminal`, `quarantined`, and `superseded`.

Record expected and actual bytes, tokens, chunks, vectors, WU, and dollars; attempt count; next retry; typed
error; lease owner/heartbeat; raw/normalized hashes; parser/chunker/embed revisions; index/namespace/vector IDs;
and verification receipts. A failed document never blocks later issuers.

Retry policy:

- SEC 429: honor `Retry-After`, pause the shared limiter, then exponential jittered retry.
- Network/5xx: up to six bounded attempts.
- Voyage/Pinecone 429: token-bucket throttling plus up to eight bounded attempts.
- Permanent 4xx/config failure: stop the job, not merely the document.
- Parse/metadata-limit failure: quarantine with the raw source and exact exception.

## Scale, time, and cost envelope

These are planning ranges, not quotas. The 25-issuer pilot must replace them with measured distributions.
Assumptions: 350-550-token children plus compact context, roughly 450-700 billable tokens/vector, and roughly
6-10 KB/vector including index overhead.

| Corpus | Vectors | Embed tokens | Gross Voyage finance-2 | Pinecone footprint | Online upsert WU cost |
|---|---:|---:|---:|---:|---:|
| 25-issuer pilot | 10k-30k | 5m-20m | under $3 | under 0.3 GB | negligible |
| 1,000-issuer current/high-yield baseline | 600k-1.2m | 270m-840m | $32-$101 | 4-12 GB | approximately $15-$55 |
| Baseline + selective three-year depth | 1.1m-2.5m typical | 0.54b-1.75b | $65-$210 | 7-25 GB | approximately $25-$115 |
| Broad upper-bound program | up to 4.2m | up to 2.97b | up to $356 | up to 42 GB | up to approximately $190 |

Voyage currently lists `voyage-finance-2` at $0.12/million tokens with the first 50 million account tokens
free; summary-generation LLM cost is separate. Its Batch API discount does not currently list
`voyage-finance-2`, so do not assume a discount without a benchmarked model migration.
[Voyage pricing](https://docs.voyageai.com/docs/pricing)

Pinecone currently lists Standard storage around $0.33/GB-month, writes around $4-$4.50/million WU, and a
$50/month Standard minimum. WU has per-request overhead, which is why larger safe batches/bulk import matter.
[Pinecone pricing](https://www.pinecone.io/pricing/),
[Pinecone cost model](https://docs.pinecone.io/guides/manage-cost/understanding-cost)

At a conservative 100,000 successfully verified chunks/day, the 1,000-issuer current baseline is about 6-12
backfill days after the worker/parser exists. The current synchronous single-worker path has a much wider
planning range (roughly 5,000-30,000 vectors/hour before provider and daily fuses) and should not be used as the
schedule commitment.

Raw/normalized artifacts should remain in cheap object storage. At Cloudflare R2's current $0.015/GB-month,
50-500 GB is roughly $0.75-$7.50/month before free allowance and operations.
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### Budget breakers

Start with:

- 20,000 vectors, 12 million embed tokens, 150,000 estimated WU, 2 GB download, $5 gross embedding ceiling;
- then 120,000 vectors, 80 million tokens, 1.2 million WU, and $15 Voyage ceiling for the 100-stock stage;
- reserve at least 20% provider capacity for live ingestion/retrieval;
- stop when projected spend exceeds approval by 10%, 429 rate exceeds 1%, permanent failure exceeds 0.5%,
  or observed vector/table expansion exceeds the approved pilot distribution.

Before any run, reconcile code/docs/runtime and explicitly pin all caps. Do not infer “paid mode” indirectly
from an embedding delay.

## Evaluation and cutover gates

Build a 250-500-query real-EDGAR golden set spanning at least 30-100 issuers, all target form families,
sectors/cap sizes, exact numbers, tables, changes, amendments, current events, no-answer cases, ticker changes,
dual-class issuers, malformed iXBRL, oversized tables, boilerplate, and historical-as-of queries.

Minimum launch gates:

| Dimension | Gate |
|---|---|
| Universe | 1,000/1,000 rows; at least 99% CIK resolution; 100% alias retention or explicit quarantine |
| Discovery | At least 98% target slots discovered; at least 99% latest periodic filings available where obligated |
| Provenance | 100% indexed documents have accession, exact accepted time, SEC URL, raw hash, parser and embed revision |
| Parsing | At least 99% selected documents parse after reviewed exclusions; section F1 at least 0.95; table header/unit retention at least 0.99 |
| Facts | Numeric exact match at least 0.99 through the structured path |
| Retrieval | Raw recall@50 at least 0.95; nDCG@10 at least 0.85; MRR@10 at least 0.80-0.85 |
| Grounding | Claim-level citation support at least 0.95; citation-to-source correctness at least 0.99 |
| PIT | Zero future-document leaks; amendments and supersession correct in every fixture |
| Diversity | Duplicate context below 10-15%; broad answers include distinct filings/sections where appropriate |
| Integrity | Manifest-to-index count within 1%; zero orphan vectors or false-complete ledgers |
| Replay | Unchanged rerun performs zero raw refetches/re-embeddings and creates zero new occurrence IDs |
| Operations | 429 rate below 1%; permanent failure below 0.5%; at least 99% completion after retry |
| Runtime | No measurable scheduler/trading-loop latency regression |

The existing synthetic/mocked retrieval suite remains a regression smoke test; it is not this gate.

Use a new `sec-v2` shadow corpus. Dual-write new filings while backfilling, dual-read old/new for evaluation,
then switch a versioned configuration pointer only after the gates pass. Roll back by restoring the old read
pointer. Do not delete either corpus or the raw archive during the observation window, and never mix embedding
revisions in one retrieval.

## Implementation train and dependencies

| Package | Scope | Blocks |
|---|---|---|
| P0 — Truth and census | Reconcile runtime/config docs; authenticated corpus census; 1,000-CIK universe; correct coverage dimensions | Every bulk run |
| P1 — Identity and manifest | Filing/artifact/section/job schema; exact timestamps; amendments; occurrence IDs; split embedding-cache dedup from evidence identity | Parsing/indexing |
| P2 — Discovery and archive | Bulk submissions/companyfacts; history shards; filing index/exhibit resolution; R2; aggregate SEC limiter/cache | Backfill worker |
| P3 — Parser/chunker | DOM/iXBRL parser, SEC Items, table reconstruction, tokenizer-aware chunks, source anchors, versioning | Real eval and vectors |
| P4 — Structured facts/events | XBRL, insider, ownership, offering/event normalization and cited evidence cards | Numeric/ownership routing |
| P5 — Worker and shadow index | Durable queue/state machine, leases/retries/DLQ, token-aware Voyage batches, Pinecone import/upsert, reconciliation | Pilot/backfill |
| P6 — Retrieval/consumption | True lexical recall, wide rerank, MMR/diversity, intent router, issuer dossiers, evidenceRefs, strict PIT | Cutover |
| P7 — Real evaluation | 250-500 labeled questions, parser/fact/retrieval/grounding/temporal metrics, old-vs-new ablations | 100/300/1,000 expansion |
| P8 — Controlled backfill | 10 -> 25 -> 100 -> 300 -> 1,000 waves with breaker receipts and daily reconciliation | Production corpus |
| P9 — Freshness operations | Current-feed deltas, nightly reconciliation, dual-write/cutover/rollback, coverage/cost dashboard | Durable operation |

P0 and the read-only portions of P7 can begin in parallel. P1 must land before any mass re-embed. P2 and P3
can then proceed in parallel against frozen raw canary fixtures. P4 and P6 can proceed after their schemas are
stable. P8 never begins until the relevant P7 gate passes.

### Indicative execution calendar after ownership is assigned

- Days 1-2: runtime/config reconciliation, production corpus census, frozen universe, 10-issuer raw canary.
- Days 3-7: manifest/dedup migration, raw archive, global limiter, deterministic DOM/iXBRL parser fixtures.
- Days 8-10: chunk/table benchmark, structured-fact baseline, shadow index and worker dry run.
- Days 11-14: 25-issuer labeled pilot; tune chunking, namespace layout, batches, and breaker thresholds.
- Days 15-18: priority 100 backfill plus old/new shadow evaluation.
- Days 19-22: expand to 300 if gates hold.
- Days 23-34: complete the 1,000-issuer current baseline at about 100k verified chunks/day.
- Following weeks: selective history/proxy/offering depth only where ablation shows incremental retrieval or
  decision value.

This calendar is conditional on implementation and pilot throughput; it is not a promise to run unreviewed
production writes.

## Freshness after backfill

- Material 8-K/6-K and selected exhibits: p95 indexed within 15 minutes.
- 10-K/10-Q/20-F/40-F: p95 within one hour, hard ceiling four hours.
- XBRL facts: within one hour.
- Proxy, ownership, and registration documents: daily unless event-triggered.
- Nightly bulk-submission/master-index reconciliation; weekly missing-document/citation audit.
- Reparse only when raw content or parser revision changes; re-embed only when normalized content or embedding
  revision changes.

## Immediate next actions

1. Treat RAG-B03 (occurrence/provenance dedup), RAG-B06 (manifest/state), RAG-B04/B05 (parser/tables/tokens),
   and RAG-B07 (point-in-time truth) as bulk-backfill blockers.
2. Run an authenticated production census: namespaces/index stats, vectors by doc type/issuer/year/revision,
   accession/manifest parity, date completeness, and actual provider quotas.
3. Freeze the 1,000-CIK universe and a 10/25-issuer canary set.
4. Reconcile the code/docs/runtime limit drift and set explicit breaker values.
5. Implement P1-P3 before increasing ingestion breadth; keep the existing corpus readable.
6. Build the real EDGAR eval set before selecting chunk sizes, namespace layout, or a new embedding model.
7. Only then approve the 100 -> 300 -> 1,000 shadow backfill.

## Official references

- [SEC EDGAR APIs and bulk archives](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC fair-access guidance](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
- [Official Form 8-K and Item taxonomy](https://www.sec.gov/files/form8-k.pdf)
- [SEC Form 13F structured datasets](https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets)
- [Voyage embeddings](https://docs.voyageai.com/docs/embeddings)
- [Voyage pricing](https://docs.voyageai.com/docs/pricing)
- [Voyage rate limits](https://docs.voyageai.com/docs/rate-limits)
- [Pinecone cost model](https://docs.pinecone.io/guides/manage-cost/understanding-cost)
- [Pinecone bulk import](https://docs.pinecone.io/guides/data/import-data)
