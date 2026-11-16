# 2026-08-14 — AGENTS.md records the "local gate does not compile Swift" trap

## 1. Context & Objective

`AGENTS.md` exists for durable repo rules and cross-file traps — the things that are
cheap to check and expensive to miss.  One such trap bit this repo on 2026-08-13 and was
recorded only in a commit message and a Slack post, neither of which the next agent
reads.  This lands it where it will actually be found.

The trap: **the verify gate compiles no Swift.**  `npm run lint`, `npx tsc --noEmit`,
`npm test`, and `npm run build` — and therefore `scripts/land.sh`, which runs the last
three — never touch `ios/**`.  A completely green local gate says nothing at all about
whether the iOS app builds.

## 2. Changes Made

Added a `> [!CAUTION]` block to the "Verify before claiming done" section of `AGENTS.md`,
immediately after the four-command list, stating the gap and giving the two commands that
close it.  Docs only; no code, no behaviour change.

Touched files:

- `AGENTS.md` (`CLAUDE.md` is a symlink to it, so both carry the change — symlink verified
  intact after the edit)
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-14-agents-swift-gate-trap.md` (this note)

## 3. Decisions & Trade-offs

**Recorded in `AGENTS.md` rather than a rollout note alone.**  `AGENTS.md` is explicit
that it is for durable rules and traps, not turn-specific status.  A verification gap that
silently passes is exactly that.  The rollout note is the paper trail; `AGENTS.md` is the
thing that prevents a repeat.

**Included the concrete incident, not just the rule.**  A bare "run xcodebuild too" reads
as optional.  The failure mode is what makes it stick: git produced a duplicate
declaration across a merge WITHOUT a conflict marker, so there was no signal to
investigate, and the compiler's most visible error named an innocent file.

**Called out merges specifically.**  The instinct is to run extra checks on code you
wrote.  This class of bug appears in code you did NOT write, introduced by a merge that
reported success — which is precisely when nobody thinks to look.

**Did not add an ios build step to `scripts/land.sh`.**  Tempting, but it would put a
multi-minute Xcode build in front of every land in a repo where most changes never touch
`ios/**`, and it would fail outright on any machine without the Xcode toolchain (cloud
agents, Linux CI).  CI already runs the unsigned build on the Mac runner; the correct fix
is for agents to run it locally when the diff warrants, which is what the note now says.
If this recurs, a `paths`-conditional pre-push hook is the next step up — cheaper than a
gate change and it only fires for the diffs that need it.

## 4. Verification State

Docs-only change; no code paths altered.

```
readlink CLAUDE.md            # -> AGENTS.md (symlink intact after edit)
```

Full `tsc` / `vitest` / `build` gate runs via `scripts/land.sh` at land time, and CI's
required `verify` check re-runs it on the PR.

## 5. Next Steps & Blockers

None.  No follow-up work is implied by this change.

Adjacent and still open, unchanged by this PR: the litestream level-2/level-3 compaction
wedge is now correctly reported by `/api/health` and `/admin/backups` (PR #2709) but is
NOT repaired.  Its root cause — every Coolify rolling deploy briefly running two
litestream writers against one B2 prefix, which litestream 0.5.12 does not fence — needs
an owner-gated Coolify deploy-strategy change plus a one-time B2 delete.

## 6. Zero-Code Findings

The four-command gate in `AGENTS.md` had been correct and complete for the web app since
it was written, which is why the omission survived so long: nothing about the list looks
wrong until you notice what is not in it.  The repo grew an `ios/**` tree and a Mac-runner
CI job without the local-verification instructions growing to match.  Worth a periodic
check that the documented gate still covers everything the repo now contains.
