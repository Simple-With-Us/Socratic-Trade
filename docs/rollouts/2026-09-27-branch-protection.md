# 2026-09-27 — Branch protection for `main`, plus the guards that keep it meaningful

Sun, Sep 27, 4:55pm

## 1. Context & Objective

Owner-directed 2026-09-27, immediately after the trading-performance-report session exposed the
concrete failure: `main` had **no branch protection** (`gh api .../branches/main/protection` ->
404), and a merge driver reading the PR-level `statusCheckRollup` read an empty rollup on a head
whose CI had not been dispatched yet as "nothing pending, nothing failed" — it would have merged a
PR whose full test suite never ran.  That driver was caught before it merged anything, but the hole
was real and the platform-level fix is the durable one.

## 2. Changes Made

### 2.1 The protection itself (a remote setting — no code in the diff)

`main` now requires, with `strict: true`:

- `verify` — the aggregate gate in `ci.yml`
- `gitleaks` — the credential guard in `security.yml`

Also: `allow_force_pushes: false`, `allow_deletions: false`,
`required_conversation_resolution: true`, `required_approving_review_count: 0`,
`enforce_admins: false`.

Both required contexts were chosen because they are **designed for this role already**, not invented
here:

- `ci.yml` and `security.yml` both trigger on `pull_request` with **no path filter**, and both
  carry a `merge_group` trigger whose comment says so explicitly — *"Required for the GitHub merge
  queue: the `verify` check must run on the queue's temporary merge_group branch, or queued PRs
  hang forever."*  The repo was already built for `verify` to be a required check; nothing was
  setting it.
- `verify` is a `needs: [classify, verify-hosted, verify-ios]` aggregate with
  `if: ${{ !cancelled() }}`, and it enumerates its pass states explicitly (docs-only, hourly
  backstop, both lanes green) and fails on everything else.  Its header already records the
  fail-open hazard: *"skipped required checks can fail open — Codex review, PR #370."*

Observed immediately after applying it: #3795 and #3792 both flipped to `MERGEABLE/BLOCKED` while
their `verify-hosted` was still running.  `verify` has no check-run at all until its dependencies
conclude, and GitHub treats a required-but-absent check as **pending** — which is the correct,
fail-closed reading, not a wedge.

### 2.2 Field-by-field reasoning (a blind paste is how a fleet wedges itself)

| field | value | why |
|---|---|---|
| `contexts` | `verify`, `gitleaks` | both always report; neither has a path filter |
| `strict` | `true` | branch must be current with main — closes the stale-UI/text land AGENTS.md warns about, and `scripts/land.sh` already re-syncs for it |
| `required_approving_review_count` | `0` | a personal repo has no second approver; a non-zero count would block **every** agent merge fleet-wide — a wedge, not a gate |
| `enforce_admins` | `false` | keeps a documented owner escape hatch for an incident hotfix.  The threat is an *accidental* ungated merge, and agents are not admins, so the guard holds where it matters |
| `required_conversation_resolution` | `true` | unresolved bot threads become a hard block rather than a mysterious `BLOCKED` |
| `allow_force_pushes` / `allow_deletions` | `false` | main cannot be rewritten out from under CI |

### 2.3 The guards — protection is invisible in a diff, so it needs two checks

`test/branch-protection-gate.test.ts` (new, 9 cases) is a **static** guard over the workflow side:
it proves `ci.yml` has no path filter on `pull_request`, that both workflows trigger on
`merge_group`, that `verify` aggregates the lanes, that it uses `!cancelled()` and never
`always()`, that it passes only on enumerated success states and requires **both** lanes, that it
keeps `set -euo pipefail`, and that the two required-context job names still exist so a rename
cannot strand the ruleset.

`scripts/verify-branch-protection.sh` (new) is the **live** counterpart.  It cannot see the
workflows, so it checks the other half of the pairing: that protection exists, and that every
required context is a job some workflow actually defines.  A required context nothing can report is
worse than no protection — every PR would hang at BLOCKED against a check that appears nowhere in
the logs.  It verifies only; the re-apply payload ships as a comment with the reasoning, because
re-applying protection is a fleet-wide act that should be deliberate.

### 2.4 Files touched

- `test/branch-protection-gate.test.ts` — new
- `scripts/verify-branch-protection.sh` — new
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- **`enforce_admins: false`, not `true`.**  Full enforcement is arguably the purer posture for a
  money-path app, but it removes the owner's ability to land an incident hotfix while CI is slow or
  down, and the guarded failure mode (an agent merging ungated) is fully covered without it.
  One `PUT` flips it; the reasoning is in the script.
- **Two guards, not one.**  A live check alone cannot catch a workflow edit that stops producing
  the required check; a static test alone cannot catch a `DELETE` on the protection endpoint.  Each
  covers the other's blind spot, which is why the script's closing reminder points at the test.
- **Not touched:** no CI job was renamed or restructured.  Protection was fitted to the gate that
  already existed.

## 4. Verification State

```
npx vitest run test/branch-protection-gate.test.ts     # 9 passed (9)
bash scripts/verify-branch-protection.sh               # exit 0, PASS
```

**Failing-first proven** — a guard that cannot fail is decoration.  Three mutations of `.github/workflows/ci.yml`,
each reverted immediately after:

| mutation | result |
|---|---|
| add `paths: ['src/**']` to `pull_request` | the "no paths filter" case fails |
| accept any non-failure lane (`!= failure \|\|`) | the "enumerated success states" case fails |
| switch `verify` to `if: ${{ always() }}` | the "does not use always()" case fails |

Green again after revert; `git diff` on `ci.yml` clean.

## 5. Next Steps & Blockers

- `scripts/land.sh` ends in `gh pr merge --auto --squash`.  That was *unsafe* before this change (no
  required checks meant auto-merge had nothing to wait for and merged immediately); it is now the
  correct mechanism.  Any seat that assumed "auto-merge lands it right away" will notice PRs now
  wait for CI — that is the intended change, not a regression.
- Worth deciding later: whether `enforce_admins` should flip to `true` once the owner is comfortable
  with the CI cadence.

## 6. Zero-Code Findings

- Protection was missing not by accident of neglect but because the repo was **built assuming it
  existed** — both required-check workflows already carry the `merge_group` trigger and the comment
  explaining that queued PRs hang without it.  The gap was purely the setting.
- All open PRs at the time were authored by the owner, so requiring `verify` blocked nothing that
  was in flight.  Re-check this before assuming the same next time: the historical
  "bot PRs can never pass the verify gate" issue was fixed by #3774, but a new untrusted-bot
  author would still sit BLOCKED rather than merge — which is the correct outcome.
