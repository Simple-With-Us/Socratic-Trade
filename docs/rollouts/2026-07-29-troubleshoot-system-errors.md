# Troubleshoot System Errors

1. **Context & Objective**: Investigated and resolved a series of system errors reported over the past few days, including Pinecone rate limits, Red Team test failures, and stale market data quotes.
2. **Changes Made**:
   - Added an in-memory TTL cache to `getAllVectorStoreStats()` in `src/lib/vector-db.ts` to reduce `listIndexes` API calls and avoid Pinecone 429 Rate Limit errors.
   - Updated the Red Team LLM retry strategy in `src/lib/red-team.ts` to `attempts: 1` (down from 2) to fail fast on transient errors, enabling a faster fallback to secondary models.
   - Fixed the corresponding tests in `test/red-team.test.ts` to reflect the new 1-attempt logic and removed obsolete retry-specific checks.
   - Added `console.warn` diagnostic logging to the empty `catch` blocks in `src/lib/data-providers.ts` (Alpaca and Nasdaq) to properly surface quote fetch errors (like invalid keys or API outages) instead of silently swallowing them and leaving stale data.
3. **Decisions & Trade-offs**: 
   - The in-memory cache for Pinecone stats uses a short TTL (10 minutes) since stats don't change rapidly and the `listIndexes` endpoint is heavily rate-limited.
   - We deliberately chose to fail-fast on the primary Red Team model to prioritize failover rather than delaying with bounded retries on a struggling provider.
4. **Verification State**: 
   - `npm run lint && npx tsc --noEmit && npm test`
   - Build passes, all tests pass.
5. **Next Steps & Blockers**: None.
