# Codex-autofix: Parse numeric budget envs before reporting in census

**Date:** 2026-07-13
**PR:** #1495 (`agent/ag-rag-backfill-p0`)
**Agent:** Claude Code (autonomous fixer for Codex review)

## Summary

Codex P2 finding: `rag-census.ts` reported raw `process.env` values for the numeric budget
env vars (`RAG_INGEST_MAX_TEXTS_PER_DAY` and `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`) while the
ingest path sanitizes them via `numericEnv(..., min=1)` in `vector-db.ts`. If an operator set
`RAG_INGEST_MAX_TEXTS_PER_DAY=0` or a typo, the census would claim the active fuse is `0`/the typo
even though ingest is actually using `1` or the default (`1,000,000` / `10,000,000`), undermining
the diagnostic purpose.

## Changes

- **`src/lib/vector-db.ts`**: Exported `numericEnv()` (was `function`, now `export function`) so it
  can be imported by scripts outside the vector-db module.
- **`scripts/eval/rag-census.ts`**: Imported `numericEnv` and used it to resolve `RAG_INGEST_MAX_TEXTS_PER_DAY`
  and `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` to their *effective* (parsed/clamped) values. When the env
  var is set, the census now shows the resolved value with the raw env value alongside in parentheses
  (matching the pattern already used by the boolean flag entries). When unset, the default is shown as before.

## Files touched

- `src/lib/vector-db.ts` — added `export` to `numericEnv`
- `scripts/eval/rag-census.ts` — imported `numericEnv`, resolved the two budget envs

## Verification

```
npx tsc --noEmit     # 0 errors (pre-existing JSX type errors, unrelated)
npm test             # 350 files, 3927 tests passed
npm run build        # exit 0
npm run lint         # 0 errors (only pre-existing warnings)
```

## Follow-ups

- The other numeric envs in `getConfigurationSummary()` (`SEC_FILING_RAG_MAX_PER_RUN`,
  `SEC_FILING_INGEST_TTL_HOURS`) still show raw env values. They have their own parsing in
  `sec-filings.ts` with different error handling, so applying `numericEnv` there would be a
  separate concern. The Codex finding specifically called out "numeric budget envs" which are
  the two fixed here.
