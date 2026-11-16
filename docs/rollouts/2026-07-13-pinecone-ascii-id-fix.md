# Pinecone Vector ID ASCII Sanitization Fix

## Summary
Resolved a Pinecone connection failure where the vector upsert failed due to non-ASCII / special characters in the vector ID (`upsert: Vector ID must be ASCII...`).

## Why
Pinecone's API restricts Vector IDs to ASCII characters (alphanumeric, plus standard characters like `_`, `.`, `:`, `-`). Constructed vector IDs for SEC filings include accession numbers, document titles, and section headers which frequently contain non-breaking spaces (`\xa0`), normal spaces, parentheses, or other non-ASCII characters. 

## Files Changed
* [vector-db.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/vector-db.ts):
  * Added `sanitizeVectorId` helper to replace non-ASCII / special characters with `_` and limit to 512 bytes.
  * **Fixed tail-truncation (Codex autofix):** The initial `.slice(0, 512)` dropped unique suffixes (ordinal, parserRev, embedRev) when documentName/section had long common prefixes, causing multiple chunks to share truncated IDs. Replaced with tail-preserving clamp: first 384 chars + `".."` + last 126 chars.
  * Sanitized `vectorId` inside `storeDocument` for both document metadata mapping and database occurrences record insertion.
  * Ensured `contextId` sanitizes custom `vector_id` metadata.
* [vector-db.test.ts](file:///Users/jay/apps/trading-ag-rag/test/vector-db.test.ts):
  * Added unit test verifying special character substitution, non-breaking space replacement, and length clamping in `sanitizeVectorId`.

## Verification
* Executed the new and existing unit tests:
  ```bash
  npx vitest run test/vector-db.test.ts
  ```
  Output: `15 passed (15)`
