# FTS stale index must not delete a reused rowid

## Context & Objective

#2885 moved FTS idempotency to `document_chunks_fts_index` + `DELETE WHERE rowid = ?`.  `document-summarizer` still wiped `document_chunks_fts` without the index.  FTS5 reuses the current max rowid after that delete.  A later same-hash remirror (model-stamp refresh, same extractive text) then deleted whoever now owned that rowid.

## Changes Made

- `replaceDocumentChunkFtsOccurrence` only deletes when the live FTS row still matches the occurrence identity.
- `deleteDocumentChunkFtsBySourceAccession` drops FTS rows and index keys in one transaction.
- Summarizer refresh uses that helper.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/sec-ingest-worker.test.ts test/document-summarizer.test.ts test/persist-local-complete.test.ts
npx eslint src/lib/db-learning.ts src/lib/rag/document-summarizer.ts test/sec-ingest-worker.test.ts test/document-summarizer.test.ts
```

42 tests passed.  `tsc` clean.  lint 0 errors.

## Next Steps & Blockers

Owner merge when green.  Did not touch #2861.
