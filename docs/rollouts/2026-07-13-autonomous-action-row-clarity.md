# 2026-07-13 — Autonomous-action row clarity: tense-matched verbs + de-collided authority labels

Branch: `claude/autonomous-action-row-clarity` (CLAUDE / Fable seat)

## Summary

Two display-only console fixes in the decision vocabulary, no logic/behavior change:

1. **Tense-matched action-row verbs.** The Home "Autonomous actions" feed
   (`app/console/page.tsx`) rendered each row as `{SYMBOL} {verb} [status-chip]`
   where `verb` was `SIDE_LABEL[side]` — always PAST TENSE ("Bought"/"Sold"/
   "Shorted"/"Covered"), derived purely from order side regardless of whether
   anything executed. The chip is the real lifecycle status. So a merely-proposed
   or BLOCKED decision read **"AAPL Bought [Proposed]"** or **"AAPL Bought
   [Blocked]"** — the past-tense verb falsely asserted a completed purchase when
   nothing was bought. Now the verb is tense-matched to status: past tense ONLY
   when an order actually reached the broker, infinitive intent otherwise, plus a
   muted "· not placed" cue on the terminal no-order states.

2. **De-collided decision-status vs authority-mode labels.** On the decision trace
   page (`app/console/decisions/[id]/page.tsx`) the header shows the status chip
   "Proposed" right next to the authority chip, which `AUTHORITY_LABELS` in
   `app/console/lib/labels.ts` labeled "Propose"/"Decide". "Proposed" (status) next
   to "Propose" (authority mode) are two different concepts that collided as
   near-identical words and read like a typo. Relabeled to "Ask-first"/"Autopilot"
   — the exact vocabulary the rest of the app already uses for these same two
   authority modes (`derive.ts` `authorityWord`).

3. **Ticker logo before the symbol on autonomous-action rows.** `DecisionRow`
   rendered `<SymbolButton showLogo={false}>`; dropped that override so the company
   logo (default `showLogo=true`, `logoSize="sm"`) shows right before the ticker.
   The "Portfolio" pseudo-symbol branch stays logo-less. Purely additive display.

## Why

This is a real-money trading app. Telling the user "Bought" when nothing was
bought — because the decision was only proposed, or was BLOCKED — is a
trust/correctness bug, not cosmetics. The owner's exact confusion:
**"Bought + Blocked — did it really buy it?"** The row must unambiguously answer
"did it actually buy?" The status vocabulary (`SocraticDecisionStatus`): only
`placed` means an order actually reached the broker; the proposal-review path can
also surface raw `filled`/`executed`. Everything else placed nothing.

For fix 2: `authorityLabel` is used in exactly ONE place (the trace header,
`decisions/[id]/page.tsx:170-171`), and every other surface already says
"Ask-first"/"Autopilot", so the trace page was the lone outlier. Relabeling it
removes the Proposed/Propose collision and makes the whole app consistent.

### Before / after wording

Action rows (fix 1):
- Proposed buy — before: `AAPL Bought [Proposed]` → after: `AAPL Buy [Proposed]`
- Blocked buy  — before: `AAPL Bought [Blocked]`  → after: `AAPL Buy [Blocked] · not placed`
- Placed buy   — before: `AAPL Bought [Placed]`   → after: `AAPL Bought [Placed]` (unchanged — it really executed)

Trace header (fix 2):
- before: `[Proposed] [Propose] [updated 2d ago]`
- after:  `[Proposed] [Ask-first] [updated 2d ago]`

## Files

- `app/console/lib/action-verbs.ts` — NEW. Pure helpers extracted so they're
  unit-testable without rendering the page: `SIDE_LABEL` (past), `SIDE_INTENT`
  (infinitive), `isExecutedStatus` (`/^(placed|filled|executed)$/i`),
  `isNotPlacedStatus` (`/^(blocked|rejected|error|failed)$/i`), `sideVerb(side,
  status)`.
- `app/console/page.tsx` — dropped the local `SIDE_LABEL` const; imports
  `sideVerb`/`isNotPlacedStatus` from the new module. `decisionFromSocratic` and
  `decisionFromProposal` now compute `verb` via `sideVerb(side, status)`.
  `DecisionRow` renders a muted "· not placed" cue after the status chip when
  `isNotPlacedStatus(status)`.
- `app/console/lib/labels.ts` — `AUTHORITY_LABELS` labels "Propose"→"Ask-first",
  "Decide"→"Autopilot" (tooltips unchanged).
- `app/console/page.tsx` (`DecisionRow`) — removed `showLogo={false}` on the
  action-row `SymbolButton` so the ticker logo shows before the symbol.
- `test/console-action-rows.test.ts` — NEW. Covers `sideVerb`, `isExecutedStatus`,
  `isNotPlacedStatus` (executed→past, non-executed→infinitive, unknown-side
  passthrough, no-side→"Observed", case-insensitivity).

Deliberately NOT touched: `decisionStatusLabel` (shared with the trace detail
page; a row-local cue was preferred per the spec). `policy-diff.ts`'s own
"Propose" map and the `/how-it-works` marketing copy are separate surfaces, out of
scope.

## Verification

Full gate on Node 24 via `scripts/land.sh` (`npx tsc --noEmit` → `npm test` →
`npm run build`). See commit/PR for exact result.

## Follow-ups

- None required. Both changes are display-only and safe under auto-deploy.
- Possible future consistency pass: `policy-diff.ts` still labels the authority
  setting "Propose"/"Decide" in policy-change diffs — harmless (no status chip
  adjacency there) but could be unified later.

## Codex autofix rounds

### Round 2 (commit `61af9725`, 2026-07-13) — preserve distinct `not_placed` status

Codex P2 finding: `deriveActionRows` in `page.tsx` preferred persisted Socratic
decisions over fresh proposals, but the "confirmed no-order path" in `strategy.ts`
persisted decisions as `"error"` via `placing_failed`, which `isNotPlacedStatus`
at that time did NOT recognize — so the broker-verified "no order exists" case
never showed the "· not placed" cue.

Fix: added `not_placed` to `SocraticDecisionStatus` (types.ts), to
`socraticStatusFromProposalStatus` (socratic-runtime.ts), and to
`isNotPlacedStatus` (action-verbs.ts). The broker-confirmed no-order path
(strategy.ts:2508-2513) now persists `status: "not_placed"` instead of `"error"`,
and the `error` branch (uncertain broker-unreachable case) is excluded from
`isNotPlacedStatus` so it shows no cue.

### Round 3 (commit `cb1372c1`, 2026-07-13) — persist `filled` status on sync fills

Codex P2 finding: when the broker returns a synchronous fill (`execution.state ===
"filled"`), `strategy.ts:2564` persisted the Socratic decision as `"placed"` while
the fill was correctly recorded as `"filled"` in `recordFillFromProposal`. The
action row, driven solely by `decision.status`, rendered past-tense verb only for
`filled|executed` — so a synchronously-filled order showed infinitive ("Buy
[Placed]") instead of past-tense ("Bought [Placed]").

Fix: pass `status: execution.state === "filled" ? "filled" : "placed"` to
`recordSocraticDecision`. Added `"filled"` to `SocraticDecisionStatus` (types.ts),
`socraticStatusFromProposalStatus`, `listSocraticDecisionCasesNeedingOutcome` and
`getSocraticOutcomeCoverage` SQL queries (db-socratic.ts), lesson guidance
(socratic-runtime.ts), and `DECISION_STATUS_LABELS` (labels.ts).
