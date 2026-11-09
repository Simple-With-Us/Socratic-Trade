# 2026-06-23 - Settings Connections LLM setup

## Summary

Moved the Green Team model, Red Team model, and reasoning-effort controls out of
Settings -> Operate and into a renamed Settings -> Connections tab above the
provider API-key manager.

Update later on 2026-06-23: the editable Green/Red model controls moved again
into Strategy Studio after UI review. Settings -> Connections now keeps provider
keys plus a read-only model summary and an `Open Strategy Studio` link.

## Why

Provider keys are connection/provider configuration, not day-to-day trading
operation. Keeping model controls in Operate made the tab feel like mixed setup
and policy controls; the later UI pass made Strategy Studio the editable owner
for model behavior while Connections owns the keys.

## Files

- `app/dashboard-client.tsx` - renamed the Settings `API Keys` tab to
  `Connections`, moved LLM setup fields into it, refreshed the Settings
  subtitle, and left Operate focused on universe, authority, horizon, and
  autonomy.
- `STATUS.md`, `PLAN.md`, `docs/phase-11-multi-user.md` - updated handoff and
  phase docs to reflect Settings -> Connections.
- `docs/rollouts/2026-06-23-settings-connections-llm-setup.md` - this note.

## Verification

- `npx tsc --noEmit` - clean.
- `npm test` - 97 files passed, 888 tests passed.
- `npm run build` - clean.
- Focused Playwright smoke against `next start` on `127.0.0.1:4215` with a
  local Cloudflare Access test header - opened Settings, verified the
  `Connections` tab exists, verified the old `API Keys` tab is not visible,
  verified Green/Red/Reasoning controls are not on Operate and are visible on
  Connections, verified API-key content remains there, and verified
  `gpt-4.1-mini` is absent from the visible Settings model options.

## Follow-ups

- Superseded by `docs/rollouts/2026-06-23-ui-expert-strategy-macro-errors.md`
  for the final UI placement: Strategy Studio edits models; Connections manages
  keys and shows a summary.
