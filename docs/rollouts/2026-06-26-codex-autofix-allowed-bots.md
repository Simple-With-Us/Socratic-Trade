# 2026-06-26 — Fix Codex Autofix action: failing-fast on the bot-actor gate

Branch `claude/pensive-morse-77574e`. One-line workflow fix to `.github/workflows/codex-autofix.yml`
(the `anthropics/claude-code-action@v1` job added in PR #188).

## Summary
The `Codex Autofix` workflow was failing on **every** PR (~11s, before doing any work), so the Codex
reviewer's inline comments never got addressed/resolved. With ~10–12 unresolved Codex threads per PR
and the repo ruleset requiring "all review conversations resolved", every PR sat in
`mergeStateStatus: BLOCKED` even with `verify` green — forcing us to resolve Codex threads by hand.

Root cause: `anthropics/claude-code-action@v1`'s agent mode runs a **human-actor gate**
(`checkHumanActor` in `src/github/validation/actor.ts`). Any non-`User` trigger aborts with:

```
Action failed with error: Workflow initiated by non-human actor: chatgpt-codex-connector
(type: Bot). Add bot to allowed_bots list or use '*' to allow all bots.
```

This workflow exists **specifically** to respond to a bot (`chatgpt-codex-connector[bot]`), so the
default gate kills it instantly. The workflow set no `allowed_bots`, so the action saw an empty list
(`ALLOWED_BOTS:` / `"allowed_bots": ""` in every failed run's log) and refused to run.

The "directory mismatch for directory …/tsconfig.json" string the failure was originally attributed to
is a **red herring**: it's a `#` comment inside the action's composite step (the action's own
work-around note for an unrelated, already-fixed Bun `--tsconfig-override` bug, oven-sh/bun#25730).
GitHub echoes the entire run script — comments included — so the line shows up in every run's log but
is not the error. The action already auto-discovers its own `tsconfig.json`; no tsconfig handling on
our side is involved.

## Fix
Add one input to the `anthropics/claude-code-action@v1` step:

```yaml
allowed_bots: "chatgpt-codex-connector[bot]"
```

- **Explicit bot, not `*`** — defense in depth. The action's security model recommends an allow-list
  over `*` (which would let *any* bot trigger Claude → prompt-injection surface). The job's `if:`
  already restricts triggers to `chatgpt-codex-connector[bot]`, so this value is the exact complement.
- **Matching is forgiving**: `isAllowedBot` lowercases and strips a trailing `[bot]` from both the
  list entries and the actor before comparing, so `"chatgpt-codex-connector[bot]"` matches the actor
  `chatgpt-codex-connector[bot]` exactly. (`"chatgpt-codex-connector"` would also have matched.)
- Verified against the pinned action source (`v1` → `78a7209`): agent mode's **only** actor gate is
  `checkHumanActor` (`src/modes/agent/index.ts:29`) — there is no separate write-permission check that
  would also block the bot, so this single input is the complete fix.

## Why this is the right shape (vs. the alternatives in the task)
- *Pin/replace the action* — unnecessary: the action works; it just needs to be told this bot is
  allowed. The tsconfig "incompatibility" doesn't exist anymore (fixed upstream).
- *Make the job non-blocking / drop conversation-resolution* — would defeat the purpose. The whole
  point is to **auto-resolve** Codex threads so the resolution requirement is satisfied automatically;
  weakening the ruleset removes the safety the autofix exists to uphold.

## Important behavioral note (took effect only after merge to main)
For `pull_request_review`, `pull_request_review_comment`, `issue_comment`, and `workflow_dispatch`
events, GitHub **always runs the workflow definition from the default branch (`main`)** — never the
PR-branch copy. So this fix is inert on the feature branch and only changes behavior once merged to
`main`. Verification below is therefore done after merge.

## Files
- `.github/workflows/codex-autofix.yml` (the only functional change)
- `STATUS.md`, this rollout note

## Verification
- `node` js-yaml parse of the workflow → valid; `allowed_bots == "chatgpt-codex-connector[bot]"`.
- Confirmed the failure is consistent across the last several failed runs (all show empty
  `ALLOWED_BOTS` + the non-human-actor error), not the tsconfig comment.
- Full `tsc → test → build` trio via `scripts/land.sh` (workflow-only change; trio unaffected but run
  as the merge gate).
- Post-merge end-to-end: trigger Codex on an open PR and confirm the autofix run passes the actor gate
  and resolves ≥1 Codex thread. (See STATUS.md for the run link once executed.)

## Follow-up landed same day — make the autofix actually RESOLVE threads (#202 verification finding)
The allowed_bots fix (#201) was verified end-to-end on throwaway PR #202: Codex flagged two planted
bugs, the autofix run **passed the actor gate** (log: `Actor chatgpt-codex-connector[bot] is in
allowed_bots list, skipping human actor check`), fixed both bugs, ran the verify trio, and pushed
`[codex-autofix] fix percentChange denominator + average off-by-one`. **But it resolved 0/2 threads** —
a code fix only makes a Codex thread `outdated`, never `resolved`. GitHub's "require conversation
resolution" gate needs threads explicitly RESOLVED, so a working-but-non-resolving autofix would still
leave PRs blocked the moment that gate is (re-)enabled. (The live `main` ruleset currently has
`required_review_thread_resolution: false` — almost certainly toggled off as a stopgap while the bot was
broken — and only `verify` is a required check.)

Fix: added prompt step 7 instructing the autofix to RESOLVE every Codex thread it addressed (or that is
outdated/already-fixed) via the GraphQL `resolveReviewThread` mutation, while leaving threads where it
asked the maintainer a question OPEN. The workflow already has `permissions: pull-requests: write`, which
is sufficient for `resolveReviewThread`. This closes the loop so the owner can safely re-enable the
resolution gate. Branch `claude/codex-autofix-resolve-threads`.

## Follow-ups
- After this lands, re-verify on a fresh throwaway PR that the autofix now marks the Codex threads
  `resolved` (not just `outdated`).
- If the bot login ever changes, update the `allowed_bots` value, the `if:` guards, and the step-7
  author filter together.
- Consider re-enabling `required_review_thread_resolution` on the `main` ruleset once the resolve step
  is confirmed in production (owner decision).
