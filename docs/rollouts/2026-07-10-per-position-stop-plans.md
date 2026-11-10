# 2026-07-10 — Per-position stop PLANS (LLM chooses stop TYPE at proposal time)

Agent: CLAUDE (cloud session, branch `claude/per-position-stop-plans`, stacked on PR #1331 /
`claude/stop-loss-preset-options-f1jygn`)

## Summary

Owner-directed follow-up to the 2026-07-10 broker-trailing-stops session (see
`docs/rollouts/2026-07-10-broker-trailing-stops-ui-consolidation.md`), building the deferred
"per-position stop PLANS" item from `docs/EFFORT-LOG.md`'s Planned list: the LLM can now choose a
stop **TYPE** (fixed / ATR / trailing / none) for a position at open time — distinct from the
existing per-trade stop **PRICE** (`bracketStopLoss`) — and that choice is persisted for the
position's life and honored by every stop-enforcement layer, not just the one that generated the
proposal.

1. **Schema + persistence.** `TradeProposal.stopPlan: { style: StopPlanStyle; rationale?: string }`
   (`StopPlanStyle = "default" | "fixed" | "atr" | "trailing" | "none"`), added to the LLM
   structured-output schema and `sanitizeProposals`. New `position_stop_plans` table
   (`user_id, account_number, symbol` primary key, `style`, `rationale`, `avg_cost`, `updated_at`)
   — structurally identical to the existing `take_profit_trims` ratchet. Committed **on FILL**
   (`recordFillFromProposal` in `performance.ts`), not at proposal time, mirroring the take-profit
   band pattern — a proposed-but-never-filled plan never persists.
