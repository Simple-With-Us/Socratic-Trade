# 2026-07-15 — Browser tab title: Socratic Trade

## Summary

Removed console-level title overrides so the browser tab resolves to the root app title, "Socratic Trade", including the Coach route.

## Why

PR #1610 carried the same user-facing change but also had stale conflict-cleanup docs. This branch reapplies only the current-main code change and a fresh rollout note.

## Files

- `app/console/layout.tsx`
- `app/console/assistant/page.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-15-tab-title-socratic-trade.md`

## Verification

- Pending hosted PR checks.

## Follow-ups

- Close superseded PR #1610 after this lands.
