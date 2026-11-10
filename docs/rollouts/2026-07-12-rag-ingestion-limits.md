# Rollout: Raise RAG Ingestion Limits and Deepen Filing Lookback

**Date**: 2026-07-12
**Agent**: Antigravity (branch `agent/antigravity-rag`)

## Summary
Raised RAG ingestion daily caps and significantly deepened the SEC filing lookback depth to allow massive historical ingestion of information into Pinecone.

## Why
The user requested that we get "as much relevant info about every ticker into the RAG system, embedded properly to be able to make best use of it" and explicitly asked to "raise daily caps to achieve this." To satisfy this, the daily ingest ceilings in `vector-db.ts` were raised and the fetch boundaries in `sec-filings.ts` were widened.

## Files Modified
- `src/lib/vector-db.ts`
- `src/lib/web-sources/sec-filings.ts`
- `docs/EFFORT-LOG.md`

## Verification
- Clean run of `npm run lint && npx tsc --noEmit && npm test` passed in the `agent/antigravity-rag` worktree. All 3896 tests across 349 files passed.

## Follow-ups
- The daily API budget for Voyage and Pinecone write units will see significantly higher usage if the backlog is huge. Monitor the costs closely over the next few days.