2. **All four stop-enforcement layers now honor the SAME plan for a symbol:**
   - `generateProactiveRiskProposals` / `enrichOpeningProposal` (`strategy.ts`): a "fixed"/"atr"
     plan PINS that position's distance, ignoring the account's own ATR/beta toggles for it; a
     "trailing"/"none" plan makes this generator skip the position's fixed/ATR exit entirely
     (trailing is handled by the synthetic monitor; none needs no distance at all).
   - `runSyntheticStopMonitor` (`synthetic-stops.ts`): self-loads plans from the DB each tick. A
     "trailing" plan registers a synthetic trail even when the account has **no** `trailingStopPct`
     configured at all (using `STOP_PLAN_FALLBACK_STOP_PCT` = 8%). A "none" plan purges any
     existing registration — including one made **before** the plan was set (e.g. a scale-in add
     that reconsiders protection) — and is never re-registered regardless of the account-wide
     trailing config.
   - `reconcileBrokerProtectiveStops` (`broker-protective-stops.ts`): a new per-symbol
     `kindForSymbol` resolver that only **narrows** which of the account's own enabled lane(s)
     apply to one symbol — it never invents a broker capability the account doesn't otherwise
     have. "trailing" excludes the fixed lane for that symbol; "fixed"/"atr" exclude the trailing
     lane; "none" excludes both and tears down any existing resting broker-held stop for that
     symbol (never left resting in silent contradiction of the owner/LLM's choice).
3. **Universal availability (owner requirement B).** The ATR precompute in `strategy.ts` now also
   covers **opening candidate** symbols (not just held positions) when any candidate's proposal
   requests an "atr" plan, using the proposal's `referencePrice`/`limitPrice` as the entry anchor
   (the position doesn't exist yet). Combined with `STOP_PLAN_FALLBACK_STOP_PCT`, every style is
   genuinely selectable on an account with zero stop-loss/trailing configuration at all.
4. **No hidden prioritization (owner requirement A).** `app/console/guardrails/stop-flow.tsx`
   gained a 4th lane — "Per-position override" — extending the existing distance/trailing/
   enforcement diagram (not a disconnected UI element). `DashboardSnapshot` grew
   `stopPlanBySymbol` (self-loaded server-side, best-effort); `deriveProtection`
   (`app/console/lib/derive.ts`) annotates the Positions table's protection column with the active
   plan — a "none" plan is surfaced **prominently** (its own distinct label/tone, never blended
   into the generic "nothing configured" case) with its rationale; `approval-card.tsx` shows the
   LLM's chosen style + rationale in the "If you approve" summary for a fresh (non-default) plan.
5. **Pre-trade validation stance for `stopPlan: "none"`:** deliberately **not** hard-blocked in
   `policy.ts`'s `evaluateTradeProposal` — per the repo's "real trading, owner's risk" product
   philosophy, a risk-increasing owner/LLM choice is never gated. The schema already asks for a
   rationale; enforcement is honest UI surfacing (Positions column, approval card), never a
   scolding block.

## Why

The prior session (broker-trailing-stops-ui-consolidation) deliberately deferred this item —
"per-position LLM-chosen stop plans... deliberately NOT ridden along" — because it's a money-path
change spanning ~6 modules plus a migration, and needed its own verify cycle. The owner's two
sharpened requirements from that session (no hidden prioritization; universal availability) apply
directly here: a per-position plan is a NEW way the app could secretly override account settings
if not surfaced, and it must genuinely work for every symbol regardless of the account's own
configuration, or it's not really a choice.

## Decisions made

- Kept the LLM-facing schema minimal (`style` + `rationale` only, no per-trade numeric
  overrides for trail%/ATR-multiple) — the position reuses the account's own configured numeric
  parameters (or the `STOP_PLAN_FALLBACK_STOP_PCT` fallback) combined with the chosen style, to
  limit schema/validation surface area.
- `STOP_PLAN_FALLBACK_STOP_PCT = 8` lives in `src/lib/types.ts` (shared across `strategy.ts`,
  `synthetic-stops.ts`, `broker-protective-stops.ts`) rather than being duplicated per-module —
  matches `DEFAULT_POLICY.riskRules.stopLossPct` so a plan-only position gets the same protection
  a fresh account ships with by default.
- `reconcileBrokerProtectiveStops`'s per-symbol kind resolution only **narrows**, never invents:
  a "trailing" plan on an account whose only enabled lane is Robinhood's fixed stop gets **no**
  broker-held stop for that symbol (not a forced trailing stop bypassing the account's own
  `brokerTrailingStops` off-switch) — the always-on synthetic monitor is the universal fallback
  that DOES genuinely honor "trailing"/"none" per-symbol unconditionally. Broker-held enforcement
  stays what it always was: additive, narrower-scoped protection, not the universal-availability
  guarantee itself.
- Did not add a new pre-trade validation gate for `stopPlan: "none"` — consistent with the
  product-philosophy rule that risk-increasing owner choices are never hard-blocked.
- ATR precompute for opening candidates only extends to symbols the LLM actually proposed opening
  this run (not the full market-scan candidate universe) — avoids uncapped `fetchDailyOHLC` calls
  purely for prompt-time ATR-availability visibility the schema doesn't need.

## Files

- `src/lib/types.ts` — `StopPlanStyle`, `STOP_PLAN_STYLES`, `StopPlan`, `STOP_PLAN_FALLBACK_STOP_PCT`;
  `TradeProposal.stopPlan`; `EquityOrder.orderClass` (unrelated fix, see PR #1331 round 6/7 notes —
  landed via the merge chain onto this branch).
- `src/lib/db.ts` — `position_stop_plans` CREATE TABLE (baseline `migrate()` block — brand-new
  table, no versioned migration needed).
- `src/lib/db-api-keys.ts` — `PositionStopPlan`, `getStopPlans`/`recordStopPlan`/`clearStopPlans`.
- `src/lib/performance.ts` — `recordFillFromProposal` persists a fresh non-default `stopPlan` on
  an opening buy/short fill.
- `src/lib/strategy.ts` — `stopPlanSchema` (LLM tool-call schema) + `sanitizeProposals` coercion;
  `stopPlanBySymbol` precompute (self-loaded via `getStopPlans`) threaded into
  `generateProactiveRiskProposals` and `enrichOpeningProposal`; ATR precompute extended to opening
  candidates; `clearStopPlans` call alongside the existing `clearTakeProfitTrimBands` close sweep.
- `src/lib/synthetic-stops.ts` — self-loads `stopPlanBySymbol`; purge-on-"none" pass; registration
  loop honors "trailing" (with fallback %) and skips "none"/excluded symbols.
- `src/lib/broker-protective-stops.ts` — `stopPlanBySymbol` param + `kindForSymbol` per-symbol
  narrowing, applied throughout sections 3 (mismatch/cancel) and 4 (placement).
- `src/lib/account-deletion.ts` — `position_stop_plans` added to `DELETE_TABLES_BY_USER_ID`.
- `app/dashboard-types.ts` / `src/lib/dashboard.ts` — `DashboardSnapshot.stopPlanBySymbol`.
- `app/console/lib/derive.ts` — `deriveProtection` accepts an optional `stopPlan` and annotates.
- `app/console/components/positions.tsx` — wires `snapshot.stopPlanBySymbol` into `deriveProtection`.
- `app/console/components/approval-card.tsx` — shows a fresh non-default `stopPlan` on the card.
- `app/console/guardrails/stop-flow.tsx` — new "Per-position override" 4th lane.
- Tests: `test/strategy-hardening.test.ts`, `test/synthetic-stops.test.ts`,
  `test/broker-protective-stops.test.ts`, `test/position-stop-plans-db.test.ts` (new),
  `test/console-live-data-derive.test.ts`, `test/stop-flow-model.test.ts`.

## Review fixes round 1 (Codex on PR #1371, commits `90fb3ce`/`82c3503`, 8 findings)

1. **`strategy.ts` ATR precompute for opening candidates skipped market/stop-entry proposals** —
   the filter required `p.referencePrice ?? p.limitPrice > 0`, missing candidates whose price
   isn't stamped yet. Fixed: added a market-scan quote fallback (`openingEntryEstimate`), matching
   `enrichOpeningProposal`'s own anchor precedence.
2. **`stopPlanBySymbol` (in-memory) wasn't pruned alongside the DB clear** — a symbol closed then
   reopened within the SAME run could inherit its stale plan from before the DB clear at line 775
   (the map is read by closure later in the same run, at `enrichOpeningProposal`'s call site).
   Fixed: delete the same stale symbols from the in-memory map right after `clearStopPlans`.
3. **`performance.ts`'s `recordFillFromProposal` persisted the plan even on `pending_reconciliation`
   status** — a live broker order that later cancels/expires without ever opening the position
   would leave a plan row governing a lot that never existed. Fixed: gated on `fill.status ===
   "filled"`; added the missed commit-on-confirm path to `reconcilePendingFills` in `strategy.ts`
   (`commitStopPlanIfOpening`, fed from the fill's own `raw.proposal` stamp) so a fill that starts
   `pending_reconciliation` and later resolves to `filled` still commits its plan.
4. **`broker-protective-stops.ts`: an "atr" plan on a fixed-lane-only account priced a broker-held
   stop at the flat `stopLossPct`, silently contradicting the pinned ATR distance** (this
   reconciler has no access to the per-symbol ATR %, which lives entirely in
   `strategy.ts`). Fixed: `kindForSymbol` never maps "atr" to the fixed lane — narrower "never
   invent a mispriced broker stop," leaving ATR-plan protection to the correctly-priced synthetic
   monitor exclusively.
5. **`synthetic-stops.ts`'s purge-on-plan-change only handled the "none" transition** — a prior
   "trailing" plan later changed to "fixed"/"atr" left the old active trailing row un-purged.
   Fixed: purge on "none" **or** "fixed" **or** "atr" (any plan that explicitly excludes the
   trailing lane), not just "none".
6. **`strategy.ts`'s `enrichOpeningProposal`: a "trailing"/"none" plan discarded the stop-loss
   bracket leg but left the take-profit leg in place** — a resting take-profit-only order at the
   broker itself counts as a live exit order under the coverage-aware placement checks in
   `broker-protective-stops.ts`/`synthetic-stops.ts`, making them think the position is already
   fully covered and skip registering the actual trailing stop; it also asked Alpaca for a
   `order_class: "bracket"` order with only one leg present, which the gateway isn't built to send
   correctly. Fixed: a "trailing"/"none" plan now discards BOTH bracket legs — protection is the
   trailing lane (or nothing) alone; take-profit-taking still happens via the independent laddered
   take-profit-trim system.
7. **A "fixed"/"atr" plan preserved a "valid" LLM-proposed `bracketStopLoss` instead of always
   repricing to the pinned distance** — every other enforcement layer for that symbol prices off
   the SAME pinned distance, so honoring the LLM's own number let this one bracket leg silently
   diverge from the plan. Fixed: "fixed"/"atr" plans always reprice, never keep the LLM's stop.
8. **`app/console/lib/derive.ts`'s `deriveProtection`: a non-`"none"` plan spread the BASE
   protection unchanged, so an account with no matching stop configured (`base.label: null`)
   rendered "—" even though the plan's `STOP_PLAN_FALLBACK_STOP_PCT` fallback is real, active
   protection.** Fixed: falls back to the plan's own label (and tone `"pos"`) when the base
   derivation found nothing to show.

## Review fixes round 2 (Codex on PR #1371, commit `82c3503`, 5 more findings)

9. **`performance.ts`: a `"none"` plan with no (or blank) rationale still persisted and suppressed
   every stop-enforcement layer** — the schema *asks* for a rationale on `"none"` but doesn't
   *require* one at the LLM-output level, so an unexplained no-stop choice was non-auditable in
   Approvals/Positions. Fixed in `sanitizeProposals`: a `"none"` style with no non-empty rationale
   downgrades to `"default"` before it's ever recorded or displayed.
10. **`strategy.ts`'s `sanitizeProposals` collapsed an EXPLICIT `stopPlan.style: "default"` to
    `undefined`**, indistinguishable from "the LLM never touched this field" — which falls through
    to the STALE persisted `stopPlanBySymbol` entry instead of clearing it, so a scale-in add could
    never actually reset a position back to the account's own precedence once overridden. Fixed:
    `sanitizeProposals` now preserves an explicit `"default"` (exported for direct unit testing);
    `recordFillFromProposal` (`performance.ts`) and `commitStopPlanIfOpening`
    (`reconcilePendingFills`, `strategy.ts`) both now call `clearStopPlans` when the fresh plan's
    style is `"default"`, instead of silently no-op'ing.
11. **`strategy.ts`'s `bracketWholeShareMinimum` didn't know about "trailing"/"none" plans that
    strip BOTH bracket legs (fix #6 above)** — it could still bump a sub-share order up to a whole
    share solely to support a bracket that would never actually be sent. Fixed: threaded
    `stopPlanBySymbol` through `applyDeterministicSizing` into `bracketWholeShareMinimum`, which now
    skips the whole-share bump entirely for "trailing"/"none" plans.
12. **`broker-protective-stops.ts`'s `kindForSymbol`: a "fixed" plan on an account where BOTH lanes
    are configured (trailing wins the account-wide precedence) was wrongly excluded from the fixed
    lane**, even though that lane is independently, genuinely enabled — `kind === "fixed"` reads
    the precedence-resolved value, not "is fixed available at all." Fixed: a "fixed" plan now
    checks `brokerProtectiveStopsEnabled(policy, executionMode)` directly instead of comparing
    against `kind`.
13. **`app/console/lib/derive.ts`'s `deriveProtection`: a "none" plan on an account with an
    app-managed stop CONFIGURED (but no actual resting broker order) kept the config-derived "App
    stop..." label**, even though every enforcement layer suppresses its own stop for that symbol
    once "none" is set — showing a positive/protected label for a position the owner/LLM chose to
    run bare. Fixed: only a REAL, independently-verified `"Broker stop"` label survives a "none"
    plan; any config-derived label is overridden to "No stop (LLM choice)"/warn.

New/updated tests: `test/strategy-hardening.test.ts` (new `sanitizeProposals` describe block; the
3 `enrichOpeningProposal` trailing/none tests updated for the both-legs-stripped behavior; a new
fixed/atr-always-reprices test), `test/broker-protective-stops.test.ts` (new atr-never-broker-held
test; the mislabeled "only trailing" fixed-plan test split into a genuinely-trailing-only case plus
a new both-lanes-enabled case matching finding #12 exactly), `test/console-live-data-derive.test.ts`
(2 new tests for findings #8 and #13), `test/position-stop-plans-db.test.ts` +
`test/reconciliation-risk.test.ts` (new tests for the pending_reconciliation gate and the
explicit-default-clears-an-override behavior, at both the `recordFillFromProposal` and
`reconcilePendingFills` layers). Full gate (lint/tsc/3490 tests/build) green.

Separately: the repo's automated `autofix` GitHub Action (Claude-driven, fires on Codex review
events, would otherwise have auto-applied straightforward findings) failed on this PR's head commit
with `DEEPSEEK_API_KEY` resolving empty — an Actions-secrets configuration issue, unrelated to this
PR's diff, requiring owner action (not fixed here; all 13 findings above were instead fixed
manually in this session).

## Review fixes round 3 (Codex on PR #1371, commit `c64bd06`, 8 more findings)

1. **`bracketWholeShareMinimum` didn't know a "fixed"/"atr" plan ALWAYS attaches a stop leg** —
   even with the account's own `stopLossPct`/`takeProfitPct` both 0, the plan's universal-
   availability fallback (`STOP_PLAN_FALLBACK_STOP_PCT`/real ATR pct) still guarantees a bracket at
   `enrichOpeningProposal`. The sizing function's early `if (stopPct <= 0 && takePct <= 0) return
   undefined` skipped the whole-share bump for these plans, leaving a sub-share order that then had
   its guaranteed-but-never-actually-attachable bracket stripped by the sub-share branch. Fixed: a
   `planGuaranteesStopLeg` check (`plan === "fixed" || plan === "atr"`) bypasses that early return.
2. **A scale-in that omits its OWN `stopPlan` but inherits a persisted one never stamped it onto
   the returned proposal** — `enrichOpeningProposal` applied the inherited plan (stripping/repricing
   brackets) but left `next.stopPlan` as whatever it started (usually `undefined`), so
   `ApprovalCard`'s disclosure (which reads `p.stopPlan` directly) never showed the owner that an
   inherited "none"/"trailing"/fixed/atr choice governed the order. Fixed: stamps `next.stopPlan =
   { style: plan }` whenever an inherited (non-"default") plan applies and the proposal didn't
   already carry its own.
3. **The "trailing"/"none" bracket-leg-stripping only ran INSIDE the whole-share bracket branch** —
   a SUB-share Alpaca dollar order with LLM-supplied bracket fields skipped that branch entirely
   (`canUseWholeShareBracket` false), so the fields survived; the Alpaca gateway's `isBracket =
   !!(bracketTakeProfit || bracketStopLoss)` then still treated it as a bracket dollar order and
   REJECTED it for being below one whole share, even though the plan never wanted a bracket at all.
   Fixed: the strip now runs unconditionally, before the whole-share branching decision.
4. **`stopPlanBySymbol`'s load only copied `.style`, never comparing the persisted `avgCost` to the
   live position's `averageCost`** — unlike `planTakeProfitTrims`' own ratchet, which resets on a
   basis mismatch. A symbol closed and re-bought before any run observed it flat (a fast
   broker/manual close+reopen the app's own `clearStopPlans` sweep never caught between ticks) could
   have its stale plan silently govern a completely different lot. Fixed: extracted a new exported
   `filterStopPlansByLiveBasis` (mirrors the take-profit ratchet's `Math.abs(avgCost - live) < 0.005`
   pattern) — a symbol with no live position at all, or a basis mismatch, is dropped.
5. **`evaluateTradeProposal`'s bracket-permission gate didn't recognize an explicit stop plan** — on
   a bare account (no `"bracket"` in `permittedOrderTypes`, no `stopLossPct`), a "fixed"/"atr" plan's
   guaranteed fallback bracket would get attached by `enrichOpeningProposal` but then REJECTED in
   review, making fixed/ATR per-position stops unusable on exactly the accounts universal
   availability was meant to cover. Fixed: `proposal.stopPlan?.style === "fixed" || "atr"` is now an
   additional green-light alongside the two existing ones.
6. **`deriveProtection`'s non-"none" branch reused the account-wide `base.label`/`base.tone`
   whenever ANY base label existed, regardless of whether it actually described the mechanism the
   plan pins** — e.g. a "trailing" plan on an account with only a flat stop configured showed "App
   stop −8%" (describing the FIXED mechanism, not the trail actually protecting the position), and a
   halted-but-bare account could show a plan as actively protecting (`tone: "pos"`) even though the
   plan's own enforcement (the same scheduler-tick monitor as the account-wide rules) is paused too.
   Fixed: the label/tone are now built from `stopPlan.style` and `policy.systemState === "halted"`
   directly — never inherited from the base label's content. A REAL resting broker stop order still
   wins outright (accuracy over any plan's intent), same principle as the "none" branch.
7. **The opening-candidate ATR precompute reused a HELD position's ATR pct for a scale-in with an
   "atr" plan** — the filter excluded any symbol already present in the (held-position) ATR map, so
   a fresh entry's bracket got priced off the OLD lot's averageCost-anchored ATR%, which can be
   materially wrong if the stock moved since the original entry. Fixed: opening candidates now always
   get their own fresh computation, written to a dedicated `atrStopPctByOpeningSymbol` map (bars are
   still cache-shared with the held-position pass; only the pct computation re-runs with the fresh
   entry anchor) — `enrichOpeningProposal` now receives this dedicated map, never the held-position
   one.
8. **A "default" (no explicit plan) opening could get an ATR bracket stop attached even with NO
   base stop-loss % configured** — `policy.atrStops === true` alone (without `stopLossPct > 0`) was
   enough to use `atrStopPctBySymbol[sym]` in the "default" precedence branch, contradicting the
   held-position precompute's own gate a few hundred lines above (`atrStops === true && stopLossPct >
   0`) — ATR only ever SCALES an already-enabled flat stop, it doesn't invent one alone. Fixed: added
   the same `flatStopPct > 0` requirement to the "default" branch's ATR usage.

New/updated tests: `test/strategy-hardening.test.ts` (new `filterStopPlansByLiveBasis` describe
block; a stamped-inherited-plan assertion added to the existing scale-in test; a new sub-share
bracket-leg-stripping test; two new ATR-gating tests for finding 8), `test/antigravity-cheap-wins.test.ts`
(two new whole-share-bracket-bump tests for finding 1), `test/policy.test.ts` (new bracket-permission
describe block for finding 5), `test/console-live-data-derive.test.ts` (label/tone rewritten tests for
finding 6, replacing the now-inapplicable "label unchanged" test). Full gate (lint/tsc/3511 tests/build)
green. Finding 7 (the ATR-map wiring fix itself) has no dedicated automated test — the fix lives
entirely in the untested top-level orchestrator function, same as the rest of that function's
existing wiring; flagged here rather than adding a heavier integration test for one narrow case.

## Verification

```bash
npx tsc --noEmit      # clean
npm run lint          # 0 errors, 376 pre-existing warnings (grandfathered)
npx vitest run        # 317 files, 3511 tests, all passing
npm run build         # succeeds
```

## Follow-ups

- This branch was stacked on `claude/stop-loss-preset-options-f1jygn` (PR #1331), which received
  Codex review rounds 5-9 while this feature was being built; each round's fix was landed on the
  base branch first (isolated worktree), then merged into this branch (5 merge commits: rounds
  5, 6, 7, 8, 9 — see `git log` on this branch for the exact merge points).
- `evaluateTradeProposal`'s lack of a `stopPlan: "none"` gate is a deliberate design choice (see
  "Decisions made"), not an oversight — flagged here so a future reviewer doesn't assume it's
  missing validation.
- Broker-held short trails remain a known follow-up (PR #1331's own follow-up list) — a short
  position's "trailing" plan is honored by the synthetic monitor only, same as the account-wide
  trailing setting.
- The `autofix` GitHub Action needs its `DEEPSEEK_API_KEY` repo secret restored (owner action) —
  see the note above.
