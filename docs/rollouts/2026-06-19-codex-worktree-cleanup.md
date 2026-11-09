# 2026-06-19 - Codex worktree cleanup

## Summary

Normalized the Codex worktree after the Claude pickup and preserved Codex patches
were reapplied. The index had a partial staged/unstaged split across the same
files, so all files were unstaged without reverting content, then the three
documented change sets were verified together:

- UI expert audit polish.
- Shared market-data pending demand.
- Claude pickup Market Scan VWAP follow-up.

## Why

The mixed index made the tree look conflicted even though the file contents were
coherent and documented. With Codex now the only active tool, the safest cleanup
was to keep the content, verify the combined state, and commit from a clean
single-stage view.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-19-ui-expert-audit-polish.md`
- `docs/rollouts/2026-06-19-market-data-pending-demand.md`
- `docs/rollouts/2026-06-19-claude-pickup-vwap-scan.md`
- `docs/rollouts/2026-06-19-codex-worktree-cleanup.md`
- All code and test files listed in the three feature rollout notes above.

## Verification

- `npx tsc --noEmit` passed.
- `npm test` passed: 31 files, 242 tests.
- `pm2 stop trading-codex` completed before the build to avoid `.next` races.
- `npm run build` passed.
- `git diff --check` passed.
- `pm2 restart trading-codex` completed.
- `curl -sS -o /tmp/trading-codex-health-worktree.txt -w '%{http_code}\n' --max-time 30 http://127.0.0.1:4101/api/health` returned `200`.
- `curl -sS -o /tmp/trading-codex-scan-worktree.json -w '%{http_code}\n' --max-time 45 http://127.0.0.1:4101/api/scan` returned `200`.

## Follow-ups

- Push `agent/codex` only when the user wants the branch published.
- Keep the older `codex ops observability security wip before origin-main sync`
  stash untouched; it predates this cleanup.
