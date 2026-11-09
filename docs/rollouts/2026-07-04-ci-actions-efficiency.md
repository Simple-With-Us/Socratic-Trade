# 2026-07-04 — CI Actions efficiency (docs-only fast path + caching + cache hygiene)

Branch `claude/ci-actions-efficiency`, worktree `~/apps/trading-wt-ci-efficiency`, off
`origin/main`. Workflow-only change; no application code touched (one new helper script,
`scripts/prune-stale-actions-caches.py`, used only by the new cleanup workflow).

## Why

The personal GitHub Actions Pro-plan quota (3,000 min/mo) was exhausted. The merge gate is a
required-status-check ruleset (`main-protection`, id `17945518`) that gates `main` on the check
named exactly `verify`. Goal: cut Actions minutes substantially with **zero weakening** of that
gate — every code/config change must still run the full lint/tsc/test/build suite unchanged; only
pure-documentation diffs get a cheap path.

## What changed

**`.github/workflows/ci.yml` only.** Restructured into two jobs:

1. **`classify`** (new, cheap, `ubuntu-latest`, no deps installed) — on `pull_request` events
   only, checks out with `fetch-depth: 0` and computes `git diff --name-only
   <base_sha>...<head_sha>`. If every changed path matches `*.md` (anywhere) or `docs/**`, it sets
   output `docs-only=true`; otherwise `false`. Conservative by construction:
   - Any non-`pull_request` event (`push`, `merge_group`) immediately sets `docs-only=false` — no
     diff is computed at all for those triggers, so pushes to `main`/`agent/**` and merge-queue
     runs always get the full gate.
   - Missing base/head SHA, no discoverable merge-base, or an empty diff listing all short-circuit
     to `docs-only=false`.
   - The classifier only ever *adds* work back (falls back to full gate); it can never force a
     skip it isn't sure about.
