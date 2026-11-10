# 2026-08-20 — The two-space sentence rule is now enforced, and the web actually renders it

## Context & Objective
Review cluster `copy-consistency-rules`.  The owner's copy rules were unenforced on the web, and the headline defect is not that gaps were missing from the source — it is that **the source looked compliant and the screen was not**.

Two literal ASCII spaces typed into JSX **collapse to one at render** (CSS Text Module Level 3: runs of ASCII space/tab/newline collapse; U+00A0 does not).  So a developer typing `"…saved.  The console…"` sees two spaces in the editor, ships it, and the user sees one.  That is exactly how this stayed broken while looking fixed.

## The measured scope, not the estimated one
The review estimated "roughly 600 web copy strings".  The lint found **698 real violations across 73 files**.

| Rule | Before | After | Fixed | Backlog |
|---|---|---|---|---|
| A. Sentence gap | **698** (73 files) | 46 | 652 (93.4%) | 46, **100%** in peer-locked files |
| B. Compact money lowercase | 3 | 0 | 3 | — |
| C. Central time | 1 real | 0 | 1 | — |
| D. Title Case | 155 | 155 | 0 | 155, report-only, needs triage |

The 46 remaining are entirely in `chrome.tsx` (29), `guardrails/page.tsx` (16) and `admin/page.tsx` (1) — all held by peer PRs #2795 / #2793 / #2828.

Rule C is a correction to the review: it implied every `.toLocaleString()` call was suspect.  **13 of the 14 raw hits were plain `Number.prototype.toLocaleString()`** on share counts, byte counts and vector counts, which need no timeZone at all.  Only `legal.tsx` was real.

Rule D is deliberately **report-only and not gated**: the heuristic conflates real headings with tooltip `title=` attributes, which follow the *value* sentence-case rule instead.  It needs human triage before any auto-fix, and most real offenders live in the same peer-locked files.

## Byte-level proof, because the intent is not the point
On the exact file the review cited (`app/console/components/consent-gate.tsx`), the gap after `"saved."`:

```
BEFORE: 0x20 0x20 0x54   ("  T")  -> two ASCII spaces, collapse to ONE rendered space
AFTER:  0xa0 0x20 0x54   ("  T") -> NBSP + space, survives collapse
```

The test file implements `renderCollapse()` (the CSS whitespace-collapsing rule) and asserts on the *rendered* result, not the source.

## What the fixer got wrong, and how it was caught
Building an automated fixer for a regex-only, non-AST lint against live TS/TSX surfaced **three real bugs in the tool itself**.  All three were caught by running the app's own test suite, not by trusting the regex:

1. **Numbered section markers** ("1. Acceptance of terms") were read as missing sentence gaps, which would have corrupted the numbered headings on the public Terms and Privacy pages.  Fixed with a leading-list-marker guard.
2. **Comparison operators, arrow functions and TS generics** were each in turn misread as JSX tag boundaries by a blacklist-style heuristic.  The worst instance **altered real code**: `params.id ?? ""` became `params.id ??  ""` in two files.  Fixed by switching to a positive character allowlist plus a content-based `looksLikeCode()` filter that rejects any candidate containing `;`, `=>`, or a statement/hook keyword.
3. **An IRS citation** ("Rev. Rul. 2008-5") got a gap inserted into the abbreviation, breaking an exact-string assertion in `test/console-policy-diff.test.ts`.  Fixed by extending the abbreviation list.

All three are now defended by regression comments in the lint and by dedicated audit scripts (numbered-marker check, "no letter within 8 chars after the gap" check, double-application check — 0 hits each in the final state).

An independent sweep of the final diff for doubled spaces adjacent to operators or keywords returned only two hits, both of which are **comments inside the lint script documenting these very bugs**.

## Changes Made
- **New:** `scripts/copy-rules-lint.mjs` (lint + fixer, runnable standalone: `node scripts/copy-rules-lint.mjs [--json] [--fix] --dir <paths>`), `scripts/copy-rules-lint.d.mts`, `test/copy-rules-lint.test.ts` (17 tests: per-rule units, render-collapse proof, repo-sweep assertions).
- **Modified:** 70 files under `app/**`.  Largest single surface is `app/console/guardrails/field-defs.ts` (78 sentence-gap fixes).
- **Untouched, confirmed by diff:** the 6 peer-locked files, all of `app/mobile/**` (PWA is retired), all of `src/lib/**`, all of `ios/**`.

## Corrections to the review
- The "one run state carries three names, one stop control four" claim is **stale** — `close_only` is labelled "Exit-only" consistently on web and iOS, and the stop button is consistently "Stop Agent".  Likely fixed by PR #2842.
- But a **real** cross-platform mismatch survives and is not fixed here: web's `field-defs.ts` says "Max per order" while `ios/SocraticTrade/GuardrailsView.swift:69` says "Max Order".  That belongs to the iOS↔web parity work, not to a web lint.
- Defect 4 had **more sites than cited**: the review named `drilldown-data.ts:674`; two more were found and fixed (`scan/columns.tsx`, `scan/smart-money.tsx`).

## A fourth fixer bug, found when main moved under the branch

Merging 12 commits of main into this branch made the lint fail its own test.  The cause was a **false positive**, not drift: `app/admin/backtest-ic/backtest-ic-client.tsx:175` has the Stat label `"Ann. Return"`, and the lint read `. R` as a sentence boundary.

That matters more than the count.  Left unguarded, the "fix" would have produced `"Ann.  Return"` — the lint would have corrupted a correct label, which is the same failure class as the three bugs above.  `"ann."` joins `ABBREVIATION_SUFFIXES` alongside `"rev."`/`"rul."`, with a comment naming the site so it is not removed later.

Two other test failures in the same run (`task-journal`, `redteam-failure-routing`) were **load timeouts**, not regressions — they ran 65s and 32s while the shared machine was at load ~600, and both pass in isolation.  Recorded so a future reader does not chase them.

## Verification State
`tsc --noEmit` clean.  `test/copy-rules-lint.test.ts` 17/17.  Full suite **7208 passed, 51 skipped, 0 failed**.

Full gate results recorded in the PR.

## Next Steps & Blockers
- 46 sentence-gap violations blocked on #2795 / #2793 / #2828.  Re-run `node scripts/copy-rules-lint.mjs` after those land.
- Title Case (155 flags) needs design/owner triage before automation.
- `src/lib/**` and `ios/**` were never scanned — the scope here was web copy under `app/**`.
