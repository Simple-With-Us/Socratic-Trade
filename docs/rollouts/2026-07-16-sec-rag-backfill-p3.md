# Rollout Note: SEC/RAG Backfill — Phase 3 — HTML Parsing and Chunker

## Summary
Implemented cheerio-based HTML parser and section-aware chunker logic to extract text, reconstruct clean tables, normalize headers, and chunk filings efficiently.

## Why
Required to accurately parse complex HTML bodies of SEC filings (10-K/10-Q) without stylesheet pollution, hidden elements, or raw markup, and reconstruct tabular structures in clean Markdown pipe format. Also required section-aware chunking to prevent content overlap across SEC document boundaries and token-aware length estimation for Voyage AI models.

## Touched Files
- `src/lib/web-sources/sec-parser.ts` [NEW]
- `src/lib/rag/chunk.ts` [MODIFY]
- `src/lib/web-sources/sec-filings.ts` [MODIFY]
- `test/sec-parser.test.ts` [NEW]
- `test/sec-filings.test.ts` [MODIFY]

## Verification
Ran the following tests and commands under Node 24:
1. `npx vitest run test/sec-parser.test.ts` (Passed 6/6 tests)
2. `npx vitest run test/sec-filings.test.ts` (Passed 44/44 tests)
3. `npx tsc --noEmit` (Passed with zero errors)
4. `npm run lint` (Passed with zero errors, pre-existing warnings preserved)
5. `npm run build` (Passed Next.js production build check)

## Follow-ups
Phase 4: Resumable worker integration and RAG ingest job queueing (claimed under CODEX or future Antigravity sessions).

### Codex autofix — Round 1 (2026-07-16)
Addressed 5 P2 findings from Codex review of sec-parser.ts. See STATUS.md for summary.

### Codex autofix — Round 2 (2026-07-16)
Addressed 5 additional P2 findings:
- Restrict table rows to current table level (skip nested tr elements via `.closest("table")` check)
- Avoid classifying wrapper containers as headings (require `!hasBlockChildren` for block tags)
- Preserve mixed text node siblings around child blocks (emit text node content in recursion)
- Normalize table colspan (repeat cell text for each spanned column)
- Only repeat real `<th>` header rows when splitting large tables across token limits

Verification: `npx tsc --noEmit` clean, all 4610 tests pass, `npm run build` clean.

### Codex autofix — Round 3 (2026-07-16)
Addressed 4 additional P2 findings:
- Preserve nested table content before stripping outer cells (process via `collectBlocks` before `.remove()`)
- Preserve BR separators in prose blocks (replace `<br>` with space in leaf text extraction)
- Detect item headings encoded as layout tables (check small tables for heading text before Markdown conversion)
- Recognize headings in non-block EDGAR wrappers (added `HEADING_WRAPPER_TAGS`: center, font, span, b, etc.)

2 findings remain deferred for owner decision (form-specific Item 1 titles; parser-versioned accession skip).
