# 2026-07-08 — Daily LLM learning review (MONET)

## Summary

New once-per-UTC-day job: a frontier-class model reviews the system's LEARNING DECISIONS —
learned_context rows asserted in the last 7 days plus every pending risk-tier candidate —
against a SYSTEM-HISTORY digest, and either annotates them (default) or, on owner opt-in,
decides on them through the existing learned-context mutation paths.

New module `src/lib/learning-review.ts`; three new policy fields
(`learningReviewEnabled` default OFF, `learningReviewMode` "annotate"|"decide" default
"annotate", `learningReviewModel` default `claude-fable-5`); a scheduler hook; a Settings
card; 12 tests.

## Why

Learned lessons can encode corrupted evidence. The 2026-07-07 MU stale-exit deadlock
stranded a losing position and the learning loop then wrote lessons blaming the trade
THESIS for losses actually caused by the execution defect. Lessons compound — they feed
every future prompt — so one frontier call per day auditing them against the system's own
operational history is the right economics (owner design discussion, 2026-07-08).

## Design

- **Once-per-day gate** mirrors `runCongressDailyShareIfDue`: an internal setting
  (`learning_review:lastRunDate:<userId>`) holds the last UTC run date; the scheduler tick
  fire-and-forgets `runDailyLearningReviewIfDue(userId)` per user (no-op unless the policy
  flag is on and the day is unserved).
- **Context pack** (`buildLearningReviewContextPack`):
  - learned_context rows asserted in the last 7 days + all `status='pending'` rows from
    learned_context_pending;
  - the learning-mutation ledger's last 7 days (new `listLearningMutationsSince` in
    `db-learning-ledger.ts` — across accounts, unlike `listLearningMutations`);
  - SYSTEM-HISTORY digest: execution-failure audit kinds from the last 14 days (failed
    `llm_step`, `order_blocked_live_preflight`, `order_rejected_by_broker`,
    `order_placement_uncertain`, `limit_order_stale`, `proposal_blocked_broker_held_exit`,
    `stale_exit_auto_remediated`) via new `listAuditByKindsSince` in `db-learning.ts`,
    plus the last ~10 `docs/rollouts/` filenames + first lines (they exist in the deployed
    tree; unreadable → empty, never fatal). This digest is what lets the reviewer ask "was
    the system broken when this lesson's evidence was generated?".
- **LLM call** goes through the app's own transport: `resolveLlmEndpoint` with a policy
  clone whose `llmModel = policy.learningReviewModel ?? "claude-fable-5"`,
  `buildLlmRequestBody` with a STRICT verdict schema
  `{ reviews: [{id, table, verdict: keep|reject|expire|needs_more_data, confidence: 1-100,
  reasoning}], summary }`, `recordLlmUsage` with context `"learning-review"`. The prompt
  encodes the THREE TESTS — (1) is the evidence sample meaningful? (2) is the attributed
  cause the real cause, or an execution/infrastructure defect active at the time? (3) is it
  still true after recent fixes? — plus the standing rule that key-level quota/rate limits
  are owner settings, never held against models/theses, and the data-not-command boundary.
- **Modes** (`policy.learningReviewMode`):
  - `annotate` (default): one `learning_review_verdict` audit per item + a
    `learning_review_summary` audit + a `learning_review` notification. Nothing mutates.
  - `decide` (owner opt-in): verdicts are ADDITIONALLY applied via the existing paths —
    learned_context `reject` → `deleteLearnedContext`, `expire` → new
    `expireLearnedContext` (sets `expires_at`, so the existing decision-read filter
    excludes it while the row survives for provenance); pending `keep` →
    `applyApprovedPending` + status `approved` (exactly the human approve route's pair),
    `reject`/`expire` → status `rejected`, `needs_more_data` → left pending. Every
    application audited (`learning_review_applied`). Verdicts for ids not in the reviewed
    pack are ignored — the model can never touch rows it wasn't shown.
- **Fail-safe:** any transport/HTTP/parse failure → `learning_review_failed` audit + skip;
  NOTHING mutates. The daily marker still advances on failures and on empty-store skips so
  a broken provider isn't hammered every tick; cheap pre-flight skips (no key, over budget,
  not due) do NOT advance it.
- **Notification:** new `learning_review` NotificationEventType (types.ts), body = the
  review summary; labeled in dashboard-ui.ts + the Settings event list.
- **Settings UI:** new `LearningReviewCard` (`app/console/settings/learning-review.tsx`)
  under THIS ACCOUNT next to the Models card — toggle + mode select + reviewer-model
  select, saved via the same PUT /api/policy path (validation added in
  `app/api/policy/route.ts`, including empty-string → delete for the model field).

## Files

- `src/lib/learning-review.ts` (new) — the job.
- `src/lib/db-learning.ts` — `listAuditByKindsSince`, `expireLearnedContext`.
- `src/lib/db-learning-ledger.ts` — `listLearningMutationsSince`.
- `src/lib/types.ts` — 3 policy fields + `learning_review` notification type.
- `src/lib/defaults.ts` — `learningReviewEnabled: false`, `learningReviewMode: "annotate"`.
- `src/lib/llm-request.ts` — `LLM_OUTPUT_TOKEN_CAPS.learningReview`.
- `src/lib/scheduler.ts` — per-user fire-and-forget hook in the tick.
- `src/lib/notifications.ts` — direct-notification body for `learning_review`.
- `src/lib/dashboard-ui.ts` — notification type label.
- `app/api/policy/route.ts` — validation for the 3 fields.
- `app/console/settings/learning-review.tsx` (new) + `app/console/settings/page.tsx` —
  Settings card + event hint.
- `test/learning-review.test.ts` (new) — 12 tests: verdict parsing/clamping/fence
  tolerance/entry-dropping/null cases; once-per-day dedup incl. disabled no-op and
  empty-store terminal skip; annotate-never-mutates; decide-applies (delete/expire/approve/
  reject, all audited); unshown-id immunity; llm-error and parse-error fail-safes.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (339 pre-existing grandfathered warnings).
- `npx vitest run` — full suite green (see land.sh gate).
- `npm run build` — via land.sh gate.

## Follow-ups

- Surface the review verdicts on the console (e.g. a badge on the Learned context queue
  showing yesterday's flags) — annotate mode currently reads through the activity log +
  notification only.
- Possible cross-check lane: let the reviewer also see thesis-level realized outcomes so
  SAMPLE-test verdicts are grounded in the scorecards, not just row counts.
- `needs_more_data` currently leaves items untouched in both modes by design; a future
  slice could snooze/re-queue them explicitly.
