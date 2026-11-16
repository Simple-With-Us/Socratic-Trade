# 2026-07-09 — Daily learning-review: no hidden model default, decide-by-default, user-level, renamed (MONET)

## Summary

Owner-directed refinements to the daily learning-review feature (#1116), plus two questions
answered by investigation:

1. **No hidden model default / no silent substitution.** "Blank should not equal Fable, and
   the whole app should never do hidden failovers or hidden backups — it should just require a
   model be chosen." The learning-review model was `unset → claude-fable-5` (a hidden fallback
   in code + a redundant `"" = default (claude-fable-5)` option in the dropdown). Now:
   - `DEFAULT_POLICY.learningReviewModel = "claude-fable-5"` — a **real, explicit** default value
     shown selected in the UI (owner: keep Fable as the default *choice*, just not a
     blank-means-Fable indirection).
   - The blank option is gone from the dropdown; the field always holds a chosen model.
   - The server no longer does `|| LEARNING_REVIEW_MODEL_DEFAULT`; if the model is somehow blank
     it **skips with reason `"no-model"`** rather than quietly picking one. The
     `LEARNING_REVIEW_MODEL_DEFAULT` constant (the old fallback) was removed.
   - App-wide audit for other hidden decision-model defaults: none live. `db.ts:377` is an
     immutable v15 migration that preserved deleted red-team behavior (not a runtime default);
     `app/ui/llm-model-catalog.ts` `DEFAULT_LLM_MODEL` is unused dead code from the removed glass
     dashboard; `vector-db.ts`'s rerank-2.5 is RAG infra (env-only, no settings surface). Flagged
     to owner, not changed.
2. **Decide is the default mode.** `DEFAULT_POLICY.learningReviewMode` `"annotate" → "decide"`;
   the card + server fallback now read "decide unless explicitly annotate". (Feature is still OFF
   by default — nothing runs until enabled; when enabled, it applies verdicts by default.)
3. **Renamed "Reviewer model" → "Learning-review model"** — the Red Team is now called
   "Reviewer", so the old label collided. Field label, hint, toast, and comments updated.
4. **Only run when there's something new to review (don't waste calls).** The review already
   skipped the LLM call when there were zero items, but the learned-facts window is a rolling
   7 days — so the same unchanged facts were re-sent to the model every day. Added a content
   fingerprint (`reviewFingerprint`): the review now skips with reason `"unchanged"` (no LLM
   call) when the item set (id + content + confidence + assertedAt) and the rollout-note set
   match the last SUCCESSFUL review. It re-runs whenever a new/changed/re-asserted fact or a
   new pending item appears, or a new deploy lands a fix that could flip a "still-true?" verdict.
   The failure-event log is deliberately excluded from the fingerprint (routine 429s/timeouts
   would otherwise force a re-review most days). The fingerprint is stored ONLY on success, so a
   failed/parse-failed run is retried the next day rather than skipped. New setting key
   `learning_review:lastFingerprint:<userId>`.

