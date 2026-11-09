# 2026-08-04 — UX PR-A3 First-run readiness checklist

## Context & Objective

UX program (`docs/design/ux-improvement-program.md` §PR-A3): surface a Thesis-style
readiness checklist on the console Overview so a new desk has one clear next step
(connect broker → active account → universe → LLM → run once), not a blank feed.

## Changes Made

- `deriveReadinessChecklist(snapshot)` in `app/console/lib/derive.ts` — pure flags from
  real snapshot fields only (never invent readiness).
- `ReadinessChecklistHero` client component: dominant card while incomplete; collapsed
  “You’re set” when complete (dismissible).
- Wired into Overview `app/console/page.tsx`.
- Unit tests: `test/console-readiness-checklist.test.ts`.

### Touched files

- `app/console/lib/derive.ts`
- `app/console/components/readiness-checklist.tsx`
- `app/console/page.tsx`
- `test/console-readiness-checklist.test.ts`
- `docs/rollouts/2026-08-04-ux-a3-checklist.md`

## Decisions & Trade-offs

- `llmConfigured === false` is the only hard “no key” signal; `undefined` does not block
  (older payloads / partial snapshots).
- Run-once step links to Proposals; chrome Run once remains the primary action beside the hero.

## Verification State

Landing operator: skipped full local `npm test` (host load). CI `verify` is the gate.
Touches are pure UI + pure derive + unit tests.

## Next Steps & Blockers

- Merge via auto-merge when `verify` green.
- iOS Home readiness (PR-D2) should stay flag-compatible with `deriveReadinessChecklist.flags`.
