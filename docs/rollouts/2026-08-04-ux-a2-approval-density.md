# Rollout — UX PR-A2 approval card progressive disclosure + sticky mobile CTAs

## Context & Objective

Wave A trust/action clarity (`docs/design/ux-improvement-program.md` §PR-A2): pending
approval cards were long dense receipts, so Approve/Reject sat below the fold on phone
and long desktop cards. Collapse by default; keep the full receipt one click away; stick
primary CTAs above the mobile tab bar. No change to approve/reject API or live typed
confirmation (phrase, paste disabled).

## Changes Made

- Default **collapsed** receipt: side, symbol, size/notional, Live/Paper chip, AI-critic
  (red-team) chip, confidence + thesis-tag chips, 2–3 line thesis (`line-clamp-3`),
  compact exit Est. P/L when available.
- **Show full reasoning** / **Hide full reasoning** toggle (`aria-expanded`) reveals the
  existing green/red team panels, human-review reasons, sizing provenance, R:R geometry,
  RAG citations, since-proposed, policy gate, and three-outcomes block — all prior data
  still available when expanded.
- Mobile sticky action footer (`.ac-actions`) clears `.con-tabbar` +
  `env(safe-area-inset-bottom)`; desktop footer remains static at card bottom.
- Live typed-confirm sheet: `tone="live"` parity with bulk approve; live border on summary
  box. Approve API path, `APPROVE LIVE <SYMBOL>`, and paste-disabled input unchanged.

### Touched files

- `app/console/components/approval-card.tsx` (also: export `redTeamSummaryChip` /
  `redTeamCollapsedChip`; drop card `overflow-hidden` so sticky CTAs are not contained)
- `app/console/console.css`
- `test/approvals-triage-model.test.ts` (chip helper unit tests)
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-08-04-ux-a2-approval-density.md` (this note)

## Decisions & Trade-offs

- Per-card sticky footer (not a single page-level bar): works with multi-proposal queues;
  footer unsticks when the card scrolls off. Same pattern family as Guardrails
  uncommitted sticky strip (`policy-form` `bottom-16`).
- Collapsed adds a one-line Est. P/L for exits (decision-critical); full Est. P/L block
  remains in expanded view.
- Removed `overflow-hidden` on the card root: overflow containment breaks viewport
  sticky for the action footer.
- No new dependencies; pure CSS + existing lucide chevrons.

## Verification State

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
./node_modules/.bin/vitest run test/approvals-triage-model.test.ts --pool=forks --maxWorkers=1
# 8/8 pass (triage + redTeamSummaryChip)
# Full tsc/test/build: verify CI on PR #2414 / land.sh
```

## Next Steps & Blockers

- None for A2. Peers: A3 first-run checklist can land independently; keepout on
  `approval-card.tsx` released after merge.
- Visual pass on 390×844: collapsed CTAs visible without scrolling past thesis.

## Zero-Code Findings

N/A — UI implementation.