5. **Made the settings user-level (was account-level) — a real coherence fix.**
   `runDailyLearningReviewIfDue(userId)` reads `getPolicy(userId)` (the ACTIVE account's policy)
   and runs **once per user per day** over user-level learned context, but the three
   `learningReview*` fields were stored per-account — so which account's setting controlled the
   job depended on which account was loaded when the scheduler ticked. Added them to
   `USER_LEVEL_POLICY_FIELDS` (db-profiles.ts) so the config overlays every account consistently,
   and moved the card from THIS ACCOUNT → ALL YOUR ACCOUNTS.

## Questions answered

- **"Does the daily learning review take a different LLM call per account?"** No. It is entirely
  user-scoped: `isLearningReviewDue(userId)` / `buildLearningReviewContextPack(userId)`, keyed
  once per UTC day per user, over `learned_context` (per-userId) + the pending queue. One
  frontier call per user per day, regardless of connected-account count. (This change makes the
  *settings* user-level too, matching the job.)
- **"Which settings are user-specific vs account-specific?"** The app splits them explicitly
  (Settings page tags + `USER_LEVEL_POLICY_FIELDS`):
  - **ALL YOUR ACCOUNTS (user-level, overlay every account):** broker connections, API keys,
    event notifications (+ webhook), delivery channels, data sharing (pool consent + learned-fact
    sharing), market-scan shape (candidate limit + outlier reserve), boot behavior, and now the
    **daily learning review** (enabled/mode/model). Appearance/fonts are per-browser (localStorage).
  - **THIS ACCOUNT (per connected account / policy):** tax treatment, LLM models
    (Strategist/Reviewer), strategy prompt/scoring-weights, guardrails/risk rules, autonomy
    authority, advanced-action typed-confirmation, system state.

## Files

`src/lib/db-profiles.ts` (USER_LEVEL_POLICY_FIELDS), `src/lib/defaults.ts` (decide + explicit
model default), `src/lib/learning-review.ts` (remove hidden fallback + constant; decide default;
no-model skip), `app/console/settings/learning-review.tsx` (rename, drop blank option, decide
default, copy), `app/console/settings/page.tsx` (move card to ALL YOUR ACCOUNTS),
`test/learning-review.test.ts` (+3 tests), this note.

## Verification

- `npx tsc --noEmit` clean (after `npm install` picked up main's new `drizzle-orm` dep from the
  merged AG migration — unrelated to this change). `npx eslint` on touched files: 0 errors.
- `npm test` learning-review 15/15 (incl. new: decide+fable defaults on a fresh user; blank
  model → `no-model` skip; learningReview* set under account A1 visible under A2). Policy-scope
  suites (account-scope, per-user/per-account isolation, models-migration) 23/23.
- Driven live: card renders under ALL YOUR ACCOUNTS; model dropdown has no blank option
  (claude-fable-5 first); field labeled "Learning-review model"; Annotate/Decide options present.

## Migration note

Existing per-account `learningReview*` values (a day-old, off-by-default feature — near-zero real
usage) become user-level: on next read they're stripped from the account row and, absent a
user-level value, fall to the new defaults (off / decide / claude-fable-5). Anyone who enabled it
per-account re-confirms once at the user level. No data loss; `learned_context` is untouched.

---

## Follow-up (same day): review-round fixes + adopted trigger feature

Seven verdict-REAL findings from the PR #1278 review round, fixed in one commit (each with a
regression test that fails pre-fix), plus MONET's uncommitted trigger feature found in the
worktree, adopted and finished in its own commit.

### Adopted (MONET WIP, finished)

- **Lesson-count/max-wait trigger**: the daily review now fires only when >=
  `learningReviewMinNewLessons` (default 5) NEW lessons accumulated since the last successful
  review, OR the oldest un-reviewed lesson waited `learningReviewMaxWaitDays` (default 7) — still
  capped at one run per UTC day. `lastReviewedAt` marker stored only on fully-successful runs.
  Finishing touches: corrupt-knob NaN hardening, `/api/policy` bounds validation, trigger tests.

### Fixed (review findings)

1. **No-account overlay** (`db-profiles.ts` getPolicy else branch): user-level fields
   (learningReview*, notificationSettings, marketScan*) now overlay the base policy when the user
   has no active connected account — an enabled review no longer silently reads as disabled on the
   scheduler path. (peekPolicy left as-is: it never applied the user overlay in any branch and its
   read-only contract conflicts with the lazy seed.)
2. **Profile ops preserve user fields** (`writePolicyBlobPreservingUserFields`): profile
   create/update/activate used to overwrite `user_settings.policy` with the full profile blob,
   resetting user-level fields to profile defaults. Now the stored user-level values are overlaid
   before the write (also repairs the pre-existing notification/market-scan clobber).
3. **Blank model save 400s** (`app/api/policy/route.ts`): the delete-on-blank special case for
   `learningReviewModel` is removed — with the explicit claude-fable-5 default it had become a
   silent revert-to-default. A blank now falls through to validatePolicy's non-empty rule
   (mirrors the Red-model precedent); the runner's `no-model` skip stays as a corrupt-data backstop.
