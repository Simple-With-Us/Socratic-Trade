# 2026-11-12 — Pinecone removal inventory and dead write-class helpers (ST-4598)

## Context & Objective

Full Pinecone removal is a multi-slice effort because the client is still the fallback read and the explicit write rollback.  This change records the inventory and deletes only helpers with no callers.

## Changes Made

Added `docs/plans/pinecone-removal.md` with every runtime touchpoint, the ordered slices, and rollback.  Removed `writesProcessedToPinecone`, `isTranscriptRoleCode`, and `filingTextFromParsedSections` from `src/lib/rag/pinecone-write-class.ts`.  Those three exports had no references in source, routes, scripts, or tests.  `writesProcessedToPinecone` was true for every write class.  The live read (`index.query`) and the live write-class callers stay.

Touched files:

- `docs/plans/pinecone-removal.md`
- `docs/rollouts/2026-11-12-pinecone-removal-plan.md`
- `src/lib/rag/pinecone-write-class.ts`
- `test/pinecone-write-class.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`

## Decisions & Trade-offs

Did not uninstall `@pinecone-database/pinecone`.  Did not change `vectorReadBackend` or `vectorWriteBackend`.  Did not flip `RAG_PINECONE_WRITE_CLASS`.  Did not edit admin routes, health, keys, or evals.  Did not drop SQLite columns `pinecone_write_class` and `pinecone_vector_count`.  Closed draft #5093 is not replayed.  That branch deleted the write-class module, which now has callers.

## Verification State

Node on this VM is v22.23.4. `.nvmrc` pins 26, and 26 is not installed here.  The commands below ran on 22.

```
npx tsc --noEmit
```

Exit 0.

```
npm run lint
```

Exit 0. 869 warnings and 0 errors.  The warnings are the grandfathered backlog.

```
npx vitest run test/pinecone-write-class.test.ts
```

Exit 0. 8 passed.

```
npm test
```

Exit 1 after 1331.99s.  889 files passed, 12 failed, 1 skipped (902).  10228 tests passed, 19 failed, 41 skipped (10288).  The failures are `alpha-vantage-key-pool`, `automerge-reusable-pin`, `chat-llm`, `data-providers`, `framework-review`, `lesson-vectors`, `notify-body-tiers`, `notify-user-creds`, `openrouter-credits`, `persistence-notification`, `red-team`, and `server-metrics`.  None of them import the deleted helpers.  They fail on missing provider keys, host metadata, or notification delivery.  The write-class suite is green.

## Next Steps & Blockers

Slice 1 in `docs/plans/pinecone-removal.md` makes retrieval unable to select Pinecone, then deletes `index.query`.  Do not start that slice until this one is on `main`.  Do not delete Infisical `PINECONE_API_KEY` from a pull request.

## Zero-Code Findings

Production's active embed model resolves to `baai/bge-m3`, which has an embed-space filter, so reads follow `vectorReadBackend`.  That function still returns `pinecone` when Qdrant is not configured or the knob selects Pinecone.  `retrieveContextDetailed` also forces Pinecone when the filter is empty (`voyage-finance-2`).  Voyage is not a production embed provider outside tests.  The empty-filter branch is still compiled and still tested, so it is not dead.
