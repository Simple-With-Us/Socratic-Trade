# 2026-10-05 — Auto-merge CODEOWNERS gate (board 318bfe710b794c28)

## Context & Objective

`auto-merge-prs.yml` armed squash auto-merge on every non-draft same-repo PR when an elevated token was present.  That bypassed the fleet intent that diffs touching live-money / trading-execution paths (`.github/CODEOWNERS`) require a human merge before `main` auto-deploys.  This change adds the smallest path gate: reuse CODEOWNERS as the protected-path list, skip arming, and disable any already-armed merge when the PR diff touches those paths.

## Changes Made

- New `scripts/pr-touches-codeowners-paths.sh` — diff (or `--files` test mode) against CODEOWNERS patterns; fail-closed when the diff cannot be computed.
- `.github/workflows/auto-merge-prs.yml` — `classify-protected` job, `disable-on-protected` job, `auto-merge` gated on `touches_protected != 'true'`; `needs-human-merge` label treated like `do-not-automerge`.
- `test/pr-touches-codeowners-paths.test.ts` — pattern matching smoke tests.
- `test/branch-protection-gate.test.ts` — static guard for the new workflow jobs.

Touched paths:

- `scripts/pr-touches-codeowners-paths.sh`
- `.github/workflows/auto-merge-prs.yml`
- `test/pr-touches-codeowners-paths.test.ts`
- `test/branch-protection-gate.test.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note

## Decisions & Trade-offs

- **Single source of truth:** CODEOWNERS patterns only (no duplicate path list).  Expanding CODEOWNERS expands the auto-merge skip set automatically.
- **Fail-closed:** missing diff or missing CODEOWNERS file => do not arm auto-merge.
- **Labels:** `needs-human-merge` (merge-shepherd) now also blocks arming, matching manual hold semantics.
- **Self-edit:** PRs that change `.github/workflows/auto-merge-prs.yml` set `skip_automerge` and run `disable-on-skip-automerge` (bootstrap PR #4221 cannot arm itself).
- **Non-fatal arm step:** `gh pr merge --auto` failures from conflicts, pending checks, or org fine-grained PAT lifetime policy emit `::notice` and exit 0 so the workflow job does not go red while arming is best-effort.
- **Out of scope:** GitHub required-review ruleset / CODEOWNERS review enforcement (board `bdc2b662`); this workflow gate only prevents auto-arming, not manual `gh pr merge --auto` from an agent with credentials.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/pr-touches-codeowners-paths.test.ts test/branch-protection-gate.test.ts
npm run build
```

Full-repo `npm test` on the cloud VM reported 11 failures in unrelated suites (pre-existing on this seat); CI `verify` is authoritative for merge.

## Next Steps & Blockers

- Owner: merge after green `verify`; no `--admin` merge.
- Optional follow-up: ruleset required review on CODEOWNERS paths (platform layer, separate from this workflow).

## Zero-Code Findings

- Prior rollout `docs/rollouts/2026-08-10-always-auto-merge-prs.md` described arming every non-draft PR; header comment in the workflow now matches the CODEOWNERS exception.