4. **Fingerprint keys on config** (`reviewFingerprint(pack, mode, model)`): flipping
   annotate->decide or switching the reviewer model now forces a fresh review instead of hitting
   the "unchanged" skip.
5. **Legacy seed** (`seedLegacyLearningReviewFields`): one-time lazy copy of account-scoped
   (#1116-era) learningReview* values into `user_settings.policy` on first read when absent —
   supersedes this note's earlier "re-confirms once" migration note; the cutover is lossless now.
6. **Coverage gating**: the unchanged-set fingerprint (and `lastReviewedAt`) is stored only when
   EVERY shown item received a valid verdict — a partial response is re-attempted the next day
   (daily marker still advances, so at most one extra LLM call/day).
7. **Apply-failure gating**: `applyLearningReviewVerdicts` now returns
   `{ applied, failures }`; any thrown per-item application (audited as
   `learning_review_apply_error`) blocks the fingerprint store so the set is retried.

### Files

`src/lib/db-profiles.ts`, `src/lib/learning-review.ts`, `src/lib/defaults.ts`, `src/lib/types.ts`,
`app/api/policy/route.ts`, `test/learning-review.test.ts`,
`test/learning-review-policy-route.test.ts` (new), this note.

### Verification

- `npx tsc --noEmit` clean.
- Focused suites: `learning-review` 26/26, `learning-review-policy-route` 3/3,
  `per-account-policy-isolation` + `account-scoped-models-migration` green (43 tests total).
- Pre-fix falsification run: with the src fixes stashed, 8 of the new tests fail (all seven
  finding repros + the return-shape change) — confirming each test pins its bug.

### Follow-ups

- Settings UI knobs for the two trigger fields (API + defaults only today).
- peekPolicy still omits the user-level overlay everywhere (pre-existing, diagnostics-only).

---

## 2026-07-10 addendum — merge-forward + PR #7 guard fix to un-stick #1278 (MONET)

**Summary.** PR #1278 was stuck: GitHub showed `mergeStateStatus: DIRTY` (a stale phantom from a
main push-burst — `git merge-tree HEAD origin/main` was actually clean, main's overlapping edits
were `brokerMinimumHandling`/`reviewedByModel`, disjoint from the learning-review hunks) AND its
`verify` gate would have failed on a real test regression the earlier review round introduced.

