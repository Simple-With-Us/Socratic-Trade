# 2026-10-14 — Remove residual Pinecone and Voyage; document Qdrant + OpenRouter RAG switch; make RAG mandatory for every proposal

## Context & Objective

Owner requested complete removal of Pinecone and Voyage from Socratic.Trade, and that RAG must be used for every strategy proposal (not optionally).

Live `/api/health` already reports `ragVectorReadBackend=qdrant`, `ragVectorWriteBackend=qdrant`, and `ragEmbedProvider=openrouter`.  The prior cutover (Qdrant self-host ~2026-08-28, Stage 2 writes ~2026-09-02, OpenRouter embeddings after 2026-07-21 Voyage SDK purge) left residual package, dual-path conditionals, budget/breaker modules, write-class helpers, filter translators, scripts, and outdated docs.

Current proposal path treats RAG as advisory: retrieval is skipped on LLM budget, timeouts/errors log a warning and continue, empty context still allows proposals, and evidence budget can drop it.  It never gates sizing or execution.

Goals:
1. Eliminate all residual Pinecone/Voyage surface so the only vector path is Qdrant and the only embed path is OpenRouter.
2. Make successful RAG retrieval a hard prerequisite for every proposal (especially openings).  Fail-closed if unavailable or empty for opening candidates.
3. Record both for future agents.

## Changes Made

- Dropped `@pinecone-database/pinecone` from package.json (and lockfile on land).
- Deleted residual modules:
  - `src/lib/rag/pinecone-write-class.ts`
  - `src/lib/vector-store/pinecone-filter-to-qdrant.ts` (callers rewritten to native Qdrant filters)
  - `src/lib/pinecone-wu-breaker.ts`, `pinecone-write-budget.ts`, `pinecone-monthly-pace.ts`, `pinecone-trial-window.ts`
  - `scripts/qdrant/pinecone-to-qdrant-copy.py`
  - related eval scripts and tests that only exercised the old path
- Stripped all Pinecone client, write/read branches, WU budgets, Voyage/SiliconFlow fallbacks, and related comments from `src/lib/vector-db.ts` and supporting modules (health, metering, knobs, db-api-keys, scheduler, next.config.mjs).
- Forced Qdrant + OpenRouter only.
- **Mandatory RAG for proposals**:
  - In `runStrategyOnce`: always attempt `retrieveContextDetailed` for in-scope candidates when a proposal step will run (do not skip RAG solely because of LLM budget if proposals are desired).
  - After retrieval: if retrieval fails or any opening candidate has zero usable chunks, do not call `proposeTrades`.  Audit `rag_required_missing` and finish the run with zero proposals (or suppressed).
  - In `proposeTrades`: require non-empty `retrievedFinancialContext` / per-candidate evidence before the LLM call; abort otherwise.
  - Deterministic protective exits (stops, trims) remain independent of RAG.
- Updated PROJECT.md architecture bullet and M4 from "Pinecone user-or-public filter, Voyage jitter" to "Qdrant multi-tenant vector store, OpenRouter embeddings; RAG required for every proposal".
- Cleaned residual mentions from README.md and .env.example comments.
- Updated STATUS.md and PLAN.md per AGENTS.md.

Exact file list and diffs are in the PR.

## Decisions & Trade-offs

- No dual-backend fallback retained.  The live path has been Qdrant-only for weeks; residual code was a maintenance and audit hazard.
- Filter translation (`pinecone-filter-to-qdrant.ts`) was rewritten to native Qdrant filters rather than deleted blindly, so retrieval semantics stay identical.
- RAG is now fail-closed for openings.  Empty or failed retrieval produces zero proposals rather than an advisory-only run.  Protective exits stay available so risk reduction is not blocked by corpus gaps.
- Historical rollout notes and copy scripts are left in git history; only active surface is purged.
- Lockfile update happens on `npm install` during land.sh.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Health endpoint continues to report qdrant / openrouter.  No runtime references to Pinecone or Voyage remain in active code paths.  Strategy runs with forced empty retrieval produce zero proposals and the new audit receipt.

## Next Steps & Blockers

- Land via PR and confirm Coolify deploy (RTH latch may delay weekday daytime builds).
- Confirm Infisical no longer holds unused PINECONE_API_KEY / VOYAGE_API_KEY (or mark them retired).
- Spot-check RAG retrieval, ingest, and a strategy run after deploy (confirm proposals only appear when evidence is present).

## Zero-Code Findings

None.  This is the residual cleanup of the already-shipped Qdrant + OpenRouter cutover plus the new mandatory-RAG gate for proposals.