2. **`verify`** (existing job, same name — this is the job GitHub's ruleset polls) — now
   `needs: classify` and guards every expensive step (`checkout`, `setup-node`, the `.next/cache`
   restore, `Install dependencies`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run
   build`) behind `if: needs.classify.outputs.docs-only != 'true'`. When docs-only, a single step
   logs `docs-only diff — gate skipped by path filter` and the job succeeds immediately — the
   `verify` check still *reports*, it just does almost no work. The existing "Refuse untrusted PR
   source" fork/bot guard step is unconditional (still runs first, cheap, no deps).

**Why a gate-job, not `paths:`/`paths-ignore:` on the trigger:** putting a path filter on the
workflow's `on:` block would mean GitHub never even schedules a run for a docs-only PR — and a
required check that never reports stays **pending forever**, permanently blocking merge. The
`needs.classify.outputs.docs-only` step-conditional pattern keeps the job (and thus the check
name) running and reporting in both cases, satisfying the ruleset either way.

**Caching added to `verify`:** `setup-node@v4` already had `cache: npm` (keyed on
`package-lock.json` — pre-existing, unchanged). New: `.next/cache` restore/save via
`actions/cache/restore@v4` + `actions/cache/save@v4` (split, not the combined `actions/cache@v4`
action — see "Cache hygiene" below for why), same key/restore-key pattern already used in
`e2e.yml`'s Playwright job (`${{ runner.os }}-nextjs-${{ hashFiles('package-lock.json') }}-${{
hashFiles('src/**', 'app/**') }}` with two looser restore-key fallbacks). This warm-starts `npm run
build`'s Next.js compile instead of a cold build every run. `node_modules` itself is not cached
directly — `setup-node`'s built-in npm cache (the documented pattern) is relied on instead,
consistent with the existing e2e/verify setup.

## Codex review fixes (same day, PR #370 review round)

The Codex reviewer flagged two genuine fail-open holes in the classifier design; both confirmed
by local reproduction and fixed:

1. **Rename source hole.** `git diff --name-only` with rename detection active reports ONLY the
   destination path of a rename — reproduced locally: `git mv src/a.ts docs/a.md` listed just
   `docs/a.md`, which would have classified docs-only while deleting code. Fixed by adding
   `--no-renames`, which splits every rename into delete(old)+add(new) so both paths are
   classified (re-tested: the same rename now yields `docs_only=false` with `src/a.ts` caught).
2. **Classify-failure skip hole.** `verify` had `needs: classify` with no status-check function,
   so a classify failure (checkout/network error) would SKIP `verify` — and a skipped required
   check can fail open. Fixed with `if: ${{ !cancelled() }}` on `verify` (deliberately NOT
   `always()`, which would also resurrect verify on cancelled/superseded runs and defeat the
   concurrency `cancel-in-progress`) plus a first step that fails the job explicitly when
   `needs.classify.result != 'success'` — the fast path now fails closed in every non-success
   classify state.

## Cache hygiene (added same day, mid-review)

While this branch was in review the repo hit its **10 GB total Actions-cache cap**
(`gh cache list` showed the account was being throttled/evicted). Root cause, diagnosed live:

- A plain (non-split) `actions/cache@v4` step — as this branch originally added it — **saves a
  new entry on every run it doesn't get an exact-key hit on**, scoped to the run's own ref. Since
  the `.next/cache` key includes a `hashFiles('src/**', 'app/**')` source hash, it changes on
  almost every commit — so every PR push was saving its own ~340 MB entry scoped to
  `refs/pull/<n>/merge`. That entry has no natural cleanup: GitHub only evicts caches when the
  10 GB cap is exceeded (oldest-first, repo-wide), so closed/merged/abandoned PRs left their
  cache entries around indefinitely, competing with everyone else's for the same 10 GB budget.
- The same is true on `main` itself: every push to `main` also saves a brand-new entry (again,
  the source hash changes every commit) without removing the previous `main` entry, so even the
  "long-lived" branch was accumulating a growing list rather than a single rolling one.

Fix, in this same branch (still `verify`/`ci.yml`-scoped, no new required-check surface):

1. **Restore-only on PR/merge_group, save-only on `main` pushes.** `.github/workflows/ci.yml`'s
   `Restore Next.js build cache` step now uses `actions/cache/restore@v4` unconditionally (any
   event, falls back through the two restore-keys to the latest available entry — typically
   `main`'s). A new `Save Next.js build cache (main only)` step uses `actions/cache/save@v4`
   gated on `if: ... && github.ref == 'refs/heads/main' && github.event_name == 'push'`. Net
   effect: PR pushes get a warm cache to restore from but never write their own entry, so cache
   storage grows by one superseding entry per `main` push instead of one throwaway entry per PR
   push.
2. **New workflow `.github/workflows/cleanup-caches.yml`** (not a required check, no interaction
   with the ruleset):
   - `delete-pr-caches` job, on `pull_request: closed` (merged or not) — runs
     `gh cache delete --all --ref refs/pull/<n>/merge --succeed-on-no-caches`, removing any cache
     entries scoped to that PR's ref so a forgotten/pre-fix PR cache can't linger. (Dry-run tested
     against a nonexistent PR ref: `gh cache delete --all --ref refs/pull/999999/merge
     --succeed-on-no-caches` exits 0 with no entries found — confirms the flag combination is
     valid and safely idempotent.)
   - `prune-stale-caches` job, on a daily cron (`5 3 * * *`) plus `workflow_dispatch` — lists all
     caches, groups them by (key-with-trailing-hash-stripped, ref) via the new
     `scripts/prune-stale-actions-caches.py` helper, and deletes every entry in each group except
     the most recently created one. This is a **backstop**, not the primary control (item 1
     above is): it mainly guards `main`'s own Next.js/npm cache lineages against re-accumulating,
     and incidentally also protects the small long-lived tool caches (`gitleaks-cache-*`,
     `bun-*`) if they ever start duplicating. Verified locally against a synthetic 6-entry sample
     inventory (3 `main`-ref Next.js entries with different content hashes, 1 npm-cache entry, 1
     gitleaks entry, 1 PR-ref entry) — correctly prunes only the two oldest `main` Next.js
     entries, leaves the single-entry groups (npm/gitleaks/PR-ref) untouched.

**Before/after cache-storage behavior:**

| | Before this fix | After this fix |
|---|---|---|
| Every PR push | Saves a new ~340 MB `.next` entry scoped to that PR's ref | Restores only; saves nothing |
| PR closes | Cache entry lingers (no automatic cleanup) until the 10 GB cap evicts something, oldest-first, repo-wide | `delete-pr-caches` removes it immediately on close |
| Every `main` push | Saves a new ~340 MB entry, previous `main` entry NOT removed | Saves a new entry (same as before — this is the one lineage that's supposed to grow) |
| Steady-state `main` cache count | Unbounded growth (one entry per push, ever) | Bounded to 1 (daily prune backstop keeps only the newest) |
| Cache inventory at time of fix | 4 entries, 606.8 MiB total (`gh cache list`) — small at the moment of measurement because caches had only just started accumulating post-2026-07-01 self-hosted-runner migration; the reported 10 GB cap event was observed by the owner separately during heavier concurrent PR activity | Same 4 entries immediately after (fix is forward-looking — it changes what gets written from here, not a retroactive purge); the `prune-stale-caches` and `delete-pr-caches` jobs will keep future growth bounded |

## Deferred / follow-up scope (recorded for the record; decision state as of end of day)

Two further additions were proposed mid-task; their decision state EVOLVED during the day and is
recorded here in order:

- **Hybrid self-hosted+hosted runner routing for `verify`.** Initially escalated back with an
  objection rather than built: `trading-live-mac` is the production box; `verify` was
  deliberately moved off it on 2026-07-01 per this same repo's `ci.yml` comment and `AGENTS.md`
  because it "was the main source of the runner queue bottleneck," and a required check whose
  pass/fail depends on which of two OS/toolchain environments executed it is an auditability
  concern for a change mandated as zero-weakening. **The owner then re-confirmed hybrid AFTER
  seeing that tradeoff, with a resource-aware design that answers each objection** (verbatim
  intent: "hybrid so that it only uses local when there is sufficient extra CPU/RAM available"):
  (1) contention — a Mac-side availability publisher (pm2-run, owner-started) computes
  load/RAM/runner/pm2-health every 60s with hysteresis and publishes a
  `VERIFY_RUNNER_STATE` repo variable; gate commands on the self path run under `nice -n 19`;
  (2) bottleneck — the router reads the variable natively and any busy/stale (>5 min)/absent
  state routes hosted instantly, so a busy or asleep Mac never queues anything (the
  self-hosted concurrency-1 group becomes a load-shed detail, not the throughput path);
  (3) determinism — a self-hosted FAILURE triggers exactly one automatic hosted re-run and the
  required gate takes the hosted result on disagreement (Linux stays the arbiter; a Mac-env
  flake can neither block nor fake-fail a merge), plus a nightly hosted full-gate canary on
  `main` and a per-run environment annotation in the gate summary. **To be built as its own
  clearly-labeled PR after this one lands — deliberately NOT in this branch.**
- **Cross-repo reusable `workflow_call` entry point** exposing this gate for all present/future
  repos — **still deferred**, now until the hybrid PR above lands and proves itself. When built,
  the reusable gate defaults to **hosted-only with zero self-hosted references baked in**;
  resource-aware routing stays an explicit per-repo opt-in, never silently inherited. Not
  implemented in this branch.

## Required-check verification

Queried the live ruleset directly rather than trusting the AGENTS.md fallback list:

```
$ gh api repos/jaywedgeworth22/agentic-trading/rulesets --jq '.[] | {id, name, target, enforcement}'
{"enforcement":"active","id":17945518,"name":"main-protection","target":"branch"}

$ gh api repos/jaywedgeworth22/agentic-trading/rulesets/17945518 \
    --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks'
[{"context":"verify"}]
```

**Only `verify` is a required status check today.** `smoke` (e2e.yml), `gitleaks` (security.yml),
and `check-pin` (shared-package-pin-check.yml) are NOT currently required by the ruleset — the
AGENTS.md doc's "verify, smoke, gitleaks, check-pin" list is described there as the fallback to use
*only if the API 404s*; it didn't 404, so the API response above is authoritative. This branch
still leaves `e2e.yml`, `security.yml`, and `shared-package-pin-check.yml` completely untouched —
the docs-only fast path was only ever applied to `ci.yml`'s `verify` job, exactly as scoped, and no
job name was renamed or removed anywhere.

Job name confirmed unchanged: `ci.yml` still defines a job literally named `verify` (now with
`needs: classify` added) — `gh pr checks` / the ruleset will see the identical context string.

## Syntax validation

```
$ npx yaml-lint .github/workflows/ci.yml
✔ YAML Lint successful.
```

Also re-ran `yaml-lint` across all seven workflow files (only `ci.yml` was modified; the rest are
unchanged, listed for completeness) — all pass.

Classification-regex sanity check (bash snippet extracted and run standalone against sample
changed-file lists): root `*.md`, `docs/**` (md or non-md), and mixed docs+root-md all correctly
classify `docs_only=true`; any code/config/package.json/workflow/public asset — alone or mixed
with docs — correctly classifies `docs_only=false`.

## Audit: workflows triggering on every PR push or every push-to-main

No changes made to any of these in this branch — report only, per the task's explicit scope.

| Workflow | Triggers | Runner | Approx. min/run | Required check? | Batching/scheduling opportunity |
|---|---|---|---|---|---|
| `ci.yml` (`verify`) | every PR push, `merge_group`, push to `main`/`agent/**` | `ubuntu-latest` (hosted) | ~4-6 min full (install+lint+tsc+test+build); ~10-20s docs-only after this change | **Yes — the only required check** | This branch's target. Full-gate minutes now scale with actual code-touching PR volume only. |
| `e2e.yml` (`smoke`) | every PR push, `merge_group`, push to `main`/`agent/**`, weekly cron (`17 9 * * 1`) | `ubuntu-latest` (hosted) | ~5-8 min (install + Playwright browser install + build + e2e) | No (not in the live ruleset today) | Good candidate for the SAME docs-only gate-job pattern used here, OR for `paths-ignore` since it isn't a required check (a pending/skipped run wouldn't block merges) — deliberately left unmodified in this branch since it's out of scope. Could also drop the redundant push-to-`agent/**` trigger if PR-level coverage is deemed sufficient. |
| `security.yml` (`gitleaks`) | every PR push, `merge_group`, push to `main`/`agent/**`, weekly cron (`41 10 * * 1`) | `ubuntu-latest` (hosted) | ~1-2 min (checkout + gitleaks scan, no npm install) | No (not in the live ruleset today) | Already cheap (no dependency install). Lowest-priority target; the docs-only fast path would save little here. Could still skip on docs-only diffs for consistency/minutes, but the marginal saving is small. |
| `shared-package-pin-check.yml` (`check-pin`) | PR push only when `package.json`/`package-lock.json`/its own workflow file changed, push to `main`, weekly cron | `ubuntu-latest` (hosted) | <1 min (no npm install, just `gh api` + `node -p`) | No (not in the live ruleset today; explicitly documented in-file as intentionally NOT part of branch protection) | Already path-filtered and cheap. No action needed. |
| `codex-autofix.yml` | `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `workflow_dispatch` — NOT a blanket push/PR trigger | `ubuntu-latest` (hosted) | Variable (LLM agent loop, `timeout-minutes: 30` cap); only runs when the Codex bot actually posts feedback | No | Already conditional/event-driven, not a per-push cost. No action needed. |
| `deploy.yml` | push to `main` (i.e. every merged PR), `workflow_dispatch` | `[self-hosted, trading-live]` | Self-hosted (does not consume hosted Actions minutes) | No | Self-hosted; irrelevant to the hosted-minutes budget. No action needed. |
| `sync-previews.yml` | push to `main`, `workflow_dispatch` | `[self-hosted, trading-live]` | Self-hosted (does not consume hosted Actions minutes) | No | Self-hosted; irrelevant to the hosted-minutes budget. Could be schedule/batched (e.g. every N pushes) if the self-hosted box itself becomes a bottleneck, but that's a runner-time concern, not Actions-minutes billing. |

**Net billing-relevant takeaway:** of the hosted-runner (`ubuntu-latest`) workflows that burn the
Pro-plan Actions-minutes quota, `ci.yml` (`verify`) is the only one that is both (a) a required
check and (b) triggered on every PR push — making it the correct and highest-leverage target for
the docs-only fast path implemented here. `e2e.yml`/`security.yml`/`shared-package-pin-check.yml`
also trigger broadly and consume hosted minutes, but are not required checks; they're flagged above
as candidates for a follow-up efficiency pass, deliberately out of scope for this branch.

## Estimated savings

Assumptions: full `verify` run today averages ~5 min (install ~1-2 min, lint ~20s, tsc ~10s, test
~40-70s, build ~60-90s, plus checkout/setup overhead); a docs-only run after this change is
~15-25s (checkout + classify + the short-circuit log line, no install). Docs-only PRs
(`docs/rollouts/*.md`, `STATUS.md`, `docs/EFFORT-LOG.md`-only diffs, etc.) are common in this repo
given the Pre-Commit/Handoff Protocol's per-commit doc requirements, but exact share of total PR
volume isn't tracked — using an illustrative 15-25% range typical for a repo with this doc
discipline:

- Per docs-only PR: **~90-95% reduction** in `verify` minutes (5 min -> ~20s).
- At an illustrative 20% docs-only PR share: **~18-19% reduction in total `verify` minutes**
  across all PR pushes (0.20 x 95% + 0.80 x 0%-of-baseline, before counting the `.next/cache`
  warm-start saving on the remaining 80%).
- The `.next/cache` restore additionally shortens the `npm run build` step on every *non*-docs-only
  run once the cache is warm (subsequent runs on the same lockfile/source-hash reuse Next's
  incremental compile output) — historically a 20-40% build-step time cut in this repo's other
  workflow (`e2e.yml` already relies on the identical pattern), on top of the docs-only savings
  above.
- These are estimates, not measured production numbers — Actions quota is currently exhausted, so
  no live run of this workflow has executed yet (see Follow-ups).

## Files touched

- `.github/workflows/ci.yml` — `classify` job added; `verify` job's expensive steps now
  step-conditional on `needs.classify.outputs.docs-only`; `.next/cache` restore/save (split,
  restore-only on PR/merge_group, save-only on `main` pushes) added.
- `.github/workflows/cleanup-caches.yml` — new. Deletes PR-ref caches on PR close; daily-cron
  backstop prune of stale same-lineage cache entries.
- `scripts/prune-stale-actions-caches.py` — new. Pure-stdin/stdout helper used only by
  `cleanup-caches.yml`'s scheduled prune job; no application-code call sites.
- `docs/rollouts/2026-07-04-ci-actions-efficiency.md` — this note.
- `STATUS.md` — prepended entry.
- `docs/EFFORT-LOG.md` — mirror row.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — live board row (branch-neutral, not tracked in this repo).

No other workflow file was modified (`e2e.yml`, `security.yml`, `shared-package-pin-check.yml`,
`codex-autofix.yml`, `deploy.yml`, `sync-previews.yml` are byte-for-byte unchanged — confirmed via
`git diff --stat` before landing).

## Verification

Full local quartet run in the worktree (workflow-only change, but protocol is protocol):

```
npm run lint       # 0 errors, 308 pre-existing warnings (grandfathered backlog, unchanged)
npx tsc --noEmit   # clean, no output
npm test           # 249 test files, 2436 tests passed
npm run build      # succeeded, full route manifest printed
```

Plus workflow-specific checks:

```
npx yaml-lint .github/workflows/ci.yml                     # valid (and re-ran across all 7 workflow files)
gh api repos/jaywedgeworth22/agentic-trading/rulesets --jq '...'                 # confirmed ruleset id/name
gh api repos/jaywedgeworth22/agentic-trading/rulesets/17945518 --jq '...'        # confirmed required context = ["verify"] only
```

Standalone bash reproduction of the classify job's grep-based path classifier against 10 sample
changed-file lists (root `.md`, `docs/**`, mixed, package.json, workflow file, public asset, etc.)
— all classified as expected (docs-only vs. full-gate), see command history; not committed as a
test file since the logic lives entirely in workflow YAML `run:` steps, not application code.

## Follow-ups

- **Actions quota update:** contrary to this note's original assumption at task start (spending
  limit reportedly at $0/exhausted), PR #370's own CI/Playwright Smoke/Security runs were
  observed actually executing live (`in_progress`/`completed`) while this branch was in review —
  so the budget is not currently blocking runs. Watch the first few live runs on this PR (one
  docs-only follow-up commit, one code-touching) to confirm the `classify` job's behavior matches
  this local reasoning (in particular: that `github.event.pull_request.base.sha`/`head.sha` are
  populated as expected, and that `needs.<job>.outputs.<x>` step-conditionals behave as designed
  when the upstream job itself has a skipped step).
- **Audit-flagged candidates for a follow-up efficiency pass** (not implemented here, out of
  scope): apply the same gate-job docs-only pattern to `e2e.yml`'s `smoke` job, and consider
  dropping/narrowing the `push: branches: [agent/**]` trigger on `ci.yml`/`e2e.yml`/`security.yml`
  if per-PR coverage is judged sufficient without also re-running on every agent-branch push.
- **No telemetry on actual docs-only PR share** — the 15-25% estimate is qualitative (based on this
  repo's heavy per-commit doc-update discipline), not measured from GitHub's Actions usage API.
  Once minutes reporting is available again, `gh api /repos/.../actions/runs` timing data could
  replace the estimate with a measured before/after number.
- **Hybrid self-hosted+hosted runner routing** — owner re-confirmed with a resource-aware design
  after the initial objection (see "Deferred / follow-up scope" above for the full design);
  to be implemented as its own clearly-labeled PR after this one lands. The follow-up PR's
  rollout note must carry the 2026-07-01 history, the objections, the owner's re-confirmation,
  and a failure-mode table.
- **Cross-repo reusable `workflow_call` gate** — deferred until the hybrid PR lands and proves
  itself; when picked up, defaults to hosted-only execution with no self-hosted references baked
  in (resource-aware routing = explicit per-repo opt-in only).
- **Cache-hygiene follow-up worth considering separately:** the daily `prune-stale-caches` cron
  in `cleanup-caches.yml` currently targets only same-key-prefix lineages; if `setup-node`'s
  built-in npm cache (keyed only on lockfile hash, no source hash) ever starts accumulating
  multiple entries per ref for some other reason, the same grouping logic already covers it
  (verified in the local sample test) — no separate handling needed unless a new failure mode
  appears.
