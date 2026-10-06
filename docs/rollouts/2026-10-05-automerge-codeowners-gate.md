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
- **Self-edit:** PRs that change `.github/CODEOWNERS`, `.github/workflows/auto-merge-prs.yml`, or `scripts/pr-touches-codeowners-paths.sh` set `skip_automerge` and run `disable-on-skip-automerge`.  CODEOWNERS patterns for the gate are read from the **base** revision so the PR cannot relax its own rules.
- **Diff scope:** `pr-touches-codeowners-paths.sh` uses `merge-base(base,head)..head`, not `base..head`, so main-line drift does not false-trigger protected classification.
- **Arm step:** unexpected `gh pr merge --auto` failures emit `::error::` and fail the job (no blanket `GraphQL:` swallow).  Enumerated pending-check / conflict refusals stay non-fatal.
- **Out of scope:** GitHub required-review ruleset / CODEOWNERS review enforcement (board `bdc2b662`); this workflow gate only prevents auto-arming, not manual `gh pr merge --auto` from an agent with credentials.

## Verification State

```bash
npm run lint
npx vitest run test/pr-touches-codeowners-paths.test.ts test/branch-protection-gate.test.ts
```

PR tip (2026-10-06): Kody follow-up — anchored vs unanchored CODEOWNERS matching, pattern normalization in `load_patterns`, `CODEOWNERS_FILE` exercised in vitest.  Record exact tip SHA in `STATUS.md` after push.

Full-repo `npm test` on the cloud VM may report unrelated failures; CI `verify` is authoritative for merge.

## Next Steps & Blockers

- Owner: merge after green `verify`; no `--admin` merge.
- Optional follow-up: ruleset required review on CODEOWNERS paths (platform layer, separate from this workflow).

## Zero-Code Findings

- Prior rollout `docs/rollouts/2026-08-10-always-auto-merge-prs.md` described arming every non-draft PR; header comment in the workflow now matches the CODEOWNERS exception.
- **Kody defer (performance):** pattern matching could cache CODEOWNERS lines once per job; typical PR diffs are small and classify-protected finishes in seconds — optimize only if telemetry shows pain.
- **Kody defer (fleet recall Rule 40):** reusable lesson is captured in this rollout + `scripts/pr-touches-codeowners-paths.sh` header; separate `recall contribute` is optional owner follow-up, not a merge blocker for this CI gate PR.
