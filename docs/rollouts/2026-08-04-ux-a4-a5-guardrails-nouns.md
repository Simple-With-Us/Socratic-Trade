# Rollout: UX PR-A4 + PR-A5 — Guardrails Advanced collapsed + PWA Proposals noun

**Date:** 2026-08-04  
**Author:** GROK  
**Branch:** `grok/ux-a4-a5-quick`  
**Program:** `docs/design/ux-improvement-program.md` §PR-A4, §PR-A5

## Context & Objective

Wave A trust/action clarity: (A4) progressive disclosure on Guardrails so the Advanced rulebook does not dominate first visit; (A5) align PWA section heading with console/iOS noun **Proposals** (not Approvals). Paths stay `/console/approvals`.

## Changes Made

- **A4:** `Advanced rulebook` Card uses `defaultOpen={false}` so it starts collapsed. Essentials and Protective stops remain `defaultOpen` (open). No policy field defaults or values touched.
- **A5:** Mobile PWA section heading `Approvals` → `Proposals` for pending trade proposals.

### Files touched

- `app/console/guardrails/page.tsx`
- `app/mobile/mobile-pwa-client.tsx`
- `docs/rollouts/2026-08-04-ux-a4-a5-guardrails-nouns.md` (this note)
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board)

## Decisions & Trade-offs

- Collapsed Advanced only; Protective stops stay open so stop-flow remains visible without hunting Advanced.
- Did not rename console path `/console/approvals` or internal ids — user-visible label only on PWA heading this slice (console nav already says Proposals).
- Helper copy that says “approvals” as process language (e.g. typed-confirm helper) left alone; not a section title.

## Verification State

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run lint
npx tsc --noEmit
```

- Display-only; no policy semantics change.
- Smoke: Guardrails page Advanced starts closed; PWA heading reads Proposals.

## Next Steps & Blockers

- None for this slice. Remaining Wave A items (A1–A3) are parallel peers on other branches.
- Optional later: full cross-surface Approvals→Proposals sweep in help/assistant strings (out of A5 scope as specified: PWA + trade-proposal user-visible).
