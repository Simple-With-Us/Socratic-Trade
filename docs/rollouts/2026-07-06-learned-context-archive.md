# 2026-07-06 — Learned-context copy fix + browse/delete archive

## Summary

Two owner-requested changes to the Learned Context feature, both shipped this pass:

1. **Copy fix** on the empty-state text of the risk-tier confirmation queue
   (`app/console/approvals/learned-context.tsx`) — the original ("Nothing learned is waiting on
   you") was grammatically awkward and overclaimed scope (it read as if it covered ALL learning,
   when the queue only ever holds the `risk`/`strategy-directive` tier).
2. **New "learned facts" browse/delete archive** — a read + erase surface for everything the AI has
   durably recorded, including the silent `fact`-tier rows that never touch the confirmation queue
   at all. This closes a real gap: `docs/chat-multiuser-learning-design.md` promised these rows
   would be "per-row, attributable, supersedable, and erasable," but no UI or delete path existed
   before this change — only `listLearnedContext(userId)` at the DB layer.

## Why

The owner asked why the AI doesn't just auto-learn and let the user review/delete afterward.
Investigating the actual classifier (`src/lib/learned-context/classify.ts`) and design doc showed
that's already how the majority tier (`fact`) works — silent passthrough, no confirmation, ever.
The confirmation queue is deliberately narrower: only signals that could move a numeric risk
limit/position size/leverage/authority setting, sourced partly from ingested (untrusted) documents
and autonomous inference. Auto-applying those and cleaning up later would mean a wrong or
adversarially-crafted inference could already widen real position sizing before a human saw it —
a correctness/injection-defense boundary, not a paternalism cage (consistent with this repo's
stated "harden correctness, not obedience" philosophy). What WAS missing, and genuinely should
exist per the design's own promise, is the read/delete surface for the silent tier — this PR
builds it.

## Files

- `app/console/approvals/learned-context.tsx` — reworded empty-state copy; added
  `LearnedFactsArchive` component (collapsed-by-default browse list with per-row delete + confirm
  sheet, mirroring the existing approve-confirmation pattern for consistent friction).
- `app/console/approvals/page.tsx` — renders `<LearnedFactsArchive />` beneath the existing
  `<LearnedContextInbox />`.
- `app/console/lib/learned-context.ts` — added `fetchLearnedContext` (`GET /api/learned-context`)
  and `deleteLearnedContextItem` (`DELETE /api/learned-context/[id]`).
- `src/lib/db-learning.ts` — added `deleteLearnedContext(id, userId)`: ownership-scoped delete
  (`WHERE id = ? AND user_id = ?`), which also serves as the erasure path for a user's own
  shared-scope contributions (a shared row's `user_id` stays its author; a mere reader via
  `includeShared` can never delete it).
- `app/api/learned-context/route.ts` **(NEW)** — `GET`, lists everything recorded for the caller.
- `app/api/learned-context/[id]/route.ts` **(NEW)** — `DELETE`, ownership-gated, audits
  `learned_context.delete`.
- `test/learned-context-delete.test.ts` **(NEW)** — 7 tests: own-row delete, foreign-user 404
  (never deletes another user's row), missing-id 404, shared-contribution erasure by the original
  contributor only, audit trail on success but not on a no-op, superseded-row exclusion, per-user
  read isolation.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`, `STATUS.md`, this note.

## Verification

```bash
npx tsc --noEmit                                    # clean
npm run lint                                         # 0 errors (grandfathered warnings only)
npx vitest run test/learned-context-delete.test.ts   # 7/7 pass
npm test                                             # full suite — see STATUS.md for result
npm run build                                        # see STATUS.md for result
```

Note: hit a local-only `better-sqlite3` NODE_MODULE_VERSION mismatch (native binary built against
a newer Node ABI than the active `node -v` in this worktree) before the first test run — fixed with
`npm rebuild better-sqlite3`; unrelated to this change, no source files involved.

## Merge note

`land.sh`'s stale-overlap guard correctly flagged that `origin/main` had moved since this branch
forked — a large amount of fleet work landed in the interim (Coolify/Hetzner migration prep, a
mobile console width-overflow fix, RAG multi-query/HyDE, Kelly/vol-targeting sizing, prompt-safety
fencing, red-team routing, and dozens of other rollouts). Reviewed each flagged overlap by hand
before merging:
- `src/lib/db-learning.ts` — the other side's changes were entirely in the unrelated
  skipped-counterfactual section (outcome-horizons lost-update guard); merged with zero conflict,
  confirmed `deleteLearnedContext` intact afterward.
- `AGENTS.md` / `docs/EFFORT-LOG.md` — genuine adjacent-insertion conflicts (both sides added rows
  at the same position); resolved by keeping both sides' content. Also folded in CURSOR's new 4103
  fleet-table row (the missing piece flagged in my own earlier #ag***-s**c ask) and corrected a
  stray 4104→4103 typo in another agent's Coolify-migration effort-log row to match the
  owner-confirmed port assignment.

Re-ran the full verify gate (tsc, lint, full test suite, build) on the merged tree before landing —
see Verification above for the pre-merge numbers; post-merge results are in STATUS.md.

## Deploy

Landed via `scripts/land.sh` → PR → squash auto-merge on green `verify`, then released to
production via `~/apps/trading-publish.sh` (owner-provided release script: pins Node 24, `git fetch
+ reset --hard origin/main`, `npm ci`, `npm run build`, `pm2 restart trading`). See PR number and
production verification in the addendum below / STATUS.md.

## Follow-ups

- No delete confirmation "undo" — deleting a learned-context row is an immediate, permanent hard
  delete (matches the DB layer; no soft-delete/tombstone). If this proves too easy to fat-finger in
  practice, a short-lived undo toast would be the next increment.
- The archive currently shows ALL of a user's own recorded rows (fact + approved risk/directive),
  unfiltered/unpaginated. If a heavy user's learned-context table grows large, this should get
  pagination or a symbol/date filter — deferred until it's actually a problem.
- `LearnedFactsArchive`'s load/abort/resolvedIds/mount-tracking logic duplicates
  `LearnedContextInbox`'s (same file) near-verbatim — a genuine DRY opportunity an adversarial
  review pass surfaced (2 independent finder angles). Deliberately NOT extracted into a shared hook
  in this pass: `LearnedContextInbox` gates the risk-tier approval queue (the safety-critical path
  in this feature), and refactoring already-tested code there purely for a code-quality win right
  before a production release adds blast radius for no user-facing benefit. Worth a dedicated,
  separately-reviewed follow-up.

## Adversarial review

8-angle review (line-by-line, removed-behavior, cross-file, reuse, simplification, efficiency,
altitude, CLAUDE.md conventions) plus 2 verification passes on the only candidates that looked
correctness-adjacent — found zero correctness/security bugs:
- Parameter-order claim (`deleteLearnedContext(id, userId)` vs. other delete functions) — REFUTED:
  `id`-first is actually the majority convention in this codebase (4 of 6 comparable functions),
  not a violation.
- Dangling `superseded_by` pointer after a hard delete — REFUTED: every read path
  (`listLearnedContext`, `listLearnedContextForDecision`, `findLiveLearnedContextBySubject`) filters
  `WHERE superseded_by IS NULL`, so a row pointing at a deleted target is already excluded from
  every read regardless; the pointer is inert stored data with zero observable effect.
