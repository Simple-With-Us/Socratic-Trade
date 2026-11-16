# 2026-08-10 — Default theme is light (fleet owner ruling)

## Context & Objective
Owner: stop dark-first / system-default that lands on dark. Product default is light.

## Changes Made
- `app/ui/theme.tsx` init script: no stored pref → light (not OS dark)
- `app/console/lib/useConsoleTheme.ts`: default light; cycle light→dark→system
- `app/console/console.css` theming docs updated
- iOS `SocraticTradeApp`: `.preferredColorScheme(.light)`
- Fleet rules: FLEET-UI-COPY, AG***-S**C, AGENTS.md, global grok rules

## Screenshots
UM ASC screenshots already light — no redo required for this rule alone.

## Verification
- tsc clean (ST)
