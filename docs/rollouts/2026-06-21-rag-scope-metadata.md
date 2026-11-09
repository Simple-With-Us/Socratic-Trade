# RAG Scope Metadata — 2026-06-21

## Summary

Added a first-class `scope: 'shared' | 'private'` metadata field to the Pinecone RAG layer
(`src/lib/vector-db.ts`). This makes the tier distinction explicit and queryable in Pinecone
itself, replacing the implicit `userId === 'local'` sentinel as the sole tier signal for
new vectors.

## Why

The `userId === 'local'` sentinel was the only way to identify shared/public vectors. This
was invisible at the Pinecone metadata level, making it hard to audit, filter, or extend.
By adding an explicit `scope` field we get:
- A queryable tier field for future policy work (e.g. scope-based ACLs, auditing).
- Clean distinction: `scope` is authoritative for new vectors; `userId` is still written
  for backward-compat key lookup.

The owner selected migration option (b): NO reindex. Existing pre-scope vectors are still
retrieved via a Pinecone `$or` filter (`scope=='shared' OR userId=='local'`) so the full
index keeps working without any data migration.

## Files

- `src/lib/vector-db.ts` — added `SHARED_SCOPE`/`PRIVATE_SCOPE` constants + `VectorScope`
  type; updated `cleanMetadata` to write `scope`; updated `retrieveContextDetailed` shared-
  tier queries to use `$or` backward-compat filter; updated `RetrievedChunk` and `matchToChunk`
  to carry and propagate `scope`.
- `test/vector-db-scope.test.ts` — new test file covering shared-tier write (scope:'shared'),
  private-tier write (scope:'private'), scope spoofing prevention, shared-tier $or query filter
  (backward compat), private-tier userId filter, and matchToChunk scope propagation.
- `test/vector-db.test.ts` — updated the existing "retrieves matching text" test to expect
  the new `$or` filter structure for the shared-tier query instead of the bare `userId:'local'`.

## Verification

```bash
cd /Users/jay/apps/wt-rag && npx tsc --noEmit  # clean (no output)
cd /Users/jay/apps/wt-rag && npm test           # 502 tests pass across 64 files
```

## Follow-ups

- Future: consider a one-time background reindex to add `scope` to legacy vectors, which
  would let the `userId` leg of the `$or` be deprecated. Not urgent — the $or coexistence
  approach is correct indefinitely.
- The `scope` field on `RetrievedChunk` is now available for callers (e.g. the chat layer)
  to distinguish shared-vs-private provenance in citations.
