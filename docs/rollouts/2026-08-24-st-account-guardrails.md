# 2026-08-24 — ANTIGRAVITY — COMPLETED / PR OPEN — Kalshi & Guardrail Scope

## Context & Objective
The user requested that Kalshi "Events Contracts" settings not be a toggleable option on Alpaca Paper accounts. It must be strictly based on whether the account is a Kalshi account. Furthermore, all features (Short Selling, Options, Kalshi) must dynamically show their support status based on the selected broker's capabilities. "Live vs. Paper" terminology is strictly prohibited when discussing feature capability, as paper accounts can support the same features as their live counterparts.

## Changes Made
- Refactored `app/console/guardrails/page.tsx` entirely. 
- Kalshi accounts (`broker === 'kalshi'`) now exclusively render "Event Contracts Trading" and macro data toggles, and explicitly hide protective stops and short selling (as Kalshi does not support these).
- Non-Kalshi accounts surface the `caps.shortSelling` and `caps.optionsTrading` capabilities via a clearly labeled banner ("Fully Supported" vs "Disabled by Broker").
- Ensured default values and components dynamically respond to the `caps` object.

## Verification State
- `npm run lint` — passed
- `npx tsc --noEmit` — passed
- `npm run build` — passed

## Next Steps
- Merge this PR so the settings UI reflects accurate capabilities.
