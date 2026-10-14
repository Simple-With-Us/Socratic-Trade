# 2026-10-14 — Remove residual Pinecone and Voyage; document Qdrant + OpenRouter RAG switch

## Context & Objective

Owner requested complete removal of Pinecone and Voyage from Socratic.Trade.  Live `/api/health` already reports `ragVectorReadBackend=qdrant`, `ragVectorWriteBackend=qdrant`, and `ragEmbedProvider=openrouter`.  The prior cutover (Qdrant self-host ~2026-08-28, Stage 2 writes ~2026-09-02, OpenRouter embeddings after 2026-07-21 Voyage SDK purge) left residual package, dual-path conditionals, budget/breaker modules, write-class helpers, filter translators, scripts, and outdated docs.

Goal: eliminate all residual Pinecone/Voyage surface so the only vector path is Qdrant and the only embed path is OpenRouter, and record the switch for future agents.

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
- Updated PROJECT.md architecture bullet and M4 from "Pinecone user-or-public filter, Voyage jitter" to "Qdrant multi-tenant vector store, OpenRouter embeddings".
- Cleaned residual mentions from README.md and .env.example comments.
- Updated STATUS.md and PLAN.md per AGENTS.md.

Exact file list and diffs are in the PR.

## Decisions & Trade-offs

- No dual-backend fallback retained.  The live path has been Qdrant-only for weeks; residual code was a maintenance and audit hazard.
- Filter translation (`pinecone-filter-to-qdrant.ts`) was rewritten to native Qdrant filters rather than deleted blindly, so retrieval semantics stay identical.
- Historical rollout notes and copy scripts are left in git history; only active surface is purged.
- Lockfile update happens on `npm install` during land.sh.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Health endpoint continues to report qdrant / openrouter.  No runtime references to Pinecone or Voyage remain in active code paths.

## Next Steps & Blockers

- Land via PR and confirm Coolify deploy (RTH latch may delay weekday daytime builds).
- Confirm Infisical no longer holds unused PINECONE_API_KEY / VOYAGE_API_KEY (or mark them retired).
- Spot-check RAG retrieval and ingest after deploy.

## Zero-Code Findings

None.  This is the residual cleanup of the already-shipped Qdrant + OpenRouter cutover.
