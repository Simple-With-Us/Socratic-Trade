# 2026-06-18 - RAG review resolution

## Summary
Reviewed the prior RAG/platform review findings and resolved the concrete code issues:
tracked vector storage is present, vector ingestion is batched, SEC 8-K context is richer,
retrieved context no longer destabilizes the system prompt, the dev script is safer, and
direct tests cover the RAG path.

## Why
The earlier review correctly flagged that the first Voyage/Pinecone pass was too scaffold-like:
it embedded low-information 8-K text, checked/created Pinecone indexes per document, put dynamic
retrieved text in the system prompt, and had stale tests/mocks. Those issues would make fresh
checkouts fragile, RAG low-value, and prompt caching less effective.

## Files
- `src/lib/vector-db.ts` - add `storeContexts`, batch Voyage embeddings/upserts, cache Pinecone
  index initialization per key/index, add stable record IDs, use `inputType: "document"` and
  `inputType: "query"`.
- `src/lib/web-sources/sec8k.ts` - preserve SEC filing URLs, fetch fresh filing summary pages,
  parse 8-K item labels, include item labels in bulletins, and batch-store richer RAG context.
- `src/lib/strategy.ts` - keep stable RAG instructions in the system prompt but move retrieved
  snippets to `retrievedFinancialContext` in the user payload.
- `package.json` / `README.md` - make `npm run dev` non-destructive and move port-killing behavior
  to explicit `npm run dev:clean`.
- `test/vector-db.test.ts` - direct mocked Voyage/Pinecone tests for batch store, centralized
  index init, and retrieval filters.
- `test/web-sources-sec8k.test.ts` - item-label parsing and enriched context tests.
- `test/persistence-notification.test.ts`, `test/reconciliation-risk.test.ts` - update stale
  vector mocks and add strategy prompt placement coverage.
- `AGENTS.md` - refresh durable verification guidance to the current suite size.
- `STATUS.md`, `PLAN.md`, `docs/phase-10-signals-learning-ui-v2.md`,
  `docs/rollouts/2026-06-18-voyage-pinecone-rag.md` - update current handoff docs.

## Verification
- `npx vitest run test/vector-db.test.ts test/web-sources-sec8k.test.ts test/persistence-notification.test.ts test/reconciliation-risk.test.ts` passed: 4 files, 22 tests.
- Full combined worktree check passed:
  `npx tsc --noEmit`, `npm test` (27 files, 195 tests), `npm run build` (11 app pages generated).

## Follow-ups
- Add true filing-text snippets or LLM-generated digests for high-value 8-Ks.
- Add stale-data/age metadata and retrieval timeout budgets before treating RAG as production-grade.
- Consider adding news and FINRA/context narratives to `storeContexts` once the SEC path proves useful.
