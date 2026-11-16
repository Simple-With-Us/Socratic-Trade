# Rollout: UX improvement program Waves A–E complete

## Context & Objective

Owner-requested top-to-bottom web + iOS review was turned into `docs/design/ux-improvement-program.md` (PR #2400) and implemented via a multi-agent PR wave. This note records full merge of the core program to `main` (auto-deploy era).

## Changes Made (by PR)

| Wave | PR | Summary |
|------|-----|---------|
| 0 | #2400 | Program design + effort board |
| A4+A5 | #2411 | Advanced rulebook closed; PWA Proposals noun |
| B1 | #2413 | Plain nav Home/Scan/Activity/Results/Macro |
| A2 | #2414 | Approval progressive disclosure + sticky CTAs |
| A3 | #2417 | First-run readiness checklist hero |
| A1 | #2418 | Honest strategy-run skip statuses |
| C | #2423 | Snapshot TTL cache, P&L once, scan virtuoso, React.memo |
| D | #2424 + #2431 | iOS brand/checklist/feedback + PWA polish; dual-perf tsc fix |
| B2/B4 | #2425 | Autonomy panel + Settings sticky TOC |
| B3+E | #2426 | Strategy collapsible sections; login bullets; mobile cmdk |

## Decisions & Trade-offs

- Subset PRs closed when fuller wave PRs covered the same files (avoid double-merge).
- Wave F (NAV_V2 finish, push, full Coach chat) remains deferred.
- E1 empty-state system and unauth `/` → `/welcome` left as P2 (not required for wave completeness).
- CI concurrency was the critical path; agents landed via push + auto-merge rather than local full `land.sh` under load.

## Verification State

- All listed PRs: `verify` green → squash-merged to `main`.
- Spot-check on `origin/main`: strategy-run-status, dashboard-snapshot-cache, readiness-checklist, TableVirtuoso, autonomy id, settings TOC, iOS #12616f, PWA Proposals heading present.

## Next Steps & Blockers

1. Confirm Coolify auto-deploy absorbed tip via `bash scripts/verify-deploy-sha.sh` when deploy settles.
2. Optional P2 follow-ups: E1 empty states, welcome-for-unauth apex, Wave F items.
3. Discard leftover agent worktrees / `grok/ux-*` local branches when convenient.

## Zero-Code Findings

None remaining for core waves — implementation landed.
