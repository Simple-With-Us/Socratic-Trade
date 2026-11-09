# 2026-06-20 - Test/Paper/Brokerage documentation alignment

## Summary

- Fast-forwarded the Codex worktree to the integrated `main` tip after the
  broker-honesty redesign.
- Aligned current-state planning docs and the architecture blueprint with the
  runtime labels `Test`, `Paper`, and `Brokerage`.

## Why

The active code now uses `test/local`, `broker/paper`, and `broker/live` for LLM
mode semantics, and user-facing labels are `Test`, `Paper`, and `Brokerage`.
Several current docs still used the older `Mock/Local` and `Broker Live`
language, which could cause future agents to implement against stale terms.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/architecture-blueprint.md`
- `docs/phase-7-strategy.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-20-terminology-doc-alignment.md`

## Verification

- `npx tsc --noEmit` passed.
- `npm test` passed: 37 files, 261 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `pm2 restart trading-codex` restarted the Codex preview on port 4101 after
  the build regenerated `.next`.
- `curl -sS -D - http://127.0.0.1:4101/api/health` returned `HTTP/1.1 200 OK`
  and `{"ok":true}`.

## Follow-ups

- Older rollout notes intentionally remain historical and may still mention
  `Mock/Local` where that was the label at the time.
- A seeded Paper UI smoke fixture is still useful so visual checks can verify
  broker-hosted paper mode without live credentials.
