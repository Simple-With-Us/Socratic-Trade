# Rollout Note: Voyage AI SDK Purge & OpenRouter/SiliconFlow RAG Standardization

- **Summary**: Completely purged Voyage AI SDK and its dependencies from the production paths of the codebase. Standardized the production RAG embedding and reranking engine on OpenRouter (`baai/bge-m3` / `cohere/rerank-v3.5`) and SiliconFlow defaults.
- **Why**: Standardizing RAG on OpenRouter BAAI bge-m3 simplifies configuration, eliminates dependency on the Voyage SDK, and resolves the confusion of maintaining multiple overlapping embedding providers.
- **Files Touched**:
  - [vector-db.ts](file:///Users/jay/apps/trading-antigravity/src/lib/vector-db.ts) (Purged Voyage AI SDK, simplified active providers, isolated Voyage instantiation to test mode via dynamic imports)
  - [db-health.ts](file:///Users/jay/apps/trading-antigravity/src/lib/db-health.ts) (Purged Voyage AI service strings from exclusions list)
  - [rag-metering.ts](file:///Users/jay/apps/trading-antigravity/src/lib/rag-metering.ts) (Purged Voyage cost metrics and model listings, updated type parameters)
  - [route.ts](file:///Users/jay/apps/trading-antigravity/app/api/health/route.ts) (Removed Voyage checks, updated credit checking to avoid overriding health flags)
  - [connection-health-routing.test.ts](file:///Users/jay/apps/trading-antigravity/test/connection-health-routing.test.ts) (Replaced Voyage health checks with OpenRouter/SiliconFlow health routing tests)
  - [rag-embed-provider-gate.test.ts](file:///Users/jay/apps/trading-antigravity/test/rag-embed-provider-gate.test.ts) (Replaced Voyage-related precedence and pinning checks with OpenRouter/SiliconFlow test logic)
  - [query-embedding-cache.test.ts](file:///Users/jay/apps/trading-antigravity/test/query-embedding-cache.test.ts) (Fixed mocked modules to include `estimateRagDispatchCost`)
  - [vector-db-voyage-dispatch-cost.test.ts](file:///Users/jay/apps/trading-antigravity/test/vector-db-voyage-dispatch-cost.test.ts) (Replaced Voyage daily cap testing with OpenRouter daily cap checks)
- **Verification**:
  - `npx tsc --noEmit` -> Success.
  - `npm run lint` -> Success (0 errors, warnings are pre-existing/pinned).
  - `VITEST_MAX_THREADS=4 npm test` -> Success (All 4,898 tests pass).
  - `npm run build` -> Success (Next.js production build completes cleanly).
