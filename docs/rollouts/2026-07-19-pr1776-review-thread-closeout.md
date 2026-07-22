# 2026-07-19 PR #1776 review-thread closeout (all 4 codex-connector findings)

## Summary

PR #1776 (`agent/ag-sec-parser-hardening`, "Hardening SEC/RAG parser and chunker") carried four
open `chatgpt-codex-connector` P2 review threads. A prior same-day session (commit `8918da21`,
recorded in `docs/rollouts/2026-07-18-sec-parser-hardening.md`'s "2026-07-19 review-thread
closeout" section) fixed two of the four and answered the other two as valid-but-deferred. This
session fixes the remaining two, so all four are now resolved with a code fix (none were false
positives — Codex was right on all four).

## Why

The two deferred findings were correctly identified as real bugs in the prior session's analysis;
they were deferred because each looked like it could ripple beyond a "review-fix pass" (a
cross-cutting type change, and a block-pipeline reading-order change). Re-investigating both
against the actual current code showed the blast radius was smaller than feared:

**"Keep the provenance requirement type-safe" (`src/lib/rag/chunk.ts:267`).** `chunkDocument`
already throws synchronously (`"doc.published_at is required for provenance"`) when
`doc.published_at` is missing, but `ChunkInput.published_at` was still typed optional, so a
caller could compile clean and crash at runtime. Grepped every `chunkDocument`/`storeDocument`
call site (`src/lib/vector-db.ts`, `src/lib/web-sources/sec-filings.ts`,
`src/lib/web-sources/sec8k.ts`, `src/lib/web-sources/fmp-transcripts.ts`,
`src/lib/earningscalls-transcripts.ts`, `src/lib/rag/sec-ingest-worker.ts`,
`src/lib/rag/corpus-reembed.ts`, and every test fixture across ~14 test files) and confirmed
every one of them already always supplies `published_at` (directly, or via a `?? fallback ??
new Date().toISOString()` chain). Made the field required on `ChunkInput`. `npx tsc --noEmit`
came back clean with **zero** call sites needing a change — the runtime guard was defensive, not
load-bearing for any real caller, so this was a pure type-tightening with no fallout. No narrower
type or design change was needed; the straightforward fix was correct.

**"Preserve nested table headings as section breaks" (`src/lib/web-sources/sec-parser.ts`,
`collectBlocks`).** When a nested layout table inside an outer table cell is itself an SEC item
heading (EDGAR commonly encodes `Item 1A. Risk Factors` as a single-row, single/double-cell
layout table), `collectBlocks`'s own `table` branch already classifies it correctly as a heading
`ParsedBlock` (with `itemCode`/`itemTitle`) when recursed into — but the nested-table conversion
site only ever did `nestedBlocks.map(b => b.text).join(...)`, discarding the block's `type` and
folding the heading text back into plain cell prose. `parseFilingHtml`'s section-grouping loop
only starts a new section on a block with `type === "heading" && itemCode`, so the heading's
signal was lost and everything that followed stayed misattributed to whatever section was active
before the outer table (often `GENERAL`).

Fix: split `nestedBlocks` by type at the point of discovery — any nested block that resolved to
`type === "heading" && itemCode` (at any nesting depth, since the recursion is uniform) is pushed
directly into the enclosing document's real `blocks` stream as a genuine section-break block;
only the remaining (non-heading) nested content is folded into the outer cell's text as before
(with finding #4's pipe-escaping still applied to that remainder). When a nested table resolves
to *only* a heading (the common single-cell-heading-table case), the cell is left with no residual
markdown at all instead of an empty `\n\n\n\n` gap.

**Known limitation, documented rather than silently accepted:** because the entire outer table is
still emitted as one atomic block (appended only after all of its rows/cells are processed), any
content that appears in the *same* outer table *before* the nested heading (in an earlier row, or
earlier in the same cell) is now attributed to the *new* section rather than the old one — a
different misattribution than before (previously everything stayed in the old section; now
everything in that outer table attaches to the new one). In the common real-world case a heading
introduces the content that follows it (so there is little or no "before" content in the same
wrapper table), so this is a net improvement, not a wash. A fully order-correct fix would require
splitting the outer table's grid at the heading row and emitting two separate table blocks around
the heading — that is the "bigger design change to the block pipeline" the prior session flagged,
and remains a legitimate follow-up if a fixture-backed case turns up where the leading-content
case actually matters in practice.

Findings #1 ("Match only truly hidden zero styles") and #4 ("Escape nested table pipes before
wrapping outer cells") were verified as already correctly fixed by the prior session's commit
`8918da21` — re-read against the current code, both match their described mechanisms exactly
(`isHiddenStyle` parses the numeric value and requires an exact zero; nested-table markdown is
pipe-escaped with `.replace(/\|/g, "\\|")` before injection into the outer cell). No changes
needed there. Also verified the "escape newlines" half of finding #4's ask is already structurally
covered: the outer cell's `cellText` computation applies `.replace(/\s+/g, " ")` (line ~326) to the
full cell text *after* nested-table injection, which collapses any newlines the nested table's
markdown carries into single spaces before the cell is ever wrapped — so a literal newline can
never survive into the outer table's row/column structure regardless of nested-table content.

## Files

- `src/lib/rag/chunk.ts` — `ChunkInput.published_at` changed from optional to required, with a
  comment explaining why and that every real call site already satisfies it.
- `src/lib/web-sources/sec-parser.ts` — `collectBlocks`'s nested-table conversion now splits
  heading sub-blocks into the real `blocks` stream instead of flattening them into cell prose;
  empty nested-table remainders no longer leave a blank `\n\n\n\n` gap.
- `test/sec-parser.test.ts` — two new tests: (1) an Item heading nested inside an outer table cell
  produces its own section with correct title/text, and content that followed the nested heading
  is attributed to the new section rather than staying under the prior one; (2) the heading's own
  marker text is not duplicated as stray table prose once extracted.

## Verification

Run from `.claude/worktrees/fix-pr1776-sec-parser` with
`PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (node26 ABI trap — see root `CLAUDE.md`):

- `npx tsc --noEmit` — clean, 0 errors (confirms the `ChunkInput.published_at` tightening has zero
  call-site fallout).
- `npx vitest run test/sec-parser.test.ts --no-file-parallelism` — 16/16 passed (14 pre-existing +
  2 new).
- `npx vitest run test/rag-chunk.test.ts test/sec-parser.test.ts test/sec-filings.test.ts
  test/sec-ingest-worker.test.ts --no-file-parallelism` — 69/69 passed.
- `npx vitest run test/corpus-reembed.test.ts test/earningscalls-transcripts.test.ts
  test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts
  test/vector-db-chunk-cap.test.ts test/sec-backfill-p2.test.ts test/sec-ingest-seeder.test.ts
  --no-file-parallelism` — 109/109 passed.
- `npx vitest run test/vector-db-document-receipts.test.ts test/sec8k-full-body.test.ts
  --no-file-parallelism` — 30/30 passed.
- `npm run lint` — 0 errors (583 pre-existing grandfathered warnings, unrelated to this change).
- `npm test` (full suite) and `npm run build` — run as part of `scripts/land.sh`'s gate; see that
  script's own pass/fail for the authoritative full-tree result at push time.

## Follow-ups

- The documented "before content in the same outer table as the nested heading" limitation above
  is a legitimate, bounded follow-up (outer-table splitting at the heading row) if a real filing
  fixture ever demonstrates it matters in practice. Not blocking — it is strictly better than the
  pre-fix behavior (heading silently dropped, no section change ever happened) in the common case.
- Coordinated with the earlier session's PR-thread replies via `docs/rollouts/2026-07-18-sec-parser-hardening.md`'s "2026-07-19 review-thread closeout" section, which remains accurate for findings #1/#4 and for the *original* reasoning on #2/#3 before this session's re-investigation.

## 2026-07-21 current-review addendum — descendant visibility and block order

The exact PR head was refreshed after the prior closeout and had two new unresolved P2s. Both are
real, and this addendum supersedes the documented ordering limitation above without rewriting the
historical investigation.

1. `font-size:0` is inherited but overridable. Returning at the wrapper dropped descendants that
   explicitly restored a visible font size. The parser now distinguishes styles that hide the
   entire subtree (`display:none`, `visibility:hidden`, exact-zero opacity) from a zero-font
   inheritance state. It skips zero-sized text while walking descendants, carries that state
   through undeclared/inheriting children, and clears it on an explicit visible font size.
2. Pushing a nested table heading while waiting to append one atomic outer-table block reordered
   earlier rows behind the heading. A table containing a nested Item-heading table is now treated
   as an EDGAR layout wrapper: its direct cells are traversed in DOM order, so prior content is
   emitted before the heading and following content remains after it. Ordinary nested tables with
   no heading retain the existing grid/Markdown conversion and pipe escaping.

Files changed in this addendum:

- `src/lib/web-sources/sec-parser.ts`
- `test/sec-parser.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-19-pr1776-review-thread-closeout.md`

Verification in `/Users/jay/.codex/worktrees/socratic-pr1776-reviewfix` on Node 24:

- `npx vitest run test/sec-parser.test.ts --no-file-parallelism` — 1 file, 18 tests passed.
- `npx vitest run test/rag-chunk.test.ts test/sec-parser.test.ts test/sec-filings.test.ts test/sec-ingest-worker.test.ts --no-file-parallelism` — 4 files, 71 tests passed.
- `npx eslint src/lib/web-sources/sec-parser.ts test/sec-parser.test.ts` — exit 0 (17 inherited `no-explicit-any` warnings, 0 errors).
- `npx tsc --noEmit` — exit 0.

External actions remain intentionally held until the parent PR sweep releases after #1857.
