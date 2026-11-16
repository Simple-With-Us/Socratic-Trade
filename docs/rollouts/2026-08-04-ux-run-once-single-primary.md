# Rollout — UX: Run once single primary + expert panel quick wins

**Date:** 2026-08-04  
**Agent:** GROK  
**Branch:** `grok/ux-expert-review-dup-run-once`

## Context & Objective

Owner reported two **Run once** buttons within ~1 inch of each other. A four-expert panel (iOS HIG, web UX, trading desk, visual/a11y) confirmed competing primaries on web + iOS and ranked further improvements. This PR ships the P0 consolidation and high-consensus quick wins.

## Changes Made

### Canonical placement
- **Web:** chrome is the only filled Run once primary.
- **iOS:** Ready hero owns Run once when setup is complete and the proposal queue is empty; Agent controls keeps Start/Stop (and Run once only when the hero does not own it).
- **Insights / readiness / Guardrails Autonomy:** teach or status — no second filled Run once.

### Files
- `ios/SocraticTrade/HomeView.swift` — de-dupe Run once; LIVE/PAPER pill; tappable Needs attention; hide Agent overview when ready; Start agent label
- `ios/SocraticTrade/InsightsView.swift` — remove third Run primary
- `ios/SocraticTrade/AppComponents.swift` — command label glossary
- `app/console/page.tsx` — remove mobile cadence RunOnceButton
- `app/console/components/readiness-checklist.tsx` — no header Run once
- `app/console/guardrails/page.tsx` — drop Autonomy RunOnceButton
- `app/console/components/chrome.tsx` — Zap icon for Run once
- `app/console/components/approval-card.tsx` — always “Approve live” + LiveTag when live
- `app/console/console.css` — input focus-visible ring
- `app/console/lib/derive.ts` — run-once step points at top bar
- `app/console/approvals/page.tsx` — empty-state teach
- `test/console-readiness-checklist.test.ts`
- `docs/reviews/2026-08-04-expert-panel-web-ios-ux.md`
- `docs/design/ux-improvement-program.md` (PR-A6)

## Decisions & Trade-offs

- Guardrails Autonomy keeps **Start/STOP** so “is the agent on?” remains answerable on that URL; only Run once was removed as the stacked primary.
- PWA `/mobile` keeps its single control grid (one remote surface — not a duplicate chrome).
- Target-stamp (`Run once · alias · LIVE`) deferred to PR-A7 (money-adjacent copy; design already specified).

## Verification State

```bash
npx vitest run test/console-readiness-checklist.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

1. PR-A7: stamp Run once with account + PAPER/LIVE  
2. PR-A1: skip honesty on Home  
3. iOS STOP confirm parity with web  
4. Remaining expert backlog in `docs/reviews/2026-08-04-expert-panel-web-ios-ux.md`
