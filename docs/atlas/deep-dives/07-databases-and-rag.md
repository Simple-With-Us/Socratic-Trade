# Deep Dive 7 — Databases & Retrieval (RAG)

> Expert panel deep-dive expanding §7 of the [Multi-Expert App Analysis](../multi-expert-app-analysis.md). Target product: an AI-powered trading/financial-assistant doing RAG over filings/news/transcripts plus time-series market data. Tentative stack: **Postgres + pgvector + TimescaleDB**, graduating to Qdrant/ClickHouse only when measured metrics demand. Each subsection is ordered high→low impact.

---

#### 7.1 Vector Store & ANN Indexing

The working bet is correct: **Postgres + pgvector + TimescaleDB carries this workload further than most teams expect**, and keeping vectors, metadata, and time-series in one transactional store eliminates a whole class of consistency and join problems (e.g. "give me the 10 most relevant 10-K chunks for AAPL filed before this earnings date, joined to the price reaction"). Graduate to a dedicated engine only when a measured metric — not a vibe — forces it.

##### 7.1.1 pgvector in production: index choice, tuning, and the recall/latency curve (highest impact)

**HNSW vs IVFFlat.** For a RAG corpus that grows incrementally (new filings/news/transcripts daily), default to **HNSW**. It gives better recall at a given latency, degrades gracefully, and — critically — does not need a representative sample to build (IVFFlat's `lists` centroids are only as good as the data present at build time, so an IVF index built early and grown 50x silently loses recall). IVFFlat's only real wins are *faster build* and *lower memory*, which matter for huge static batches.

| | HNSW | IVFFlat |
|---|---|---|
| Recall @ fixed latency | Higher | Lower |
| Build time | Slow (minutes–hours) | Fast |
| Memory | High (graph in RAM) | Lower |
| Incremental inserts | Good (no recentering) | Degrades; needs periodic `REINDEX` |
| Best for | Growing RAG corpus | Large static batch, RAM-constrained |

**HNSW tuning.**
- `m` (default 16): neighbors per node. 16 is fine for ≤768-dim; raise to 24–32 for 1536-dim or high-recall needs. Higher `m` = better recall, more memory, slower build.
- `ef_construction` (default 64): build-time candidate list. Raise to 128–256 for better graph quality; the cost is build time, not query time. Treat 200 as a strong production default.
- `ef_search` (default 40): the **per-query** recall/latency knob — the one you tune live. Set per-session, not at index time.

```sql
-- 1536-dim embeddings, cosine distance
CREATE INDEX ON doc_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 200);

-- tune recall vs latency at query time (session-scoped)
SET hnsw.ef_search = 100;   -- raise for recall, lower for latency
SELECT id, ticker, chunk
FROM doc_chunks
WHERE ticker = 'AAPL' AND filed_at < '2026-01-30'
ORDER BY embedding <=> :query_vec
LIMIT 10;
```

> Match the operator class to your metric. Cosine (`vector_cosine_ops`, `<=>`) for normalized text embeddings; L2 (`vector_l2_ops`, `<->`) or inner product (`vector_ip_ops`, `<#>`) only if your model demands it. Mismatched ops class = silently wrong results, not an error.

**Memory footprint.** Raw storage ≈ `rows × dim × 4 bytes` for `vector` (fp32). The HNSW graph adds roughly `rows × m × 2 × ~8 bytes` of links on top. At **5M chunks × 1536-dim**: raw vectors ≈ 30 GB, plus several GB of graph. For HNSW to be fast, the index must live in RAM/`shared_buffers`/page cache — if it spills to disk, p99 collapses. This RAM ceiling, not row count, is usually the real pgvector limit.

**Quantization — the highest-leverage lever once RAM bites:**
- **`halfvec` (fp16):** halves storage and graph RAM with near-zero recall loss for most models. Almost always worth it at scale.
  ```sql
  ALTER TABLE doc_chunks ADD COLUMN embedding_h halfvec(1536);
  UPDATE doc_chunks SET embedding_h = embedding::halfvec;
  CREATE INDEX ON doc_chunks USING hnsw (embedding_h halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 200);
  ```
- **Binary / scalar quantization + rerank:** index a compact form for a cheap, wide first pass, then **rerank the top candidates against full-precision vectors**.
  ```sql
  WITH candidates AS (   -- cheap, wide ANN pass on quantized index
    SELECT id, embedding
    FROM doc_chunks
    WHERE ticker = 'AAPL'
    ORDER BY binary_quantize(embedding)::bit(1536) <~> binary_quantize(:q)::bit(1536)
    LIMIT 200
  )
  SELECT id                       -- exact rerank on full-precision vectors
  FROM candidates
  ORDER BY embedding <=> :q
  LIMIT 10;
  ```
  Binary quantization can cut vector RAM ~32x; pair it with a wide `LIMIT` and full-precision rerank to recover recall. Financial text is precision-sensitive, so **always validate recall@k after enabling any quantization**.

**The recall-vs-latency curve, and how to benchmark it.** Recall is *not* observable in production without ground truth, so build it explicitly:
1. **Ground truth = brute force.** For ~1–5k held-out query vectors, compute exact top-k with the ANN index disabled (`SET enable_indexscan = off;`). This is the recall@k denominator.
2. **Sweep `ef_search`** (e.g. 40 → 400); for each, measure recall@k (overlap with ground truth) and p50/p95/p99 latency.
3. **Pick the knee** — the lowest `ef_search` that clears your recall SLA (e.g. recall@10 ≥ 0.95). Re-run whenever the corpus grows materially or embeddings change.

```sql
-- recall@10 for one query: |ANN ∩ exact| / 10, aggregated across the eval set
WITH ann  AS (SELECT id FROM doc_chunks ORDER BY embedding <=> :q LIMIT 10),
     gt   AS (SELECT id FROM doc_chunks_exact_topk WHERE query_id = :qid)
SELECT count(*) FILTER (WHERE ann.id IN (SELECT id FROM gt))::float / 10 AS recall_at_10
FROM ann;
```

##### 7.1.2 Partitioning, partial/composite indexes, and keeping ANN on hot subsets

Most queries here are **filtered ANN** — scoped by `ticker`, `doc_type`, and a date window. A highly selective filter over a large HNSW index can over-fetch (fill `ef_search` with rows that fail the filter) or fall back to a slow exact scan. The fix is to make the **hot subset physically smaller**.

- **Partition the table** so the planner prunes before ANN runs.
  - **By time** (TimescaleDB hypertables / range partitioning on `filed_at`): RAG relevance is recency-weighted, so most queries touch the last few quarters. Old partitions stay on disk; hot partitions stay in RAM.
  - **By tenant** (`org_id`/`portfolio_id`) if multi-tenant: hard isolation + index only active tenants. **Never let one tenant's query traverse another's vectors.**
  - Each partition gets **its own HNSW index** — smaller graphs build faster, fit RAM, and `REINDEX` per-partition without locking the world.

```sql
CREATE TABLE doc_chunks (
  id bigint, org_id int, ticker text, doc_type text,
  filed_at timestamptz, embedding halfvec(1536), chunk text
) PARTITION BY RANGE (filed_at);

CREATE TABLE doc_chunks_2026q1 PARTITION OF doc_chunks
  FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE INDEX ON doc_chunks_2026q1 USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 32, ef_construction = 200);
```

- **Composite B-tree indexes on hot metadata** (`(org_id, ticker, doc_type, filed_at)`).
- **Partial HNSW indexes for hot subsets** — index only recent + high-value doc types:
  ```sql
  CREATE INDEX ON doc_chunks USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 32, ef_construction = 200)
    WHERE doc_type IN ('10-K','10-Q','8-K') AND filed_at > '2025-01-01';
  ```
- **`EXPLAIN (ANALYZE, BUFFERS)`** every hot query: confirm partition pruning fired, the HNSW index is used (not a fallback seq scan), and shared-buffer hits dominate.

##### 7.1.3 Concrete scale thresholds and the migration plan

How far pgvector realistically goes (order-of-magnitude; verify against *your* recall SLA, dims, and filter selectivity):

| Corpus size | Reality with HNSW + halfvec + partitioning |
|---|---|
| **< 1M vectors** | Trivial. Sub-10 ms ANN, no special effort. |
| **1M – 10M** | Comfortable. p95 single-digit to low-tens ms. The sweet spot — **do not migrate**. |
| **10M – 50M** | Workable but you're engineering: RAM sizing, partitioning, quantization, read replicas all mandatory. |
| **50M – 100M+** | Possible but fighting the tool — build times, RAM cost, tail latency get painful. **Justified migration zone.** |

**Triggers that justify moving** (any one sustained): p99 ANN latency misses SLA *after* quantization/partitioning/RAM sizing; the hot index no longer fits economically in RAM; sustained QPS needs horizontal sharding read replicas can't satisfy; HNSW build/`REINDEX` per-partition exceeds your maintenance window; you need native features pgvector lacks (multi-vector, first-class filtered-HNSW, built-in sharding).

**Migration plan — shadow index, dual-write, no mixed vector spaces:**
1. **Freeze the embedding space.** Never compare vectors from different models/dimensions/normalizations. Pin model + version + normalization on every vector.
2. **Dual-write** every new/updated chunk to both Postgres and the new store (outbox/CDC). Backfill history using the *same* embeddings already stored.
3. **Shadow reads** — route a copy of production queries to the new store, compare top-k against Postgres ground truth, track recall@k + latency deltas. No user traffic yet.
4. **Canary cutover** 1% → 10% → 100% behind a flag, watching recall drift and p99. Postgres stays authoritative and dual-written.
5. **Rollback = flip the flag** (instant and lossless, because Postgres stays dual-written).

##### 7.1.4 If/when you move: dedicated engine comparison

| | **Qdrant** | **Milvus** | **Weaviate** | **Pinecone** |
|---|---|---|---|---|
| Model | OSS, self-host or cloud | OSS, heavy/distributed | OSS, self-host or cloud | Fully managed only |
| Sweet spot | **Best default exit from pgvector** — fast filtered HNSW, simple ops | Billion-scale, GPU build, big infra team | Hybrid search + built-in modules/rerank | Zero-ops, pay to not think about it |
| Ops burden | Low–moderate | **High** | Moderate | **None** (lock-in, $$, egress) |
| Best for this app | **Top pick** if self-hosting | Only at true billion-vector scale | If you want hybrid/rerank out of the box | If team has no infra appetite |

**Recommendation:** if a metric forces the move, **Qdrant** is the most natural graduation. Reach for **Milvus** only at genuine billion-vector scale; **Pinecone** if you'd rather eliminate ops and accept lock-in; **Weaviate** if built-in hybrid + reranking saves real code. Keep authoritative metadata and time-series in Postgres/Timescale regardless.

##### 7.1.5 Operational concerns

- **Index build time & write amplification.** Heavy ingest competes with query latency. Bulk-load into a partition with the index dropped, then build once; raise `maintenance_work_mem` and `max_parallel_maintenance_workers`; ingest into a staging partition and attach.
  ```sql
  SET maintenance_work_mem = '8GB';
  SET max_parallel_maintenance_workers = 4;
  ```
- **Vacuum & bloat.** Updating/deleting vectors leaves dead tuples; churn-heavy tables bloat and lose recall/speed. Tune autovacuum aggressively on hot vector tables; `REINDEX CONCURRENTLY` per partition on a schedule. Append-mostly historical partitions barely bloat.
- **When to rebuild.** When recall@k drifts below SLA; after large deletes/updates; when you change `m`/`ef_construction`; when you migrate to `halfvec`/quantized columns.
- **Backups.** Prefer physical/PITR backups (pgBackRest, WAL archiving); consider excluding ANN indexes from logical dumps and rebuilding on restore (budget restore-time index build into RTO).
- **Monitoring:** recall drift (run the brute-force eval on a schedule + after large ingest/REINDEX); latency p95/p99 per query class; index/buffer health (`pg_stat_user_indexes`, cache hit ratio, partition sizes, autovacuum lag, dead-tuple counts); keep `ef_search` a runtime setting.

> **Bottom line:** pgvector + Timescale is the right call now and likely through ~10M+ chunks. Disciplined wins, in order: tuned HNSW `ef_search`; time/tenant partitioning with partial indexes on hot subsets; `halfvec` then quantization+rerank when RAM bites; and a continuous brute-force recall eval so you *know* when you've hit the wall.

---

#### 7.2 Financial Document Processing & Chunking

Financial documents are semi-structured legal/accounting artifacts where a single number, footnote, or date can flip the meaning. The goal of this stage is retrieval units that are *self-contained*, *structurally faithful*, and *point-in-time correct*.

##### 7.2.1 Parsing the messy reality (highest leverage — garbage in, garbage out)

A single generic text extractor will destroy the structure you most need. Use a dedicated parser per source family:

- **HTML / XBRL filings (10-K, 10-Q, 8-K).** Parse HTML for human-readable structure (Item headings, tables) *and* harvest XBRL facts for machine-precise numbers. The company-facts API gives `(concept, value, unit, decimals, contextRef → period)` tuples — keep these as a parallel structured layer so a chunk can be reconciled to an exact tagged fact (e.g. `us-gaap:Revenues = 81,797,000,000` for `FY2024`). Strip boilerplate (exhibit indices, viewer scripts, page furniture) but **never** strip table headers, column scope, or unit footers ("in millions, except per-share data").
- **PDF tables (research notes, scanned filings, IR decks).** Use a layout-aware extractor; detect table bounding boxes first, extract as structured grids, serialize to Markdown/HTML so rows/headers stay aligned. OCR only the raster regions you must.
- **Transcripts (earnings calls).** Segment by **speaker turn**. Preserve `speaker`, `role` (CEO/CFO/Analyst), `affiliation`, and `section` (Prepared Remarks vs Q&A). In Q&A, link each answer to its question.

The non-negotiable rule: **a financial table is one atomic unit.** Never split it from its header, caption, or units/scale footnote. If too large, repeat the header + units on each sub-chunk under a shared `table_id`.

```python
def parse_table_block(tbl, parent_meta):
    header = tbl.header_rows           # keep verbatim
    units  = tbl.scale_note or detect_scale(tbl)   # "in millions"
    md = to_markdown(tbl)              # rows stay column-aligned
    for shard in split_rows_keeping_header(md, header, units, max_tokens=900):
        yield Chunk(text=f"{tbl.caption}\n[{units}]\n{shard}",
                    meta={**parent_meta, "is_table": True,
                          "table_id": tbl.id, "units": units})
```

##### 7.2.2 Structure-aware chunking (vs naive fixed-size)

Naive fixed-size splitting cuts mid-sentence, severs tables from headers, and merges unrelated Items into one vector — the biggest avoidable quality loss in financial RAG. Chunk along natural boundaries:

- **Filings:** by **SEC Item** first (1 Business, 1A Risk Factors, 7 MD&A, 8 Financial Statements), then subsection/heading, then pack paragraphs to a token budget.
- **News:** by paragraph, keeping the headline + dateline attached to every chunk.
- **Transcripts:** by speaker turn (merge tiny adjacent same-speaker turns; split long monologues at sentence boundaries).

Knobs and tradeoffs:
- **Chunk size** ~300–800 tokens. Smaller = sharper retrieval, lost context; larger = better context, diluted vectors and weaker matches on a single fact.
- **Overlap** 10–15% sentence-level on prose; **no overlap across Item or table boundaries**.
- **Parent-document / small-to-big retrieval.** Embed and search over *small* child chunks (sharp recall) but return the *parent* unit (full Item, full table, full Q&A exchange) to the LLM. Store `parent_id` on every child; retrieve children, dedupe to parents, fetch parent text. Resolves the size tradeoff.

```python
def chunk_filing(doc):
    for item in split_by_sec_item(doc):          # Item 1A, 7, 8, ...
        parent = make_parent(item)               # stored, not embedded
        for block in split_by_heading(item):
            children = parse_table_block(block, item.meta) if block.is_table \
                       else pack_paragraphs(block, target=500, overlap=0.12)
            for c in children:
                c.parent_id = parent.id
                yield parent, c
```

##### 7.2.3 Contextual retrieval (prepend parent/section context before embedding)

Filing language is terse and anaphoric ("the Company", "such amounts", "the period"). A raw chunk *"Revenue decreased 4% primarily due to lower volumes"* is nearly unretrievable. **Before embedding**, prepend a short context header situating the chunk in its parent doc + section. This materially boosts recall on exactly the terse, pronoun-heavy text filings are made of.

```python
CTX_PROMPT = """Document: {ticker} {doc_type} for {fiscal_period} (filed {acceptance}).
Section: {section}.
Write 1-2 sentences situating the following chunk within the whole filing,
resolving 'the Company', segments, and the period it refers to.
Chunk:
{chunk}"""

ctx = llm(CTX_PROMPT.format(**meta, chunk=c.text))   # cache per (parent_id, section)
embedding_input = f"{ctx}\n\n{c.text}"               # embed THIS
c.embedding = embed(embedding_input)
c.context_header = ctx                                # store for display/debug
```

Embed `context + chunk`; keep the original chunk text for the answer. Pair with hybrid retrieval (dense + BM25) so exact tickers, line-item names, and numbers still match lexically.

##### 7.2.4 Metadata — and the point-in-time temporal axis (the look-ahead trap)

Attach to every chunk: `ticker[]`, `cik`, `figi`, `doc_type`, `section`, `published_at`, `period_end`, `fiscal_period`, `acceptance_datetime`, `source`, `url`, `language`.

**The crucial point-in-time axis.** For any time-aware query or backtest, filter on **`acceptanceDateTime`** (when the filing became public) — *not* `period_end`. A 10-K for `period_end = 2024-12-31` may not be accepted until late February 2025; using `period_end` as the visibility date leaks two months of hindsight. Rule: **`as_of_query_time >= acceptance_datetime`** is the only correct visibility predicate; `period_end` is descriptive metadata, never a visibility gate. Carry both; index `acceptance_datetime` for range filtering.

##### 7.2.5 Numbers, tables, and stable entity IDs (faithful retrieval)

- **Faithful numbers.** Keep original scale/units in the chunk text (`[in millions, except per-share]`). Attach the parallel **XBRL fact** (`concept`, exact value, `unit`, `decimals`) as metadata so answers cite an exact tagged figure. Preserve negatives-in-parentheses, separators, currency.
- **Entity / ticker normalization.** Resolve every issuer to a **stable ID** at ingest: ticker → **CIK** (issuer) and → **FIGI** (instrument). Tickers are reused; CIK/FIGI are durable join keys. Maintain an alias map ("Alphabet", "Google", `GOOGL`, `GOOG` → CIK `0001652044`) and store resolved IDs, not just the surface string.

##### 7.2.6 Concrete chunk schema

```json
{
  "chunk_id": "0000320193-25-000123_item7_p014_c2",
  "parent_id": "0000320193-25-000123_item7",
  "text": "Total net sales decreased 4% or $3.0 billion ...",
  "context_header": "AAPL 10-Q FY2025 Q2 (filed 2025-05-02), Item 7 MD&A: discusses quarter-over-quarter revenue by segment.",
  "is_table": false, "table_id": null, "units": null,
  "xbrl_facts": [
    {"concept": "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
     "value": 95359000000, "unit": "USD", "decimals": -6, "context": "FY2025Q2"}
  ],
  "metadata": {
    "ticker": ["AAPL"], "cik": "0000320193", "figi": "BBG000B9XRY4",
    "doc_type": "10-Q", "section": "Item 7 - MD&A",
    "published_at": "2025-05-02T16:31:00Z", "period_end": "2025-03-29",
    "fiscal_period": "FY2025 Q2", "acceptance_datetime": "2025-05-02T16:31:07Z",
    "source": "EDGAR", "url": "https://www.sec.gov/Archives/edgar/data/320193/...",
    "language": "en"
  },
  "embedding_model": "text-embedding-3-large",
  "embedding": [0.0123, -0.0456, "..."]
}
```

##### 7.2.7 Ingestion-time processing flow

```
1. FETCH        pull doc + metadata (EDGAR accession, acceptanceDateTime, CIK)
2. CLASSIFY     doc_type, language, source; route to the right parser
3. RESOLVE IDs  ticker → CIK/FIGI via alias map; attach period_end, fiscal_period
4. PARSE        structure-aware: HTML/iXBRL | PDF-layout | transcript-turns
5. EXTRACT XBRL harvest tagged facts; bind to nearest section/table
6. CHUNK        split by structure; tables atomic w/ header+units; parents + children
7. CONTEXTUALIZE generate context_header per chunk (template + cached LLM summary)
8. EMBED        embed (context_header + text); hybrid: also index BM25/keywords
9. ENRICH       finalize metadata incl. acceptance_datetime (point-in-time)
10. UPSERT      write children (vectors+meta) + parents (full text); idempotent on chunk_id
```

Invariants: every child has a retrievable `parent_id`; every table chunk carries header + units + `table_id`; every chunk carries `acceptance_datetime`; every issuer is keyed by `cik`/`figi`, not a mutable ticker.

---

#### 7.3 Hybrid Search, Reranking & Retrieval Evaluation

Retrieval quality is the ceiling on answer quality. In finance this ceiling is brutally exposed because queries hinge on *literal* tokens — `AAPL`, CUSIP `037833100`, "Q3 FY2024", "$1.27 EPS", "10-K Item 1A" — where a single wrong character changes the meaning.

##### 1. Hybrid retrieval (dense + lexical) — non-negotiable in finance

Pure dense retrieval fails on exactly the tokens that matter. Embeddings map text into a smooth semantic space, so `AAPL` and `MSFT` sit close, "Q2" and "Q3" are near-neighbors, and a CUSIP or precise dollar figure has no meaningful neighborhood. Lexical (BM25 / Postgres FTS) nails these. Dense wins on paraphrase ("companies exposed to rising rates" → "interest-rate sensitivity" / "duration risk"). You need both.

Run both independently and fuse with **Reciprocal Rank Fusion (RRF)** — it combines *ranks*, sidestepping the unsolvable problem of calibrating a BM25 score against a cosine similarity:

```python
def rrf_fuse(dense_ranked, lexical_ranked, k=60, weights=(1.0, 1.0)):
    scores = {}
    for ranking, w in zip((dense_ranked, lexical_ranked), weights):
        for rank, chunk_id in enumerate(ranking):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + w * (1.0 / (k + rank + 1))
    return sorted(scores, key=scores.get, reverse=True)
```

- **Dense leg:** pgvector HNSW, cosine, top ~50–100 ids + ranks.
- **Lexical leg:** Postgres FTS (`websearch_to_tsquery` + `ts_rank_cd`) is the zero-new-infra option; a dedicated BM25 (`pg_search`/ParadeDB, OpenSearch) gives better IDF/tokenization. **Tune the tokenizer** so stemming/punctuation stripping doesn't destroy `10-K`, `FY2024`, or tickers — index symbols as exact tokens.
- **Tuning fusion:** smaller `k` = top-heavy. Start `k=60`, `weights=(1,1)`; tune weights on your eval set (number-heavy corpora usually justify nudging lexical up). Tune against recall@k, not vibes.

##### 2. Cross-encoder reranking — usually the single biggest precision win

Bi-encoders (your embedding model) encode query and document separately — fast but coarse. A **cross-encoder reranker** (Cohere Rerank, or hosted/self-served `bge-reranker-v2`) scores `(query, chunk)` jointly. Pattern: retrieve ~50 via hybrid, rerank, keep top ~5–8.

```python
candidates = rrf_fuse(dense_ranked, lexical_ranked)[:50]
reranked = rerank(query, [chunks[c] for c in candidates])  # cross-encoder
top_context = reranked[:8]
```

It's typically the largest precision win available from one component because first-stage retrieval optimizes recall and the reranker optimizes precision — rescuing a gold chunk retrieved at rank 23. **Budget:** ~50–300 ms hosted; it adds directly to time-to-first-token. **Skip when:** a precise lexical match already satisfies the query, latency SLA is tight, or your eval shows hybrid-only nDCG already at parity.

##### 3. Metadata pre-filtering, query routing, and query expansion

**Pre-filter in the `WHERE` clause, before similarity.** Push hard filters (`ticker`, `as_of_date`, `doc_type`, `fiscal_period`, `section`) into SQL so similarity runs only over the legal candidate set — correctness *and* speed:

```sql
SELECT chunk_id, embedding <=> :qvec AS dist
FROM chunks
WHERE ticker = 'NVDA' AND doc_type = '10-K' AND as_of_date >= '2024-01-01'
ORDER BY embedding <=> :qvec
LIMIT 50;
```

**Query routing** decides *what* to retrieve: "guided for next quarter?" → latest call/news; "stated risk factors?" → the 10-K; "revenue trend 2019–2024?" → structured financials, maybe not RAG at all. A lightweight classifier extracts entities (ticker, date range, doc_type) and routes to the right index/filter/freshness window — eliminating a large class of "right model, wrong corpus" failures.

**Multi-query / HyDE expansion** helps vocabulary mismatch. Multi-query unions 2–4 paraphrases; HyDE embeds a hypothetical answer and searches with it. Both raise recall on vague conceptual queries; both hurt precision/latency on exact-identifier queries — gate them on the router.

##### 4. Retrieval evaluation harness — measure, don't guess

Build a gold set of question → relevant-chunk(s) pairs (start 100–300, grow over time): real queries, hard literal cases (tickers/CUSIPs/dates), conceptual paraphrases, recency-sensitive cases.

**Component metrics:** recall@k (ceiling on everything downstream), MRR (single-answer lookups), nDCG@k (graded, best single summary).

```python
import numpy as np
def ndcg_at_k(ranked_ids, relevance, k=10):
    gains = [relevance.get(cid, 0) for cid in ranked_ids[:k]]
    dcg = sum(g / np.log2(i + 2) for i, g in enumerate(gains))
    ideal = sorted(relevance.values(), reverse=True)[:k]
    idcg = sum(g / np.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg > 0 else 0.0

def recall_at_k(ranked_ids, gold_ids, k=10):
    hits = len(set(ranked_ids[:k]) & set(gold_ids))
    return hits / len(gold_ids) if gold_ids else 0.0
```

**End-to-end metrics:** answer faithfulness/groundedness (LLM-judge or NLI against cited chunks — critical in finance) and citation accuracy (does the cited chunk actually contain the asserted fact, with the right ticker/period/filing).

**Wire it into CI.** On every PR touching the retrieval stack, run the harness and fail/flag on regression past a threshold (e.g. recall@10 or nDCG@10 dropping >1–2 points). Converts "feels better" into a number and catches silent regressions (a chunker tweak that splits tables, an index param trading recall for speed).

##### 5. Common failure modes

- **Lost-in-the-middle:** order deliberately — strongest chunks first (optionally last), not buried mid-list; fewer high-precision chunks beat a large dump.
- **top-k too small/large:** too small → gold chunk never enters context; too large → distractors, cost, worse lost-in-the-middle. Tune separately for retrieval (~50) and generation (~5–8).
- **Stale results:** carry `as_of_date`, boost recency in the router, re-index promptly on new filings/news.
- **Query–document vocabulary mismatch:** "make money" vs "net income"; fixed by hybrid (lexical), HyDE/multi-query, and entity normalization in the router.

---

#### 7.4 Market & Time-Series Data Storage

Market data is the heaviest, most write-intensive, most correctness-sensitive store. The dominant risk is not throughput but *lookahead leakage* — any path where a feature, backtest, or insight sees information that didn't exist when it claims to act.

##### 7.4.1 Hypertable schema, partitioning, compression, aggregates (foundation)

Store each granularity in its own hypertable. Partition by time first; add a space dimension on an integer `symbol_id` surrogate (never the raw ticker — tickers get reused).

```sql
CREATE TABLE security (
    symbol_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    figi           text UNIQUE, primary_ticker text NOT NULL,
    asset_class    text NOT NULL, first_seen date NOT NULL,
    delisted_on    date                      -- NULL = active; never delete the row
);

CREATE TABLE tick (
    symbol_id bigint NOT NULL REFERENCES security,
    event_ts  timestamptz NOT NULL,                       -- exchange/event time
    ingest_ts timestamptz NOT NULL DEFAULT now(),         -- when WE learned it
    price numeric(18,6) NOT NULL, size numeric(18,4) NOT NULL,
    side char(1), venue text, seq bigint,
    PRIMARY KEY (symbol_id, event_ts, seq)
);
SELECT create_hypertable('tick', 'event_ts',
    partitioning_column => 'symbol_id', number_partitions => 16,
    chunk_time_interval => INTERVAL '1 day');
```

**Compression (~90%)** segments by `symbol_id`, orders by time, collapsing repetitive columns and delta-encoding monotonic timestamps/prices:

```sql
ALTER TABLE tick SET (timescaledb.compress,
    timescaledb.compress_segmentby = 'symbol_id',
    timescaledb.compress_orderby   = 'event_ts DESC, seq');
SELECT add_compression_policy('tick', after => INTERVAL '2 days');
```

**Continuous aggregates** pre-roll bars hierarchically (1m from ticks, then 5m/1h/1d from 1m), never touching the still-forming current bucket:

```sql
CREATE MATERIALIZED VIEW ohlcv_5m WITH (timescaledb.continuous) AS
SELECT symbol_id, time_bucket('5 minutes', bucket) AS bucket,
       first(open, bucket) AS open, max(high) AS high, min(low) AS low,
       last(close, bucket) AS close, sum(volume) AS volume,
       sum(vwap*volume)/NULLIF(sum(volume),0) AS vwap
FROM ohlcv_1m GROUP BY symbol_id, time_bucket('5 minutes', bucket) WITH NO DATA;
SELECT add_continuous_aggregate_policy('ohlcv_5m',
    start_offset => INTERVAL '3 hours', end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '1 minute');
```

**Retention** drops chunks (cheap), keeping coarse bars effectively forever (they're tiny); the aggregates and Parquet lake preserve history before raw ticks expire.

##### 7.4.2 Point-in-time discipline as a storage concern (highest correctness impact)

Every record carries **two clocks**: `event_ts` (when it happened) and `knowledge_ts`/`ingest_ts` (when *we* could know it). Features/backtests/LLM context must filter and join on knowledge time. Bars are simple; fundamentals/estimates/ratings/news are not (a Q4 figure has a Dec-31 period-end but becomes knowable weeks later on filing).

**Store vintages, never overwrite** — fundamentals get restated:

```sql
CREATE TABLE fundamental_vintage (
    symbol_id bigint NOT NULL REFERENCES security, metric text NOT NULL,
    period_end date NOT NULL,                  -- fiscal period (event time)
    knowledge_ts timestamptz NOT NULL,         -- when THIS value became known
    value numeric(20,6) NOT NULL, is_restatement boolean NOT NULL DEFAULT false,
    source text, PRIMARY KEY (symbol_id, metric, period_end, knowledge_ts)
);
```

**As-of joins** are the enforcement mechanism — attach the latest vintage whose `knowledge_ts <= bar time`, never the latest value overall:

```sql
SELECT b.symbol_id, b.bucket, b.close, f.value AS eps_known
FROM ohlcv_1d b
CROSS JOIN LATERAL (
    SELECT value FROM fundamental_vintage f
    WHERE f.symbol_id = b.symbol_id AND f.metric = 'eps'
      AND f.knowledge_ts <= b.bucket          -- the point-in-time guard
    ORDER BY f.knowledge_ts DESC LIMIT 1
) f;
```

Encode in code review: **no query feeding a feature or backtest may reference "the latest" row without a `knowledge_ts <= as_of` bound.** A synthetic backtest over a known restatement is the cheapest lookahead regression test.

##### 7.4.3 Corporate actions and survivorship-bias-safe universes

**Store raw (unadjusted) prices as source of truth; keep adjustments as data, not baked in.** Adjusted series are derived by a cumulative factor (itself point-in-time, including only actions known by that date).

```sql
CREATE TABLE corporate_action (
    symbol_id bigint NOT NULL REFERENCES security, action_type text NOT NULL,
    ex_date date NOT NULL, knowledge_ts timestamptz NOT NULL,
    split_ratio numeric(18,8), cash_amount numeric(18,6),
    new_symbol_id bigint REFERENCES security,
    PRIMARY KEY (symbol_id, action_type, ex_date)
);
```

**Survivorship bias is a universe problem.** (1) Never delete delisted securities — set `delisted_on`, keep history. (2) Store historical index membership as ranges and resolve as-of the test date:

```sql
CREATE TABLE index_membership (
    index_id bigint NOT NULL, symbol_id bigint NOT NULL REFERENCES security,
    valid_from date NOT NULL, valid_to date,   -- NULL = still a member
    PRIMARY KEY (index_id, symbol_id, valid_from)
);
-- Universe as of D: WHERE valid_from <= D AND (valid_to IS NULL OR valid_to > D)
```

##### 7.4.4 Tiering: ClickHouse and a Parquet lake for heavy scans

Timescale serves the live app (latest quotes, range bars, as-of joins, point lookups) with low latency and transactional ingest. It hurts on **wide analytical scans** (full-history factor computations, cross-sectional ranks, multi-year backtests).

- **ClickHouse** when backtests are scan-bound — vectorized columnar `MergeTree` ordered by `(symbol_id, event_ts)`. A derived analytics replica fed from the same point-in-time tables; not the system of record.
- **Parquet on object storage** is the cheap archive/lake: partition by `symbol_id`/date, immutable daily files, cold history kept indefinitely. Feeds offline backtests, training, re-embedding (DuckDB/Polars/Spark read it directly).

Decision rule: **point lookups/live reads → Timescale; bulk scans → ClickHouse; cold storage and batch/ML feeds → Parquet.** Add ClickHouse only when measured scan latency becomes the bottleneck.

##### 7.4.5 Query patterns, indexes, real-time ingestion

- **Latest quote per symbol:** maintain a tiny `latest_quote` upsert table keyed by `symbol_id` so the read is a single row.
- **Range bars:** served from the matching continuous aggregate with a composite-PK index-only scan.
- **As-of fundamental join:** the `LATERAL` pattern, backed by `(symbol_id, metric, knowledge_ts DESC)`.

```sql
CREATE TABLE latest_quote (
    symbol_id bigint PRIMARY KEY REFERENCES security, event_ts timestamptz NOT NULL,
    bid numeric(18,6), ask numeric(18,6), last numeric(18,6),
    ingest_ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fundamental_vintage (symbol_id, metric, knowledge_ts DESC);
```

**Real-time WebSocket ingestion** must be idempotent and defensive:

```sql
INSERT INTO tick (symbol_id, event_ts, price, size, side, venue, seq)
VALUES (...) ON CONFLICT (symbol_id, event_ts, seq) DO NOTHING;   -- replay-safe

INSERT INTO latest_quote AS q (symbol_id, event_ts, bid, ask, last)
VALUES (...) ON CONFLICT (symbol_id) DO UPDATE
SET bid = EXCLUDED.bid, ask = EXCLUDED.ask, last = EXCLUDED.last, event_ts = EXCLUDED.event_ts
WHERE EXCLUDED.event_ts > q.event_ts;                            -- never go backwards
```

**Bad-tick filtering at the boundary:** reject non-positive/null prices, zero/negative size, crossed quotes (bid > ask), >N-sigma jumps vs rolling last, stale/duplicate sequence numbers, off-hours ticks. Quarantine rejects to `tick_rejected` (auditable/tunable), not silent drops. Always stamp `ingest_ts` — it is the `knowledge_ts` the whole point-in-time discipline depends on.

---

#### 7.5 Ingestion Pipelines, Freshness, Versioning & Multi-Tenancy

Retrieval quality is bounded by ingestion discipline. A wrong/stale answer about an earnings beat is a correctness and trust failure with regulatory and financial consequences.

##### 7.5.1 Incremental, idempotent ingestion with a decoupled job queue (highest impact)

Key every source on a **stable, source-native ID** so re-runs converge instead of duplicating:

| Source | Stable key | Notes |
|---|---|---|
| SEC EDGAR | `accession_number` | Globally unique; pair with `cik` + `form_type`. Amendments = new accession. |
| News APIs | article `guid` / canonical URL hash | GUIDs can be reissued on correction — hash canonical URL as fallback. |
| Transcripts | `(ticker, event_id, fiscal_period)` / vendor `transcript_id` | Corrections re-emit same event_id, new revision. |

```sql
CREATE TABLE source_document (
    tenant_id uuid NOT NULL, source text NOT NULL, source_id text NOT NULL,
    content_hash bytea NOT NULL, published_at timestamptz NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(), raw_uri text NOT NULL,
    PRIMARY KEY (tenant_id, source, source_id)
);

INSERT INTO source_document (tenant_id, source, source_id, content_hash, published_at, raw_uri)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (tenant_id, source, source_id) DO UPDATE
    SET content_hash = EXCLUDED.content_hash, raw_uri = EXCLUDED.raw_uri, fetched_at = now()
    WHERE source_document.content_hash <> EXCLUDED.content_hash   -- only when content changed
RETURNING (xmax = 0) AS inserted;                                 -- true=new
```

**Decouple the stages behind a durable queue** (SQS/Kafka/Postgres `SKIP LOCKED`), passing only the `(tenant_id, source, source_id, content_hash)` handle — payload lives in object storage:

```
 RSS/API poll → [fetch_q] → fetch → [parse_q] → parse → [chunk_q] → chunk
                                                                      │
                              index ← [index_q] ← embed ← [embed_q] ←─┘
   each stage: at-least-once delivery + idempotent write keyed on content_hash
   failures after N retries → [dead_letter_q]  (poisoned docs never block the line)
```

- **At-least-once + idempotent = effectively-once.** Never rely on exactly-once delivery; rely on idempotent writes.
- **Dead-letter queue.** A malformed doc moves to a DLQ after a bounded retry budget; operators replay after a fix; the line never head-of-line-blocks.
- **Backfill is decoupled from live** (separate low-priority pool) so a 50M-chunk re-embed never starves real-time filing ingestion.

##### 7.5.2 Per-document ingestion state machine (detect & selectively re-embed)

Track each document's state plus **which embedding model and chunker produced the live vectors** — without that, you can't answer "is this vector stale?" and you're forced to re-embed the whole corpus on every model change.

```sql
CREATE TYPE ingest_state AS ENUM
  ('discovered','fetched','parsed','chunked','embedded','indexed','stale','failed');
CREATE TABLE document_ingest (
    tenant_id uuid NOT NULL, source text NOT NULL, source_id text NOT NULL,
    state ingest_state NOT NULL DEFAULT 'discovered', content_hash bytea NOT NULL,
    chunker_version text, embedding_model text, embedding_dim int,
    state_updated_at timestamptz NOT NULL DEFAULT now(), last_error text,
    retry_count int NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, source, source_id),
    FOREIGN KEY (tenant_id, source, source_id)
        REFERENCES source_document (tenant_id, source, source_id)
);

-- Selective re-embed: only docs whose vectors were produced by a superseded model/chunker.
UPDATE document_ingest SET state = 'stale', state_updated_at = now()
 WHERE state = 'indexed'
   AND (embedding_model <> :current_model OR chunker_version <> :current_chunker);
```

This makes targeted re-embeds a cheap `WHERE`, gives crash recovery (a reaper re-enqueues non-terminal states past a timeout), and reprocesses content changes (a corrected 10-K/A changes `content_hash`, flipping the doc back to `fetched`).

##### 7.5.3 Freshness SLAs & monitoring (stale data == correctness failure)

Define and alarm on SLAs measured from **source publish time**, not ingest time:

| Metric | Definition | Example SLA |
|---|---|---|
| Ingest lag | `searchable_at − published_at` | p95 < 90s news; p95 < 5 min EDGAR |
| Latest-doc freshness | per ticker: `now − max(published_at)` | alert on unexpected silence |
| Stale-vector ratio | `count(stale)/count(indexed)` | < 1% steady-state |
| DLQ depth/age | messages + oldest age | page on age > 15 min |
| Source liveness | gap since last successful poll | page if EDGAR silent > 10 min in market hours |

Emit `searchable_at` the instant a chunk lands in the index; **degrade loudly** — on SLA breach, surface "data as of <timestamp>" and refuse confident claims about windows you can't cover.

##### 7.5.4 Data versioning & lineage (reproduce exactly what the model saw)

Immutable, content-hashed document/chunk **versions** with temporal validity — never update-in-place:

```sql
CREATE TABLE chunk_version (
    chunk_version_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
    source text NOT NULL, source_id text NOT NULL, doc_content_hash bytea NOT NULL,
    chunk_index int NOT NULL, chunk_hash bytea NOT NULL, text text NOT NULL,
    chunker_version text NOT NULL, embedding_model text NOT NULL,
    valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz,
    source_url text NOT NULL, license text NOT NULL, redistributable boolean NOT NULL,
    UNIQUE (tenant_id, source, source_id, chunk_index, chunk_hash)
);
CREATE INDEX ON chunk_version (tenant_id, source, source_id) WHERE valid_to IS NULL;
```

Citing a `chunk_version_id` (+ `chunk_hash`) replays an answer against the exact text even after amendment. Point-in-time retrieval: `WHERE valid_from <= :answer_time AND (valid_to IS NULL OR valid_to > :answer_time)`. Store `license`/`redistributable`/`source_url` per version and **enforce redistribution at retrieval/answer time** — a document the tenant isn't licensed for must be filterable out of retrieval.

##### 7.5.5 Multi-tenant isolation (a missing WHERE must not leak data)

Mandatory `tenant_id` on every content row, enforced with **Postgres Row-Level Security** so a forgotten `WHERE tenant_id` can't leak data:

```sql
ALTER TABLE chunk_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_version FORCE ROW LEVEL SECURITY;   -- applies even to table owner
CREATE POLICY tenant_isolation ON chunk_version
    USING      (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

```python
async with pool.acquire() as conn, conn.transaction():
    await conn.execute("SELECT set_config('app.tenant_id', $1, true)", tenant_id)
    rows = await conn.fetch("SELECT chunk_version_id, text FROM chunk_version WHERE chunk_hash = $1", h)
    # no explicit tenant filter needed — RLS guarantees scoping
```

Escalate to schema-per-tenant (per-tenant tuning, stronger blast-radius) or database-per-tenant (data-residency mandates, physical isolation) only when warranted. **RLS does not protect a separate vector store** — replicate the discipline there (namespace/collection per tenant, or a mandatory `tenant_id` filter on every ANN query).

##### 7.5.6 Grounding/citation & feedback storage (auditable answers + reranker tuning)

```sql
CREATE TABLE answer_log (
    answer_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
    query_text text NOT NULL, answered_at timestamptz NOT NULL DEFAULT now(),
    retriever_model text NOT NULL, reranker_model text, generation_model text NOT NULL,
    final_prompt text NOT NULL, answer_text text NOT NULL
);
CREATE TABLE answer_retrieval (   -- one row per retrieved chunk: exact version + score
    answer_id uuid NOT NULL REFERENCES answer_log(answer_id), rank int NOT NULL,
    chunk_version_id uuid NOT NULL REFERENCES chunk_version(chunk_version_id),
    retrieval_score real NOT NULL, rerank_score real, used_in_context boolean NOT NULL,
    PRIMARY KEY (answer_id, rank)
);
CREATE TABLE answer_feedback (
    answer_id uuid NOT NULL REFERENCES answer_log(answer_id),
    chunk_version_id uuid REFERENCES chunk_version(chunk_version_id),
    label text NOT NULL,    -- thumbs_up|thumbs_down|cited_correct|hallucination|stale
    source text NOT NULL,   -- user|analyst_review|auto_eval
    note text, created_at timestamptz NOT NULL DEFAULT now()
);
```

Because `answer_retrieval` references immutable `chunk_version_id` plus the recorded `final_prompt` and model versions, you can reconstruct exactly what the model saw months later. `(query_text, chunk_version_id, scores, label)` is ready-made reranker training data — thumbs-down/`hallucination`/`stale` become hard negatives, `cited_correct` become positives.

**Implementation order:** (1) source-keyed idempotent ingestion + decoupled queue with DLQ/backfill, (2) per-document state machine with model/chunker versions, (3) publish-time freshness SLAs + per-ticker liveness, (4) content-hashed bitemporal versioning + provenance/licensing, (5) `tenant_id` everywhere + RLS, (6) versioned answer/feedback logs.
