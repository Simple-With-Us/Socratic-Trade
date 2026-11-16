# 2026-07-18 SEC/RAG Parser & Chunker Hardening

## Summary
Completed the SEC/RAG parser and chunker hardening by resolving outstanding structural and edge-case issues identified in recent parser reviews. Improved deterministic provenance, prevented runaway token allocation, handled XBRL structural anomalies securely, and fixed hidden content / nested table processing.

## Why
A hostile review of the v2 parser integration surfaced several vulnerabilities: forgeable tokenizer/provenance gates, mutable payload-unbound eligibility (date fallback leaks), non-interruptible/pre-allocation bounds (unbounded table iteration), malformed or missing structured XBRL evidence leading to SQLite insertion issues, stylesheet-hidden poisoning, and nested-table extraction loss.

## Files Touched
- `src/lib/rag/chunk.ts`: Added strict deterministic date requirement and explicit validation bounds for `maxTokens`.
- `src/lib/web-sources/sec-parser.ts`: Clamped table colspan/rowspan iteration to bounded maximums. Stripped stylesheet-hidden nodes using strict opacity/font-size constraints. Altered nested table node extraction to replace with markdown representations inline, preserving reading order and structures.
- `src/lib/web-sources/sec-facts.ts`: Shielded against SQLite insertion of NaN/nulls and enforced strict structure checking for XBRL attributes `filed`, `shares`, and `price`.
- `test/rag-chunk.test.ts`: Brought test fixtures up to date to conform to strict deterministic `published_at` rules.

## Verification
- Run `npm run lint` - Success
- Run `npx tsc --noEmit` - Success
- Run `npm test -- test/rag-chunk.test.ts` - Success
- Run `npm run build` - Success

## 2026-07-19 review-thread closeout (CLAUDE, on AG's lane — owner-directed merge sweep)

Two of the four codex-connector P2 threads fixed; two answered with analysis.

**Fixed — "Match only truly hidden zero styles".** `/opacity\s*:\s*0/i` and `/font-size\s*:\s*0/i`
matched any value *starting* with `0`, so the extremely common `opacity:0.5` and
`font-size:0.875rem` were read as hidden. Because `collectBlocks` returns immediately on a hidden
node, each false positive dropped that element's **entire subtree** — and filings routinely wrap
real prose and tables in inline-styled elements, so whole sections could vanish from parsed evidence
with no error surfaced anywhere. Replaced with `isHiddenStyle()`, which parses the numeric value and
requires an exact zero (`0`, `0.0`, `.0`, `0px`, …). Exported so the boundary is directly testable.

**Fixed — "Escape nested table pipes before wrapping outer cells".** A nested table's Markdown
carries its own `|` delimiters and is injected into a single outer `<td>`, which the outer renderer
then wraps in `|` again without escaping — splitting one cell into extra columns and destroying the
row's alignment (and therefore every value's column meaning). Nested Markdown is now pipe-escaped
(`\|`, per GFM) before injection.

**Not fixed — "Preserve nested table headings as section breaks".** Valid: a heading such as
`Item 1A. Risk Factors` inside a nested layout table is flattened to cell text, so following prose
stays under the previous section. The fix requires emitting nested heading blocks into the *main*
block stream rather than the cell, which changes reading order and section-boundary semantics for
every nested-table filing — a design change to the block pipeline that belongs with its own
fixture-backed evaluation, not bundled into a review-fix pass. Left for the owning lane.

**Not fixed — "Keep the provenance requirement type-safe".** Valid: the new runtime guard throws
for a `ChunkInput` lacking `published_at` while the field is still optional in the type, so callers
compile and fail at runtime. Making it required is a shared-type change rippling through every
`chunkDocument`/`storeDocument` caller; that is the right fix but is broader than this PR and should
land as its own typed migration.

Tests added to `test/sec-parser.test.ts`: exact-zero vs decimal style matching (unit), a parse-level
assertion that `opacity:0.5` / `font-size:0.875rem` content survives while `opacity:0` is dropped,
and a nested-table pipe-escaping assertion that the outer row keeps its column count.
