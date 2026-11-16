# 2026-08-31 Rollout: Default RAG Reads to Qdrant & Strategy Run Fixes

## 1. Context & Objective
The owner reported failing strategy runs in **Activity > Strategy Runs** with error messages indicating runs were closed because they were still marked running after process restarts (sitting stuck for ~31 minutes), accompanied by alerts in the **Alerts Center** for Pinecone rate limiting (*"Pinecone connection failed — This strategy run stopped because a provider rate-limited the request"* / *"Usage limit hit: Pinecone provider rate limit"*).  With the migration of the vector database to self-hosted Qdrant on Hetzner (`socratic-trade` collection with 800k+ vectors), this change fully cuts over default RAG vector reads to Qdrant, decouples RAG retrieval execution from Pinecone client/index prerequisites, adds graceful 429 handling for background Pinecone reconciliation, and ensures orphaned strategy runs from previous process lifecycles are swept immediately on boot.

## 2. Changes Made
- **Default RAG Vector Read Backend to Qdrant**:
  - In `src/lib/server-knobs.ts`, updated `SERVER_KNOBS_CATALOG` so `RAG_VECTOR_READ_QDRANT` has `defaultValue: true`.
  - In `src/lib/vector-store/qdrant-read.ts`, updated `vectorReadBackend()` to resolve `enabled = true` by default when neither database overrides nor environment variables explicitly disable it.
- **Decouple RAG Retrieval from Pinecone Prerequisites**:
  - In `src/lib/vector-db.ts` (`retrieveContextDetailed`), resolved `readBackend` prior to checking provider connectivity.  When `readBackend === "qdrant"`, retrieval no longer checks for `!pc` (Pinecone client) and bypasses all Pinecone control-plane preflight calls (`indexExists`, `assertIndexMetric`).
  - In `src/lib/vector-db.ts` (`denseTierQuery` & `denseResults`), allowed dense candidate queries against Qdrant (`qdrantQueryTier`) to execute without initializing Pinecone index handles.
- **Graceful Pinecone Rate-Limit Handling in Scheduler Reconcile**:
  - In `src/lib/vector-db.ts` (`reconcileManagedVectorRecordsUnlocked`), wrapped `getCurrentVectorProviderAuthority` and `inventoryVectorRecordsByMetadata` in try/catch blocks that return `emptyReconcileResult(dryRun, true)` when Pinecone hits rate limits (429, monthly WU budget exhaustion, connection failure) or lacks provider authority, preventing unhandled exceptions from crashing background ticks.
- **Immediate Startup Sweep for Prior-Process Orphaned Runs**:
  - In `src/lib/db-execution.ts` (`markStaleRunningRuns`), updated the query to `started_at < cutoff OR started_at < restartCutoff` (where `restartCutoff = processStartedMs - 2000ms`).  Orphaned runs from a previous container or process restart are now swept immediately on the first tick instead of lingering for 30 minutes, freeing concurrency locks immediately.
  - Bypassed the recent-audit activity check when `cause === "process_restarted_mid_run"`.
- **Break Circular Dependency in Strategy Run Execution**:
  - Extracted process-local execution heartbeat management into standalone dependency-free leaf `src/lib/strategy-run-execution-registry.ts`.
  - Re-exported from `src/lib/strategy-run-requests.ts` and imported directly in `src/lib/db-execution.ts`, preventing Next.js page data collection TDZ errors.
- **Provider Authority Fallback on Qdrant Reads**:
  - Added `durableProviderAuthority()` in `src/lib/db-vector-commits.ts` to derive active provider authority directly from committed SQLite receipts when in-memory Pinecone cache is uninitialized.
  - Added `skipMissingPineconeAlert` option to `getClients()` in `src/lib/vector-db.ts` to prevent false missing-Pinecone alerts when reading from Qdrant.
  - Required `QDRANT_API_KEY` for remote endpoints in `src/lib/vector-store/qdrant-read.ts`.
- **Test Coverage**:
  - Created `test/vector-db-qdrant-retrieval.test.ts` to hermetically test `retrieveContextDetailed` and `reconcileManagedVectorRecords` without Pinecone keys.
  - Updated `test/qdrant-read.test.ts` to assert the new catalog and function default (`true` / `"qdrant"`), along with remote endpoint API key enforcement.
  - Updated `test/stale-running-runs.test.ts` to verify immediate sweeping of prior-process runs under 30 minutes old.

### Touched Files
- `src/lib/server-knobs.ts`
- `src/lib/vector-store/qdrant-read.ts`
- `src/lib/vector-db.ts`
- `src/lib/db-execution.ts`
- `src/lib/db-vector-commits.ts`
- `src/lib/strategy-run-execution-registry.ts`
- `src/lib/strategy-run-requests.ts`
- `test/qdrant-read.test.ts`
- `test/stale-running-runs.test.ts`
- `test/vector-db-qdrant-retrieval.test.ts`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

## 3. Decisions & Trade-offs
- **Self-Contained Qdrant Retrieval**: When `RAG_VECTOR_READ_QDRANT` is enabled, Qdrant is the sole vector retrieval backend used during strategy generation and chat.  Embedding generation (Voyage / OpenRouter) is still required to embed query vectors, but Pinecone client availability and Pinecone index metrics are no longer required for retrieval.
- **Fail-Safe Reconciliation**: Hourly reconciliation continues attempting to inventory Pinecone if configured, but treats 429 rate limits as transient deferred cycles rather than fatal scheduler failures.
- **Immediate Sweep Safety**: Runs started by the current process instance (`started_at >= processStartedMs - 2000ms`) continue using the full 30-minute stale run threshold to allow legitimate in-progress runs to complete.

## 4. Verification State
- `npm run lint`: Passed (0 errors).
- `npx tsc --noEmit`: Passed (0 errors).
- `npm test`: Passed (7,696 tests across 700 files passed, 51 skipped, 0 failures).
- `npm run build`: Passed (clean Next.js production build with all static/dynamic routes compiled).

## 5. Next Steps & Blockers
- Merge PR to `main` and allow post-close RTH deploy drain (or hotfix) to deploy to production.
- Verify live SHA via `scripts/verify-deploy-sha.sh`.