**The real blocker.** Commit `2b4e94a4` added `const activeId = getActiveConnectedAccount(userId)?.id`
inside `seedLegacyLearningReviewFields` (db-profiles.ts) to sort the active account first when
seeding legacy learning-review config. Benign in intent, but it trips the blunt PR #7 structural
guard (`test/pr7-merge-gate.test.ts`), which forbids ANY `const activeId =` / active-view-pointer
reference in the seed path (the view/execution decouple invariant). Fixed by dropping the
active-first ordering entirely and iterating accounts as listed — learning-review config is
user-level intent that merely shipped account-scoped (#1116), so any account carrying it is an
equally valid seed source (first-with-keys wins). This honors the guard's intent rather than
evading it with a variable rename.

**Files.** `src/lib/db-profiles.ts` (seed ordering), plus the `origin/main` merge-forward.

**Verification.** node@24 (Mac default is node26 — better-sqlite3 ABI trap). `npx tsc --noEmit`
clean; `pr7-merge-gate` + `learning-review` 30/30; full `npm test` 3326/3326 after the fix
(was 1 failed / 3325 before); `npm run build` clean; `eslint src/lib/db-profiles.ts` 0 errors.

**Status of the feature.** Backend threshold trigger (≥N new lessons OR oldest un-reviewed ≥M days),
no-hidden-model-default, decide-default, user-level scoping, per-call cost recording
(`recordLlmUsage context "learning-review"`) — all DONE and in this PR. Still open (owner's later
asks, NOT in #1278): the two trigger fields' Settings UI knobs, a "Global Settings" section rename,
a per-call cost DISPLAY (usage page groups by model, not yet by context), and the open
"more than one model reviews the lessons?" question.

---

## 2026-07-10 addendum 2 — Codex P2 review-round triage on #1278 (MONET, adversarially verified)

**Context.** #1278's CI was green but the merge was held by the conversation-resolution gate: 6
unresolved Codex-bot P2 threads on the learning-review path. Each was adversarially verified against
the CURRENT code (post-8da047aa) by an independent agent, then cross-checked by hand.

**Fixed (this PR):**
- **#1 config-change re-run gate** (`learning-review.ts`): the scheduler's trigger gate short-circuited
  before the mode/model-aware fingerprint was ever built, so flipping annotate↔decide or changing the
  reviewer model with no new lessons silently never re-reviewed the existing set. Added a cheap config
  signature (`learning_review:lastConfig` = `mode|model`), persisted on each successful review and on
  the no-items skip; the scheduler now also re-runs when that signature changed. Self-healing (fires at
  most once), honors "only run when there's something to review" (a config change IS the new thing).
- **#4 reject null model clear** (`app/api/policy/route.ts`): a cleared model serializes to `null`, which
  `stripNullsDeep` deleted BEFORE `validatePolicy`'s non-empty check ran, so `null` slipped past the
  blank-string guard and `setPolicy` merged the claude-fable-5 default back — a hidden clear→default the
  owner banned. Now rejected with an explicit 400 before stripping. (The verifying agent initially ruled
  this "not-a-defect" on a misread of `defaults.ts`/the settings UI; hand-verification confirmed the
  finding is real and owner-aligned.)
- **#5 duplicate-verdict guard** (`learning-review.ts`): two verdicts for one shown id (e.g. keep+reject)
  both applied (double-promote / promote+reject) while a Set collapsed them so the run cached as complete.
  Items carrying duplicate verdicts are now excluded from apply AND from coverage, so the run stays
  incomplete and retries. Behavior-identical on the normal (no-duplicate) path.
- **#6 approval marker timestamp** (`learned-context/store.ts` + `learning-review.ts`): decide-mode
  promotions were stamped with real application time (> the run-start `lastReviewedAt`), so the trigger
  re-counted just-approved lessons as new the next day and spent a wasted review. `applyApprovedPending`
  now takes a caller-supplied `assertedAt`; the review passes its run-start `now` so promoted rows sit at
  == `lastReviewedAt` and are excluded by the trigger's strict `>`. Human approve route unchanged (keeps
  real approval time — a human-approved lesson SHOULD trigger a future review).

**Deferred (real but non-trivial; tracked as follow-ups, resolved with notes):**
- **#2 unshown-item orphaning** (>80-item backlog): a complete review of the shown 80 advances
  `lastReviewedAt` to `now`, marking the unshown remainder reviewed so they stop counting. Real, but a
  safe fix must sweep oldest-first + add a `truncated` flag + advance the marker only for shown items,
  without breaking the annotate-mode fingerprint gating 8da047aa just tuned. Follow-up PR.
- **#3 legacy-seed default-blob edge** (`db-profiles.ts`): the seed bails when any learningReview* key is
  present in `user_settings.policy`, so a pre-cutover full-blob with `enabled:false` can mask an
  account-level enabled review. Fail-closed (reads OFF, one-click recoverable), sole-user blast radius; a
  naive fix can't distinguish a stale default-false from a deliberate disable and could clobber intent.
  Follow-up PR.

**Tests added:** `test/learning-review.test.ts` — #1 scheduler re-run on config change, #5 duplicate
verdicts incomplete+not-applied, #6 no re-review of just-approved items; `test/learning-review-policy-route.test.ts`
— #4 null-model clear rejected.

**Verification.** node@24. tsc clean; the 3 new learning-review tests + the #4 route test pass in
isolation; full suite deferred to CI (local box thrashing at load ~185, multi-agent). Build: see commit.

---

## 2026-07-10 addendum 3 — resolve deferred finding #3 (legacy-seed default-blob edge) (MONET)

**Context.** addendum 2 deferred Codex P2 finding **#3** as a follow-up: `seedLegacyLearningReviewFields`
(`src/lib/db-profiles.ts`) bailed the moment *any* `learningReview*` key was present in
`user_settings.policy`. But `user_settings.policy` has historically also held a FULL policy blob (a
profile activation via `writePolicyBlobPreservingUserFields`, a no-account `setPolicy`, or a pre-tier
DB) that stamps the DEFAULT `learningReviewEnabled:false` there while the user's real ENABLED review
lived account-scoped (#1116). The bail therefore masked an enabled review after the cutover — fail-**closed**
(reads OFF, no LLM spend, one-click recoverable), but wrong. The naive fix ("recover the account value
whenever `user_settings` shows false") is dangerous: a deliberate post-cutover disable ALSO writes
`learningReviewEnabled:false` (via `pickUserFields`), data-indistinguishable *by value* from the stale
default — recovering it would re-enable a review the owner turned off (fail-**open**, spends budget).

**Fix (two guards, both required).**
1. **Full-blob vs tiered disambiguation.** A modern TIERED write (`pickUserFields` → `setUserSetting`)
   contains ONLY user-level keys; a legacy FULL blob also carries account-level keys. A review key in a
   tiered blob is the user's authoritative value (leave it); the same key in a full blob is a stale
   default (seed over it). Detected structurally:
   `isTieredWrite = Object.keys(stored).every(k => USER_LEVEL_POLICY_FIELDS.has(k))`.
2. **One-time marker** (`learning_review:legacySeedDone:<userId>` in the global `settings` store via
   `setInternalSetting`, mirroring the runner's own `learning_review:*` markers). Set **unconditionally on
   the first read**, so the seed evaluates only the PRE-deploy DB state — where a present review key can
   only be a stale full-blob default (learningReview* was never a user-level field pre-cutover, so it
   could not reach a tiered blob). This is the load-bearing guard: after the user starts making
   post-cutover changes, a deliberate tiered disable can be folded back into a full blob (the next profile
   activation runs `writePolicyBlobPreservingUserFields`), making its false indistinguishable from a stale
   default — but the marker was already set on the first read (which necessarily preceded any deliberate
   change), so the seed never re-fires and never clobbers that intent. The seeded value is still persisted
   onto the SAME `stored` object, so a legacy full blob stays intact for `readLegacyStrategyModelFields`.

The rewrite keeps the PR #7 view/execution-decouple invariant (no active-account pointer;
`test/pr7-merge-gate.test.ts` still green).

**Files.** `src/lib/db-profiles.ts` (seed rewrite + `learningReviewLegacySeedKey` + internal-settings
imports), `test/learning-review.test.ts` (+2 tests), `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

**Verification.** node@24 (Mac default is node26 — better-sqlite3 ABI trap). `npx tsc --noEmit` clean;
`npx vitest run test/learning-review.test.ts` 32/32 (the two new: full-blob-default recovered; tiered
deliberate-disable NOT clobbered); `pr7-merge-gate` + `per-account-policy-isolation` +
`account-scoped-models-migration` + `learning-review-policy-route` all green (53 tests across the 5
policy-scope suites). Pre-fix falsification: with the src fix stashed, the full-blob test fails
(`expected false to be true`) while the tiered-guard test passes (old code also bailed) — confirming the
full-blob test pins the finding and the tiered test guards against the naive fix. `npm run build` clean.
`eslint` on touched files: 0 errors (3 pre-existing `_legacy*`-unused warnings in `mergePolicy`, unrelated).

**Delivery.** Built on a branch forked from #1278's tip (`monet/learning-review-model-fixes-99138a`
@ 150257ae) because the target code only lived on that then-unmerged PR. #1278 squash-merged to `main`
mid-work (`6f1aaf87`, 2026-07-10 08:26Z), so the branch was rebased onto `main` (single commit; #1278's
now-redundant commits dropped) and delivered as the standalone follow-up **PR #1326** against `main` — per
addendum 2's "Follow-up PR" designation. Finding **#2** (unshown-item orphaning) remains the only open
deferred item from #1278.
