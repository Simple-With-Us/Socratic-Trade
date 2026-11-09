# 2026-06-18: Voyage AI & Pinecone RAG Integration

## Summary
Replaced the stubbed RAG layer with a production-ready Voyage AI + Pinecone implementation to dynamically inject financial context into the Bull agent's strategy evaluation. Included pipeline integration for 8-K filings.

## Why
The previous cloud-hosted RAG approach was removed to simplify architecture. However, we required high-fidelity embeddings (`voyage-finance-2`) to provide the LLM with relevant catalyst information (news, filings) before trade decisions. Pinecone acts as the vector backend for these high-dimensional financial context vectors.

## Files
- `src/lib/vector-db.ts` [NEW]: Client instantiation for Voyage and Pinecone, encapsulating `storeContext`, batched `storeContexts`, and `retrieveContext` functions. Auto-creates the `robinhood-agentic` index on demand.
- `src/lib/web-sources/sec8k.ts` [MODIFY]: Wired `refreshEightK` to asynchronously batch-store freshly scraped SEC 8-K filings.
- `src/lib/strategy.ts` [MODIFY]: Updated `proposeTrades` interface to accept `ragContext`. Modified `runStrategyOnce` to query `retrieveContext` for the top 3 market candidates and supply them as a bundled RAG block.

## Review resolution
- `src/lib/vector-db.ts` is tracked in Git.
- Vector ingestion now batches Voyage document embeddings and Pinecone upserts through
  `storeContexts`; Pinecone index creation is centralized and cached per key/index
  instead of checked/created per document.
- SEC 8-K context now fetches SEC filing summary pages for fresh events and stores
  item labels plus filing links, instead of embedding only symbol/date/accession.
- Retrieved RAG snippets now live in the dynamic user payload as
  `retrievedFinancialContext`, while the system prompt keeps only stable instructions
  about how to use that optional field.
- Tests now cover vector storage/retrieval, SEC 8-K item context, and prompt placement.

## Verification
- Dependencies (`voyageai`, `@pinecone-database/pinecone`) validated.
- Pinecone and Voyage keys read automatically via `getUserApiKey(userId, "voyage")` or environment fallbacks.
- 2026-06-18 targeted review check: `npx vitest run test/vector-db.test.ts test/web-sources-sec8k.test.ts test/persistence-notification.test.ts test/reconciliation-risk.test.ts` passed (22 tests).
- 2026-06-18 full combined worktree check passed: `npx tsc --noEmit`, `npm test`
  (27 files, 195 tests), `npm run build` (11 app pages generated).

## Follow-ups
- Hook up news feeds and FINRA short volume narratives to also feed into the `vector-db.ts` ingestion pipeline.
- Consider UI toggle in Settings for "Enable LLM RAG".
