# Home proposal rows — real ids, honest tones, keyboard access

## Context & Objective

Expert review cluster `home-proposal-rows` (`dweb-01`, `dweb-18`, `a11y-01`): Home's latest-run rows used synthetic ids, wrong chip tones, a dead Approve button, and click-only divs.  Wire rows to persisted proposal ids and shared console helpers so Approve works and failure states read honestly.

## Changes Made

- Strategy run trace items now carry the persisted `trade_proposals.id` (`src/lib/strategy.ts`, types in `app/dashboard-types.ts`, `src/lib/dashboard-feed.ts`).
- Shared `proposalChipTone` / `isProposalRowApprovable` helpers in `app/console/lib/action-verbs.ts`.
- Home `ProposalRow` uses real ids, honest chip tones via `decisionStatusLabel`, Approve only when `approvable && pending|proposed`, and a native `<button>` row control with `SymbolButton` outside the activation target (`app/console/page.tsx`).
- Regression tests in `test/console-action-rows.test.ts` and `test/e2e-money-path.test.ts`.

**Files touched**

- `src/lib/strategy.ts`
- `app/dashboard-types.ts`
- `src/lib/dashboard-feed.ts`
- `app/console/lib/action-verbs.ts`
- `app/console/page.tsx`
- `test/console-action-rows.test.ts`
- `test/e2e-money-path.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-19-home-proposal-rows.md`

## Decisions & Trade-offs

- Approve stays on Home only for rows with a real `trade_proposals` id and status `pending`/`proposed`; blocked/error/failed and Previous Trades (Socratic case ids) never show Approve.
- Empty `latest.proposals` arrays fall back to `pendingProposals` (`.length ? trace : pending`), fixing the `??` trap when the array exists but is empty.
- Row keyboard access uses a sibling `<button>` instead of `role="button"` on a div containing `SymbolButton`, avoiding nested interactive elements.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/console-action-rows.test.ts test/e2e-money-path.test.ts
npm run build
```

All passed in Cursor Cloud (2026-08-19).

## Next Steps & Blockers

- Owner merge when ready; auto-deploy on merge to `main`.
- Remaining review clusters (connections bundle, Day P&L, a11y contrast) are out of scope for this PR.

## Zero-Code Findings

None.
