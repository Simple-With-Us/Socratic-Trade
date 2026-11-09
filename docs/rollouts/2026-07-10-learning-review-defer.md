# 2026-07-10 — Learning Review: explicit "defer" verdict for unsure items (CLAUDE)

## Summary

Owner-directed change to the daily Learning Review LLM flow (`src/lib/learning-review.ts`): the
reviewer can now explicitly say "I can't confidently decide this one" instead of being forced into
keep/reject/expire/needs_more_data. A new `"defer"` verdict:

1. Is instructed in the system prompt as the right move when the reviewer is genuinely unsure —
   with an explicit "it's OK not to know" framing so the model doesn't feel pressured to guess.
2. Requires a non-blank reasoning note when used; `parseLearningReviewVerdicts` drops any `"defer"`
   entry with blank/missing reasoning (treated as malformed, same as any other invalid entry).
3. For a `learned_context_pending` row (the human confirmation queue), leaves the row **exactly
   pending** — no approve/reject — and persists the reviewer's note onto a new `review_note` column
   so a human sees *why* it was left for them.
4. Is surfaced in the queue UI (`app/console/approvals/learned-context.tsx`) as a small muted
   "Left for you because ..." line on the card, using the same `--con-*` token styles as the
   existing Provenance line.
5. For a durable `learned_context` row, is a no-op identical to the existing `needs_more_data`
   behavior — there's no "pending queue" for an already-recorded fact, so the note is audited only
   (not persisted onto that row).

## Why

Prior to this change the reviewer's four verdicts (`keep`/`reject`/`expire`/`needs_more_data`) forced
a decision on every item every day, or at best `needs_more_data` (narrowly scoped to "plausible but
under-sampled"). The owner wants the model to be honest about genuine uncertainty rather than
picking a plausible-sounding verdict under pressure, and wants that uncertainty to be visible to the
human who has to act on the queue item — not buried in an audit-log blob nobody reads.

## Where the pieces live (file:line as of this change)

- **Prompt**: `src/lib/learning-review.ts` — `SYSTEM_PROMPT` (~line 495), RULES bullets: verdict
  list now includes `"defer"`; a new "IT IS OK NOT TO KNOW" bullet instructs when to use it; a bullet
  requiring the reasoning note be written *to the human*, not just about the item.
- **Schema**: `LEARNING_REVIEW_SCHEMA` (~line 230) — `verdict` enum is built from `VERDICT_KINDS`
  (~line 226, now `["keep","reject","expire","needs_more_data","defer"]`), so the JSON schema sent to
  the LLM auto-includes it; the `reasoning` property description was extended to spell out the
  non-blank requirement for `defer`.
- **Parsing**: `parseLearningReviewVerdicts` (~line 266) — after the existing per-field validation,
  a `defer` entry with a blank/whitespace-only `reasoning` is `continue`d (dropped), mirroring how
  every other malformed entry is already handled. A dropped entry simply means that item gets no
  verdict this run, so it's re-attempted on a later run (same fail-safe posture as every other
  parse-time rejection in this function).
- **Application/persistence**: `applyLearningReviewVerdicts` (~line 512) — new `else if
  (verdict.verdict === "defer")` branch for `learned_context_pending`: calls the new
  `setPendingLearnedContextReviewNote(id, userId, reasoning)` (does **not** touch `status`/
  `resolved_at`) and records action `"deferred"` (audited via the existing
  `"learning_review_applied"` audit, so it's distinguishable from `"approved"`/`"rejected"` in the
  audit trail). For `learned_context`, `defer` falls through with no action (identical to
  `needs_more_data`).
- **DB column**: `src/lib/db.ts` — `review_note TEXT` added to the `learned_context_pending`
  `CREATE TABLE IF NOT EXISTS` (fresh DBs) plus a guarded `PRAGMA table_info` / `ALTER TABLE` block
  (existing DBs) right before the final `migrateGlobalPolicyToLocalUser(...)` call in `migrate()`.
  `src/lib/db-learning.ts` — `RawLearnedContextPendingRow.review_note`, `mapLearnedContextPending`
  now maps it to `reviewNote`, `insertPendingLearnedContext`'s column list/positional args extended,
  and the new `setPendingLearnedContextReviewNote(id, userId, note)` (mirrors
  `setPendingLearnedContextStatus`'s ownership-scoped `WHERE id = ? AND user_id = ?` /
  `result.changes > 0` shape).
