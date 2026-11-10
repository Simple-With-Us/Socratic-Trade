# Rollout: section-aware extractive highlights + BAAI embed/rerank alignment

**Date:** 2026-08-06  
**Branch:** `grok/rag-section-aware-highlights-baai`  
**Non-goal:** generative LLM at ingest (still forbidden).

## Context

Trade highlights (`document-summary` / `earnings-summary`) were flat keyword-scored
paragraphs. Embedding was already **BAAI/bge-m3** (OpenRouter / SiliconFlow); Voyage
was purged from prod dispatch. Owner asked for section-aware extractive upgrades,
diversity, cheap BGE-family embed/rerank only — no abstractive LLM.

## What shipped

### Extractive v2 (`extractive-highlights-v2`)

`src/lib/rag/document-summarizer.ts`:

- **Section-aware** scoring when `sections` are passed (10-K/10-Q from `parseFilingHtml`)
- **8-K item split** via `splitTextBySecItems` + `materialItems` soft prior
- **Earnings** prepared vs Q&A soft split
- Expanded **keyword + numeric** signals; section priors (Item 1A / 7 / 2.02 …)
- **Diversity** via Jaccard trigram shingles (default threshold 0.55)
- **Round-robin** across section buckets when `maxChunks ≥ 4`
- Highlight ids: `hl:{itemCode}:{idx}`; text may carry `[Item …]` prefix
- **Versioned refresh**: abstracts with older `model_used` are rewritten once
  (`deleteDocumentAbstractByAccessionAndSource` + re-insert)
- **FTS mirror** for abstracts (`document-summarizer` source) so corpus-wide lexical
  can hit highlights

### Call sites

| Source | Passes |
|--------|--------|
| `sec-filings.ts` | `formHint` + full `sections` |
| `sec8k.ts` | `formHint: "8-K"` + `materialItems` |
| `earningscalls-transcripts.ts` | `formHint: "earnings"` |

### Embed / rerank (config, not generative)

Already production-default:

| Role | Default model |
|------|----------------|
| Embed | OpenRouter `baai/bge-m3` or SiliconFlow `BAAI/bge-m3` (1024-d) |
| Rerank | OpenRouter `cohere/rerank-v3.5` or SiliconFlow `Qwen/Qwen3-Reranker-8B` |

**Bugfix:** `search-fusion.ts` MMR embed path now prefers **OpenRouter then SiliconFlow**,
matching `vector-db` — avoids dual embedding spaces when both keys exist.

### Recommended Infisical / env (cheap + effective)

```bash
# Pin so LLM key presence cannot surprise-flip space
RAG_EMBED_PROVIDER=openrouter   # or siliconflow for isolated RAG vendor
VECTOR_ENABLE_RERANK=on
RAG_ADAPTIVE_RERANK=on
# Throughput: hosted bge is not Voyage free-tier RPM
VECTOR_EMBED_BATCH_DELAY_MS=0
# Leave generative expansion OFF
RAG_HYDE=off
RAG_MULTIQUERY=off
```

Optional cheaper rerank A/B (same embed space — no re-embed):

```bash
RAG_RERANK_PROVIDER=siliconflow
# SILICONFLOW_RERANK_MODEL defaults to Qwen/Qwen3-Reranker-8B
```

## Verification

```bash
npx vitest run test/document-summarizer.test.ts test/rag-information-routing.test.ts
```

## Ops notes

- **New accessions** get v2 highlights immediately.
- **Existing 10-K/10-Q**: when the body is already in `ingested_accessions`, the
  scheduler still runs `maybeRefreshSecFilingAbstract` from **local HTML artifacts**
  (no EDGAR re-fetch) when `model_used ≠ extractive-highlights-v2`.
- **Existing 8-K bodies**: on ledger hit, re-fetches HTML only if the abstract
  needs upgrade (bounded by `abstractNeedsUpgrade`).
- **Earnings**: re-run only when the transcript row is re-ingested (no separate
  ledger-skip path yet).
- Upgrade validates summary length **before** deleting the old SQLite abstract row.
- Full-body vectors are unchanged; no corpus-reembed required for this change.
- Dense retrieval still uses `embed_model` filter for bge-m3; complete any prior
  Voyage→bge re-embed before purge-legacy (separate ops concern).

## Explicit non-goals

- No abstractive / chat LLM for highlights
- No HyDE / multi-query expansion for abstracts
- No Voyage reintroduction
- No Pinecone-hosted bge-reranker production route (eval-only today)
