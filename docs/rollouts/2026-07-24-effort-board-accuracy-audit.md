# 2026-07-24 — Effort-board accuracy audit (CURSOR)

## Summary

Reviewed `docs/EFFORT-LOG.md` for stale / superseded / wrongly placed status claims and verified
merge/deploy accuracy against GitHub PR state and production `/api/health` release SHA.

## Why

Owner asked for an accuracy pass: In Progress had two abandoned claims (branches gone; work already
merged under other PRs), Planned still carried "IN PROGRESS"/"CLAIMED" SEC/RAG and activity-audit
rows, and Completed still led with "IN PROGRESS" for work that had already merged. `effort-issues-sync`
keys off **section headings**, so leaving finished work under In Progress reopens `state:in-progress`
issues.

## Verification method

- `gh pr view` / `gh pr list` for cited PR numbers (sample: #1820, #1292, #1751, #1451, #997, #372,
  #1371, #1847, #1792, #1892, #2143, #2155, …).
- Branch existence checks for claimed worktrees (`claude/usage-compliance-st` gone;
  `codex/socratic-infra-panel-reliability` gone; `claude/w2-coaching-durable` +
  `claude/w2-reflection-decompose` still on origin).
- Production probe: `GET https://socratictrade.com/api/health` → release SHA `b0c21339…` at audit
  time (`#2155`); `origin/main` was already at `#2143` (`f8bcc3c4`) — docs-only lag under auto-deploy.

## Files

- `docs/EFFORT-LOG.md` — corrections in place (never deleted peer rows)
- `STATUS.md`, `PLAN.md`
- `docs/rollouts/2026-07-24-effort-board-accuracy-audit.md` — this note

## Key corrections

| Claim | Finding | Action |
|-------|---------|--------|
| Usage-compliance Wave 2 In Progress | #1820 MERGED 2026-07-22; branch gone | → Completed |
| Infra panel reliability In Progress | #1292 + #1751 MERGED; branch gone | → Completed |
| SEC/RAG Planned "IN PROGRESS/CLAIMED" | Foundation/#1892 landed; enablement separate | SUPERSEDED/COMPLETED/UNASSIGNED |
| Enrichment starvation In Progress | #1287/#1301; #1272 CLOSED | → Completed |
| Activity-audit P2.5 In Progress | #1451 MERGED | → Completed |
| Settings-race / #372 / #814 / preview table / announce-then-deploy | Already merged or protocol retired | COMPLETED/SUPERSEDED |
| In Progress section | No live claims | Empty with audit note |

## Still legitimately Planned (examples)

- RAG / dormant feature enablement (OWNER REMINDER + FEATURE-ENABLEMENT-BACKLOG)
- Exit-strategy Phases B/C
- Remaining activity-audit P2.4/P2.6–P2.9 / P3 items without a merged PR
- Open PRs for stalled `w2-coaching-durable` / `w2-reflection-decompose` (branches still exist)
- Owner chore: prune ancient no-PR origin branches (needs explicit delete confirmation)

## Follow-ups

- Parallel open PR #2157 also touches `docs/EFFORT-LOG.md` — expect a merge/union conflict; prefer
  this audit's status truth when reconciling.
- Completed section still contains many historical rows whose *body* mentions "IN PROGRESS" before a
  later COMPLETED annotation; section placement is correct for sync. Optional later pass to rewrite
  lead verbs only.
- Issues API remains 403 for this cloud token — cannot close mirrored issues directly.
