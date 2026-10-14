# 2026-10-14 — Remove residual Pinecone and Voyage; document Qdrant + OpenRouter RAG switch; make RAG mandatory for every proposal; expand and optimize ingestion

## Context & Objective

Owner requested:
1. Complete removal of Pinecone and Voyage.
2. RAG must be used for every strategy proposal (not optionally).
3. Expand RAG to ingest more data, and optimize both the data selected and how it is ingested.

Live `/api/health` already reports `ragVectorReadBackend=qdrant`, `ragVectorWriteBackend=qdrant`, and `ragEmbedProvider=openrouter`.  The prior cutover left residual surface that is being purged.

Current proposal path treats RAG as advisory.  Current ingest is a solid SEC baseline (latest 1	imes10-K, 4×10-Q, 2×8-K, 1 DEF 14A, 1 S-1, 2 ownership forms + material exhibits) with priority overlay (held > watchlist > recent scan > universe), extractive summarizer, and gated transcripts.  It is deliberately breadth-constrained and RTH-aware.

Goals:
1. Eliminate residual Pinecone/Voyage surface.
2. Make successful RAG retrieval a hard prerequisite for every proposal (especially openings).  Fail-closed if unavailable or empty for opening candidates.
3. Expand high-signal coverage and optimize selection + ingest process so the mandatory gate has more useful evidence.
4. Record all of it for future agents.

## Changes Made

- Dropped `@pinecone-database/pinecone` from package.json (and lockfile on land).
- Deleted residual modules (pinecone-write-class.ts, pinecone-filter-to-qdrant.ts, pinecone-wu-breaker.ts, related budget/pace/trial modules, copy script, old eval scripts).
- Stripped dual-path conditionals, WU budgets, and Voyage/SiliconFlow fallbacks from vector-db.ts and supporting modules.  Forced Qdrant + OpenRouter only.
- **Mandatory RAG for proposals**:
  - Always attempt retrieveContextDetailed for in-scope candidates when a proposal step will run.
  - If retrieval fails or any opening candidate has zero usable chunks, do not call proposeTrades.  Audit rag_required_missing and finish with zero proposals.
  - Require non-empty retrieved evidence inside proposeTrades before the LLM call.
  - Deterministic protective exits remain independent of RAG.
- **Ingest expansion and optimization (planned / incremental)**:
  - Deepen history for held + watchlist + recent high-conviction candidates (more 10-Qs, older material 8-Ks, more Form 4s) while keeping the broad universe shallow.
  - Raise transcript coverage for the same priority set (more symbols, longer history) under existing monthly caps.
  - Add selective high-signal sources where cheap and clean: more 13-D/G activist filings, company presentations / investor decks when URLs are stable, and targeted macro/news only for portfolio symbols (not the whole market).
  - Optimize selection: boost priority further for symbols with recent large moves, open proposals, or low corpus coverage (corpus-gap signal).  Prefer extractive highlights + structured cards over full low-signal sections.
  - Optimize process: tighter section-aware chunking by doc type (larger for MD&A, smaller for 8-K items), stronger content-hash + near-dup filtering before embed, incremental re-embed only on model or highlight-algorithm change, and keep daily budgets + RTH throttle so expansion does not starve the worker.
- Updated PROJECT.md architecture bullet and M4 to reflect Qdrant + OpenRouter and mandatory RAG.
- Cleaned residual mentions from README.md and .env.example comments.
- Updated STATUS.md and PLAN.md per AGENTS.md.

Exact file list and diffs are in the PR.  Ingest expansions will land as follow-on commits or a sequenced second PR once the mandatory gate and residual purge are verified.

## Decisions & Trade-offs

- No dual-backend fallback retained.
- RAG is fail-closed for openings.  Protective exits stay available.
- Expansion is priority-first, not uniform.  Deepening the whole 1,000-issuer universe would exhaust the worker and daily budgets without improving proposal quality.  Held/watchlist/scan symbols get the extra depth and transcripts first.
- Extractive (no generative LLM on ingest) remains the default for summaries so cost and latency stay predictable.
- Historical rollout notes stay in git history.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Health continues to report qdrant / openrouter.  Strategy runs with forced empty retrieval produce zero proposals and the new audit receipt.  After ingest expansions, spot-check that priority symbols have deeper coverage and that the mandatory gate passes for them.

## Next Steps & Blockers

- Finish residual purge + mandatory gate in this PR (Mac seat preferred for vector-db.ts and strategy.ts).
- Land and confirm deploy.
- Sequence the ingest expansion: first deepen held/watchlist, then transcripts, then selective new sources.  Watch daily write budgets and worker lag.
- Confirm Infisical no longer holds unused PINECONE/VOYAGE keys.

## Zero-Code Findings

None.  This combines residual cleanup, the mandatory-RAG gate, and a priority-first plan to ingest more high-signal data more efficiently.
