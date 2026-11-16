# 2026-08-05 — Owner rulings: stop test-broker autonomy + optimize SEC RAG + 10-K backfill

## Summary
Owner #1324 applied:
1. Hard-skip `broker=test` in scheduler + refuse production runStrategyOnce (vitest allowed).
2. Infisical: SEC_FILING_RAG_MAX_PER_RUN=2500, TTL=24h, VECTOR_EMBED_BATCH_DELAY_MS=0, BATCH_SIZE=64, raised daily ingest/pinecone budgets.
3. Supervised reindex-10k started (all, limit 2500); CF 524 expected for long POST — lease held server-side.
4. llmFallbackModels opt-in only; learning remains user-level.
5. Prod had no broker=test accounts at apply time.
