# RAG stack options for Socratic Trade

Date: 2026-07-03

Context: owner asked whether Gemini's suggested beginner RAG stack should change Socratic Trade's
production RAG design, and whether a fresh Pinecone Starter quota can be protected before new keys
are connected.

## Decision

Keep the current default: **Voyage finance embeddings + Pinecone serverless + Voyage rerank**.

This app is not a generic tutorial chatbot. It is a finance/trading system where retrieval quality
depends on finance-specific language, point-in-time source handling, provenance, write controls, and
auditable decision memory. The existing runtime already uses `voyage-finance-2`, Pinecone, and
`rerank-2.5` directly; it does not use LangChain or LlamaIndex as core dependencies.

## Why this is the best default

- Voyage has finance-domain embeddings already matched to the current 1024-dimensional Pinecone
  index. Switching embedding models requires a new index and a full re-embed.
- Voyage rerank is already wired as the quality layer after dense retrieval; reranking is the higher
  leverage quality move than swapping orchestration frameworks.
- Pinecone is the right managed default for a small production app because it avoids running vector
  infrastructure and already supports the current metadata/filter model.
- The codebase already implements the domain-specific parts a generic framework would not solve for
  us: chunking, content-hash dedup, as-of filtering, tenant scope, source metadata, API health,
  metering, and admin coverage views.
- Paying for capacity is acceptable once it is deliberate usage. Do not pay merely to cover a coding
  defect; prove dedup, write fuses, and admin/API Usage Monitor/Sentry visibility first.

## Consider later

- **OpenAI embeddings**: credible fallback or A/B baseline, especially if vendor consolidation matters.
  Do not swap by default; there is no finance-specific default advantage, and dimensions/indexes must
  be migrated deliberately.
- **Pinecone Inference embeddings (`llama-text-embed-v2`, `multilingual-e5-large`)**: credible cost
  and simplicity candidate because Pinecone hosts the embedding step and exposes per-request inference
  usage. The screenshot's 5M Starter limit applies to hosted embedding tokens, not Pinecone database
  Write Units. Test with a gold corpus before migrating; integrated indexes require a different
  `create_index_for_model`/`field_map` path, and new vectors cannot be mixed with old Voyage vectors.
- **Cohere Embed/Rerank**: credible enterprise alternative, especially for multilingual/semi-structured
  rerank use. Benchmark against our actual filings and strategy questions before switching.
- **Weaviate**: consider only if its built-in hybrid/platform features become more valuable than
  Pinecone's managed simplicity. This is a platform migration.
- **Qdrant/Chroma/pgvector**: cheaper direct-vendor-cost options for local evals or self-hosting.
  Consider if managed Pinecone cost stays disproportionate after fuses, but price savings trade for
  ops/backups/monitoring work.
- **LlamaIndex**: useful if document ingestion/query-engine abstraction becomes the bottleneck. Today
  the custom ingestion path is already tailored to SEC filings and decision memory.
- **LangChain**: useful for generic RAG/agent experiments, not a production requirement for this stack.

## Avoid for now

- Do not migrate to Chroma as the production store. It is fine for local experiments, but it weakens
  managed production operations and quota visibility.
- Do not add LangChain/LlamaIndex just to say the app uses a framework. That adds dependency surface
  without fixing retrieval precision, corpus quality, or quota waste.
- Do not switch away from Voyage finance embeddings without a gold-set retrieval benchmark and a planned
  reindex.
- Do not upgrade Pinecone to mask write leakage. Fix idempotency, batching, dashboards, and write fuses
  first.

## Current write paths that can spend Pinecone/Voyage quota

- `src/lib/scheduler.ts` calls `refreshFilingBodies`, which can ingest 10-K/10-Q body chunks.
- `src/lib/web-sources/sec8k.ts` writes 8-K summaries and optional full 8-K bodies.
- `src/lib/web-sources/disclosure-rag.ts` writes congress and insider disclosure documents when enabled.
- `src/lib/socratic-memory.ts` writes Socratic decision memory.
- Admin reindex routes can trigger manual backfills.

## Required safeguards before fresh Pinecone keys

- Keep `RAG_INGEST_BUDGET_ENABLED=on`.
- Keep `RAG_INGEST_MAX_TEXTS_PER_DAY=1000` until corpus growth is intentionally planned.
- Keep `VECTOR_STORECONTEXTS_DEDUP=on`.
- Keep `SEC_FILING_RAG_MAX_PER_RUN=1` until a paid-key/full-corpus plan is explicit.
- Keep `RAG_PINECONE_WRITE_BUDGET_ENABLED=on`.
- Start with `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY=50000` or lower on a fresh Starter account.
- Leave `WEB_SOURCE_SEC8K_FULL_BODY=off` and `RAG_EMBED_DISCLOSURES=off` until the admin RAG pages show
  clean health, sane write volume, and correct coverage.
- Configure API Usage Monitor push for cross-app trend visibility and Sentry warning capture for RAG
  provider failures / Pinecone WU budget trips.

## Sources checked

- Pinecone database limits and Write Unit accounting: https://docs.pinecone.io/reference/api/database-limits
- Pinecone cost model: https://docs.pinecone.io/guides/manage-cost/understanding-cost
- Pinecone hosted embedding models: https://docs.pinecone.io/models/llama-text-embed-v2 and https://docs.pinecone.io/models/multilingual-e5-large
- Pinecone integrated embedding index API: https://docs.pinecone.io/reference/api/2025-01/control-plane/create_for_model
- Pinecone usage monitoring: https://docs.pinecone.io/guides/manage-cost/monitor-usage-and-costs
- Voyage pricing/model docs: https://docs.voyageai.com/docs/pricing
- Voyage reranker docs: https://docs.voyageai.com/docs/reranker
- OpenAI embeddings docs: https://developers.openai.com/api/docs/guides/embeddings
- Cohere model/rerank docs: https://docs.cohere.com/docs/models
- LangChain RAG docs: https://docs.langchain.com/oss/python/langchain/rag
- LlamaIndex RAG docs: https://developers.llamaindex.ai/python/framework/understanding/rag/
