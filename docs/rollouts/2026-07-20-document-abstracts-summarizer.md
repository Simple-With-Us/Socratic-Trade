# RAG & Database Data Strategy Expansion & Document Summarizer Engine

## Summary
Designed and implemented Layer 3 (Derived Abstracts & Summaries) of the RAG data expansion architecture. Added database migration 55 (`document_abstracts`), created `src/lib/db-document-abstracts.ts` for CRUD operations, implemented `src/lib/rag/document-summarizer.ts` for generating cited abstracts linking back to Layer 1 raw `source_chunk_ids` and embedding them into the vector store, and added full unit test coverage in `test/document-summarizer.test.ts`.

## Why
The owner requested an expert panel design and execution plan for expanding our RAG database across SEC filings, earnings call transcripts, structured facts, and derived summaries/abstracts. The 3-layer model ensures numerical facts remain exact in SQL while narrative abstracts are stored with strict provenance back to raw source chunks.

## Files Touched
- `src/lib/db.ts`: Added version 55 migration for `document_abstracts` table and re-exported `db-document-abstracts`.
- `src/lib/db-document-abstracts.ts`: Added CRUD functions (`insertDocumentAbstract`, `getDocumentAbstractsForTicker`, `getDocumentAbstractByAccession`).
- `src/lib/rag/document-summarizer.ts`: Added summarization engine for generating cited abstracts and embedding them under `doc_type: "document-summary"` or `"earnings-summary"`.
- `test/document-summarizer.test.ts`: Added unit tests verifying abstract creation, database storage, chunk ID linking, and duplicate suppression.

## Verification
- `npx vitest run test/document-summarizer.test.ts`: 2/2 tests passed in 277ms.
- `npx tsc --noEmit`: 0 errors.
