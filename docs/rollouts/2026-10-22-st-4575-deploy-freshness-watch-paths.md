# 2026-10-22 - st-4575-deploy-freshness-watch-paths

## 1. Context & Objective

The deploy-freshness watchdog paged on four consecutive scheduled runs while production was correctly still, because it decided image impact with an exclusion list rather than with Coolify's allow list, so a commit that touched only a CI workflow file counted as image-affecting.  This change makes the watchdog age only the commits that can change the running image, and it decides that with the live `watch_paths` allow list.

## 2. Changes Made

**The rule that replaces the rule.**  The image-affecting set is Coolify's allow list, and the repo already had it.  `src/lib/deploy-image-impact.ts` exports `COOLIFY_WATCH_PATHS_LIVE`, which records the live value, and `isImageNoopPath` already treats `.github/**` as image-noop.  `scripts/rth-deploy-drain.sh` already implements the correct rule through `CHANGED_FILES` and `scripts/assert-rth-deploy-latch.ts`.  The watchdog was the one place that had re-derived the question with a weaker rule.

The fix mirrors the allow list into the shell script and applies one rule to the whole gap: a deployment is owed only if some commit in the gap changed a watched path.  There is no separate "newest image-affecting commit" narrowing any more, because that step compared production against a commit that might never deploy.  The expected sha is no longer narrowed at all.

An empty watched-commit list is now a verdict, not an operational error.  The gap exists, but nothing in it can change the image, so Coolify never owed a deployment for it.  The script reports `image-noop` and exits 0.  It used to exit 1 through `fail_usage`, which is a different failure class entirely and would have masked a real usage error.

**`--first-parent` is load-bearing.**  Classifying a gap with a plain path filter misclassifies merge commits.  Without `--first-parent`, a merge commit is compared against its first parent, which for a pull-request merge is the branch tip.  The merge then looks like it changed every path `main` gained since the branch point, and a docs-only pull request is classified as image-affecting.

On the first-parent chain each commit is a state of `main`, and its own diff is what actually landed on `main`.  That is exactly the question Coolify answers when it decides whether to build, so that is the question the watchdog has to ask.

**Files.**

- `scripts/alert-deploy-freshness.sh` — the `WATCH_PATHS` mirror, the `--first-parent` classification, the `image-noop` verdict, and the log wording.
- `scripts/alert-deploy-freshness.selftest.sh` — fixtures that place an eight-hour-old CI-only commit ahead of a ten-minute-old runtime commit, and the three cases that cover the classification, the age source, and the guard still paging on a real gap.
- `test/deploy-freshness-watch-paths.test.ts` — a drift guard that fails if the shell `WATCH_PATHS` and `COOLIFY_WATCH_PATHS_LIVE` disagree, and that asserts the non-watched and watched path sets.
- `docs/deployment.md` — the deploy-freshness section described the old predicate and now describes the allow-list rule.
- `docs/rollouts/2026-10-22-st-4575-deploy-freshness-watch-paths.md` — this note.

**Why the old predicate was wrong in the direction that pages.**  `.github/workflows/deploy-freshness.yml` runs `scripts/alert-deploy-freshness.sh` on a schedule and fails when the oldest commit on `origin/main` that is not live is more than an hour old.  The predicate was: take the oldest commit in the gap, skip the ones under `docs`, and age whatever is left.

That is an exclusion list standing in for an allow list.  Coolify's `watch_paths` on `socratic-app` is an allow list, so a push that touches none of the listed paths never creates a deployment and no deployment is owed.  The watchdog's exclusion list named only `docs`, so every other non-runtime tree counted as image-affecting.  A commit that changed only `.github/workflows/ci.yml` was therefore aged like a runtime change, and the guard reported production stale while production was exactly where it should be.

The live run history shows this was not one unlucky run.  Four consecutive scheduled runs failed, and in every one the aged commit was a `.github/workflows/*` change.  Every one of those runs was a false positive.

## 3. Decisions & Trade-offs

- **The allow list is mirrored, not fetched.**  The shell script carries its own copy of the live `watch_paths` value, and a test asserts the two copies agree.  Reading the live value from Coolify on every run would need a token with read scope in a workflow that currently has `contents: read` and `actions: read` only, and it would make the guard depend on the control plane it exists to watch.  The drift guard catches the repo-side copy drifting; it does not catch the live Coolify value drifting away from both.  That gap is recorded as a follow-up rather than solved with a new credential.
- **The live `watch_paths` value is not patched from this change.**  It is applied out of band, and the repo records it rather than writing it.
- **The week-8 regular-trading-hours interaction was left alone.**  The failures were entirely the path-set bug.  When the guard should page during regular trading hours is an owner policy decision, and bundling that change into a bug fix would have mixed two questions.
- **The exclusion of `docs` is gone rather than extended.**  An exclusion list is a list that must be kept in step with an allow list somewhere else, and that is what let the drift in the first place.
- **The guard still pages on a real gap.**  The selftest keeps a case where the gap does change a watched path and the verdict is still stale, so the fix cannot pass by silencing the guard.

## 4. Verification State

- `bash scripts/alert-deploy-freshness.selftest.sh` — 12 passed, 0 failed.
- `npx vitest run test/deploy-freshness-watch-paths.test.ts` — 4 passed, 0 failed.
- Negative control against the pre-fix script on `origin/main`: the two false-positive cases fail as intended (exit 3, wanted 0) and the still-stale case passes, so the new cases detect the old behaviour and the guard is not merely quieter.
- `npx tsc --noEmit` — exit 0.
- `npx eslint` over the changed files — exit 0.
- `npm test` — 9737 passed, 51 skipped, 0 failed, across 865 test files passed and 1 skipped.

## 5. Next Steps & Blockers

- Nothing detects drift between the live Coolify `watch_paths` value and the repo's two copies.  A live-API guard needs a CI credential with read scope that is not currently available.
- `scripts/rth-deploy-drain.sh` already implements the correct rule through a different code path.  It could be pointed at the same shared classifier so the two cannot drift apart, which is a refactor rather than a fix.

## 6. Zero-Code Findings

- The repo already contained the correct classifier (`COOLIFY_WATCH_PATHS_LIVE`, `isImageNoopPath`) and a correct implementation of the same rule in `scripts/rth-deploy-drain.sh`.  The watchdog was the only place that had re-derived the question with a weaker rule, so the fix was a mirror of existing knowledge rather than new knowledge.
- The four false-positive scheduled runs and the CI-only commit each of them aged are the evidence that the failure was systematic rather than a one-off.