- **Type**: `src/lib/types.ts` — `LearnedContextPendingRow.reviewNote?: string | null` (optional, so
  none of the three existing full-literal construction sites —
  `src/lib/learned-context/store.ts`, `test/learned-context-pending.test.ts`,
  `test/learning-review.test.ts`'s `seedPendingRow` — needed updating).
- **UI**: `app/console/approvals/learned-context.tsx` — new `ReviewerNote` component (renders only
  when `item.reviewNote` is set), rendered inside `LearnedItemCard` right after `Provenance`. Uses
  the established `text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]` /
  `text-[color:var(--con-muted)]` token pair already used by `ApprovalEffect` and `Provenance` in
  this file, and the same `<Tooltip><p>...</p></Tooltip>` pattern already used elsewhere in this
  file and in `scan-table.tsx`.

## Verdict-flow decision: does a deferred item get re-reviewed in a tight loop?

No extra code was needed to prevent this — it falls out of the **existing** marker/fingerprint
architecture (the `#1278`/`#1328` hardening), verified with a new test
(`"a lone deferred item does not force a same-set re-review the next day"`,
`test/learning-review.test.ts`):

- A `learned_context_pending` row's `status` never changes on defer, so it keeps showing up in
  `buildLearningReviewContextPack` on every future run (pending rows aren't time-windowed, only
  status-filtered) — it is **not** permanently excluded.
- However, once a run that included it is `complete` (every shown item got exactly one verdict) and
  has zero apply failures, `lastReviewedAt` advances past its timestamp same as any other verdict —
  so it stops counting toward `evaluateLearningReviewTrigger`'s `newCount`/`oldestUnreviewedAgeDays`.
  It won't force its *own* re-review.
- If it is the **entire** reviewable set and nothing else changes, the existing fingerprint
  ("unchanged set") check (`reviewFingerprint`) matches on the next run and the LLM is skipped
  entirely (`reason: "unchanged"`, zero extra spend) — confirmed by the new test's Day 2 assertion.
- The moment **anything else** changes (a new lesson/pending item arrives, or the reviewer config
  changes), the fingerprint differs and a fresh run reconsiders the **whole** current set, including
  the still-deferred item — confirmed by the new test's Day 3 assertion (a fresh pending row pushes
  the set to 2 items; both get reconsidered; both remain deferred/pending in this test's fixture LLM).
- **Net effect (the policy, as chosen/verified, not separately implemented):** a deferred item
  sticks exactly where the reviewer left it — no forced immediate re-ask, no permanent
  invisibility — until either a human acts on it directly (Approve/Reject in the queue UI) or some
  other trigger condition naturally brings the reviewer back to the whole set, at which point it
  gets a fresh look alongside everything else. This matches the owner's ask ("defer should stick
  until human action or a sensible re-review policy") without adding a second, competing
  scheduling mechanism.

## Mode scope: why `review_note` is decide-mode-only

`applyLearningReviewVerdicts` (and therefore the `review_note` write) is only ever called when
`policy.learningReviewMode === "decide"` — mirrors every other verdict's persistence (keep/reject/
expire already only mutate rows in decide mode; `"annotate"` mode's contract is "NOTHING is
mutated", asserted by the pre-existing `"annotate mode"` test). A new test
(`"annotate mode: a defer verdict is audited but the note is NOT persisted"`) confirms the reasoning
is still fully auditable via `"learning_review_verdict"` even in annotate mode — it's just not
written onto the row, consistent with annotate mode's existing invariant.

## Files touched

- `src/lib/learning-review.ts` — verdict kind, schema, prompt, parsing, application, header comment.
- `src/lib/types.ts` — `LearnedContextPendingRow.reviewNote`.
- `src/lib/db.ts` — `learned_context_pending.review_note` column (CREATE TABLE + guarded ALTER).
- `src/lib/db-learning.ts` — raw row mapping, insert, new `setPendingLearnedContextReviewNote`.
- `app/console/approvals/learned-context.tsx` — `ReviewerNote` component + render site.
- `test/learning-review.test.ts` — 2 new `parseLearningReviewVerdicts` cases + new `"defer verdict"`
  describe block (4 tests: decide-mode pending persistence, decide-mode durable-row no-op,
  annotate-mode audit-only, and the sticky/no-tight-loop re-review test).

## Verification

Run from a fresh worktree (`claude/learning-review-defer`, branched off `origin/main` @ `c7a2fa95`,
isolated from an unrelated in-progress `claude/per-team-reasoning` session left dirty in the
originally-assigned worktree — see that branch's own work, untouched here):

```
npx tsc --noEmit                                     # clean
npx vitest run test/learning-review.test.ts \
  test/learning-review-policy-route.test.ts \
  test/learned-context-pending.test.ts               # 52 passed (3 files)
npm test                                              # 3389 passed (315 files)
npm run build                                         # clean production build
npm run lint                                           # 0 errors, 376 pre-existing warnings (unchanged backlog)
```

## Follow-ups / not done

- No change to `learningReviewMode`/`learningReviewMinNewLessons`/`learningReviewMaxWaitDays`
  policy fields or their validation route — this change is entirely inside the verdict vocabulary
  and its two consumers (application logic, queue UI).
- The `review_note` column is `learned_context_pending`-only. A durable `learned_context` row has no
  human-facing "pending" surface today, so a `defer` verdict there stays audit-log-only, matching
  `needs_more_data`'s existing treatment. If the owner later wants visibility into *why* a durable
  fact was left alone, that would need its own UI surface (the archive browse view,
  `LearnedFactsArchive`, is a browse/delete list, not a decision queue) — out of scope here.
- Did not add a `reviewedAt`/timestamp column alongside `review_note` — the owner's ask was for the
  note itself; a staleness indicator (e.g. "reviewed 3 days ago") can be added later without a
  migration conflict if wanted.
