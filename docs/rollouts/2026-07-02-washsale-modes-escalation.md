# 2026-07-02 - washsale-modes-escalation

Branch `claude/washsale-modes-escalation` (cut from `origin/main` @ 78ecc98, after the
console QA pass that added `taxSettings.washSaleMinLossUsd` and the tax.ts
`WashSaleLockMap` provenance landed). Owner-locked spec.

## Summary

Wash-sale handling modes + a narrow Decide-mode escalation framework:

1. **`taxSettings.washSaleHandling: "block" | "ask" | "auto"`** (account-scoped, default
   `"block"` = pre-existing behavior, byte-compatible).
   - `"block"`: a wash-sale-locked BUY is refused outright (now with priced provenance in
     the reason: `~$X of tax deduction forfeited; clears YYYY-MM-DD`).
   - `"ask"`: the locked BUY becomes a **pending-approval card** instead of a block — in
     BOTH propose and decide authority — priced with the estimated forfeited deduction
     (`disallowed lossUsd × shortTermRatePct`). Card/notification copy: *"Rebuying {SYM}
     now forfeits ~${cost} of tax deduction (wash sale — loss in {account}, clears
     {date}). Your call."*
   - `"auto"`: the system decides deterministically — the buy proceeds only when
     `washSaleExpectedEdgeUsd >= WASH_SALE_AUTO_EDGE_MULTIPLE (3) × cost`; otherwise it is
     skipped with the full guard math in the block reason. Both outcomes are recorded on
     `decision.washSale` and audited (`wash_sale_auto_proceed`) — never silent.
2. **IRA-replacement HARD BLOCK regardless of mode** (Rev. Rul. 2008-5): when the buying
   account is a roth/traditional IRA (detected via `taxSettings.taxationType` OR the
   broker-reported `accountCapabilities.accountType`) and the symbol is locked (locks are
   only ever contributed by taxable accounts), the buy is always refused — in every mode,
   ignoring override tokens, and even when the per-account `washSaleGuard` flag is off
   (resolveTaxSettings force-disables that flag for IRAs, so it must not be able to switch
   off the cross-account permanent-harm rule). Copy names the permanent destruction.
3. **Escalation framework (Decide mode)**: soft-blocked proposals become pending-approval
   cards with the block reason on them instead of dying. Closed allowlist
   (`GateEscalationKind`): `"ask"`-mode wash sales (both authorities) + time-context gates
   (daily/hourly notional caps, daily opening-order cap, quote/scan staleness — Decide
   only). NOT escalatable (visible blocked entries): red-team veto, negative-EV skip,
   below-threshold conviction (all upstream of the gate), auto-mode wash-sale skips. Never
   escalated (hard): IRA wash-sale, per-order notional caps, shorting disabled,
   blocklisted/universe symbols — these produce no escalation entry by construction, and
   `shouldEscalateDecision` requires EVERY reason to be covered.
4. **Guardrails UI (console → Tax rules)**: `washSaleHandling` select (new `"select"`
   FieldKind with `options` + `looseRank`) with honest per-mode help copy incl. the
   always-on IRA hard block, beside the existing `washSaleMinLossUsd` field. block→ask/auto
   classifies **LOOSER** (typed CONFIRM on LIVE); tightening back is one click.

## Safety design (policy.ts stays authoritative)

- The gate (`evaluateTradeProposal`) remains the single enforcement point and still
  resolves the cross-account locked map itself (`getUserWashSaleLockProvenance`) when the
  caller omits it — the "cannot be silently bypassed" contract is unchanged.
- Escalated cards **re-run the FULL gate at approval time**. The ONLY override is the
  wash-sale gate's: when the run loop escalates a card it mints a `crypto.randomUUID()`
  token per escalatable failure into the persisted decision JSON
  (`trade_proposals.decision.escalations[].token`) and the audit ledger
  (`proposal_escalated`). At approval, `executeProposal` derives override handles from
  that STORED row only (`approvedEscalationsFromDecision` — filters to tokenized
  `wash_sale_ask` entries) and threads them as `PolicyContext.approvedEscalations`. No
  API accepts these from a client, so there is no client-settable bypass flag.
- The override is honored ONLY when handling is still ask/auto (tightening back to
  "block" voids it), only for the matching symbol, never for IRA buyers, and never for
  any other gate — a still-binding daily cap at approval time still blocks the card.
  Honoring it is audited (`wash_sale_override_applied`, with the token).
- Time-context escalations carry tokens for audit but are deliberately NOT overridable —
  their gates simply re-evaluate against then-current caps/quotes (they self-heal).
- R1 §1.4.3 preserved: a Decide-mode run that trips a notional/order cap still
  auto-demotes the account to Ask-first even though the tripping proposal now survives
  as a pending card.
- Auto-mode edge signal (documented in `washSaleExpectedEdgeUsd`):
  `estimatedNotional × takeProfitPct × confidenceScore` — the trade's planned profit
  target discounted by the model's stated conviction, i.e. the two per-proposal signals
  the platform already trusts with money (conviction drives the deterministic sizer;
  takeProfitPct is the executed exit plan). `bracketTakeProfit` (with a known
  referencePrice) takes precedence. Missing conviction/target/notional ⇒ $0 edge ⇒
  fail-safe skip.
- LLM context: in ask/auto, `taxContext.washSaleRebuyCosts` gives the model the priced
  cost per locked symbol (provenance + `estimatedTaxCostUsd`) and the bull prompt's
  wash-sale line explains the mode; in "block" the prompt/context stay byte-identical.
  `STRATEGY_PROMPT_VERSION` bumped to `agentic-strategy@1.1.0`.

## Codex review fixes (post-PR; all three findings verified against the code and confirmed)

1. **P1 — IRA detection missed `ConnectedAccount.taxationType`.** The gate checked only
   `policy.taxSettings.taxationType` and broker `accountCapabilities.accountType`; a
   legacy/manual IRA row (capabilities absent or reporting "brokerage", policy without
   taxationType) was treated as taxable, so ask/auto could escalate/auto-approve a rebuy
   whose deduction Rev. Rul. 2008-5 destroys permanently. Fixed: new
   `PolicyContext.accountTaxationType` (the ConnectedAccount row's value — the source of
   truth, mirroring dashboard.ts's tax-summary overlay) threaded from `activeAccount` at
   ALL THREE gate call sites (run loop, `executeProposal`, from-draft route) and checked
   FIRST in the IRA detection. Tests: IRA-by-connected-account-only in ask AND auto, with
   capabilities absent and with capabilities reporting "brokerage".
2. **P2 — stale-priced override tokens.** The approval-time override was honored by
   kind/symbol/token alone; if another taxable loss posted between escalation and
   approval, the user approved at the old (lower) cost and the order executed at a
   materially higher real cost. Fixed: `ApprovedEscalation.approvedCostUsd` carries the
   cost PRICED ON THE APPROVED CARD (from the stored escalation's washSale payload); the
   gate honors the token only while the recomputed cost is within
   `washSaleOverrideCostTolerance` = max($1, 1%) of it (decreases always honor).
   Otherwise outcome `"reescalated_cost_changed"`: the stale token is refused with a
   "changed since you approved (~$old -> ~$new)" reason plus a FRESH escalatable entry at
   the current price, and `executeProposal` keeps the card PENDING (status stays
   proposed) with newly minted tokens + a `proposal_reescalated` audit + notification —
   the owner re-approves at the honest price. Tests: unchanged/decreased/within-tolerance
   honor; increase beyond tolerance re-escalates with both figures; unpriced-then-priced
   re-escalates.
3. **P2 — ask-mode drafts 409'd.** `app/api/proposals/from-draft` rejected every
   non-approved decision except staleness-only, so an assistant-drafted wash-sale BUY
   under handling "ask" got `409 POLICY_BLOCKED` instead of the promised pending card.
   Fixed: the route now mirrors the run loop — when every (non-preview-staleness) reason
   is escalatable per `shouldEscalateDecision`, it stages the proposal `proposed` with
   server-minted tokens persisted in the stored decision, audits `proposal_escalated`
   (source chat), and returns `201 { escalated: true }`; dry-run returns an additive
   `escalatable: true` so the assistant UI (`app/ui/assistant-console.tsx`) shows a
   "Needs your call" state with the priced reasons and a Stage button instead of a plain
   block. handling "block" still 409s (test kept); the new ask-mode staging test seeds
   its own per-test DB fixture.

Additional files touched by the review fixes: `app/api/proposals/from-draft/route.ts`,
`app/ui/assistant-console.tsx`, plus the test files above.

## Why

Owner-approved design: a hard 30-day block is the right default, but for a taxable
account the wash-sale rule is a *priced* cost, not an absolute prohibition — the owner
wants the option to be asked (with the dollar cost on the card) or to let the system
proceed when the edge clearly dominates the cost. The IRA case is different in kind
(deduction destroyed permanently), so it stays a hard block everywhere. The escalation
framework generalizes "ask" narrowly to gates whose failures are about *when* the
proposal ran (caps consumed, stale quote), which a later human approval naturally
re-checks — without weakening any gate that guards *what* the proposal is.

## Files

- `src/lib/types.ts` — `WashSaleHandling`, `TaxSettings.washSaleHandling`,
  `GateEscalationKind`/`GateEscalation`/`ApprovedEscalation`/`WashSaleGateAudit`,
  `PolicyDecision.escalations`/`.washSale`
- `src/lib/defaults.ts` — `DEFAULT_TAX_SETTINGS.washSaleHandling: "block"`
- `src/lib/tax.ts` — `WashSaleLock.lossUsd` (summed in-window disallowed loss;
  binding account/clearDate preserved by `mergeWashSaleLock`)
- `src/lib/policy.ts` — mode-aware wash-sale gate (IRA hard block, ask escalation,
  auto edge guard, override handling), `WASH_SALE_AUTO_EDGE_MULTIPLE`,
  `washSaleExpectedEdgeUsd`, escalatable time-context push sites,
  `PolicyContext.washSaleLocks`/`.approvedEscalations`
- `src/lib/strategy.ts` — run-loop escalation branch (token minting,
  `proposal_escalated` audit, pending_approval notification, cap auto-revert kept),
  `shouldEscalateDecision`, `approvedEscalationsFromDecision`, approval-path override
  threading + `wash_sale_override_applied` / `wash_sale_auto_proceed` audits,
  `taxContext.washSaleRebuyCosts`
- `src/lib/strategy-prompts.ts` — mode-aware wash-sale prompt line; version 1.1.0
- `app/api/policy/route.ts` — `washSaleHandling` validation
- `app/console/lib/policy-diff.ts` — `"select"` FieldKind + rank-based classify
- `app/console/components/policy-form.tsx` — select renderer + honest default labels
- `app/console/guardrails/field-defs.ts` — Tax rules `washSaleHandling` def
- `app/console/guardrails/page.tsx` — Tax rules intro copy
- `app/settings-search.ts` — `guardrails.washSaleHandling` search entry
- `test/washsale-modes.test.ts` (new, 34 tests), `test/washsale-provenance.test.ts`,
  `test/console-policy-diff.test.ts`, `test/policy.test.ts`,
  `test/staleness-gate.test.ts`, `test/strategy-hardening.test.ts` (tax-mock updates)
- `docs/rollouts/2026-07-02-washsale-modes-escalation.md`, `STATUS.md`, `PLAN.md`

## Verification

- `npm run lint` — 0 errors (grandfathered warnings only)
- `npx tsc --noEmit` — clean
- `npm test` — full suite green (see STATUS.md for count)
- `npm run build` — succeeds

## Codex review fixes — round 2 (applied by the coordinator session; original lane hit its
## session limit mid-loop)

All three round-2 findings verified against the code and confirmed real before fixing:

1. **IRA detection is precedence, not union** (`src/lib/policy.ts`). The old OR-chain let a
   stale IRA value in `policy.taxSettings.taxationType` classify a buyer as an IRA even when
   the ConnectedAccount row said `"taxable"` — wrongly applying the Rev. Rul. 2008-5 hard block
   to taxable rebuys (unapprovable in ask mode, blocked even guard-off). Now
   `context.accountTaxationType` DECIDES when present; only when the row is silent do the
   weaker signals (policy taxSettings, broker capabilities) speak, still as a union — absent
   the source of truth, mistaking an IRA for taxable permanently destroys basis, so the
   conservative fallback stays. Tests: row-taxable + stale-policy-IRA escalates in ask mode /
   proceeds guard-off; all pre-existing IRA fallback tests unchanged.
2. **Cap demotion now binds the current run** (`src/lib/strategy.ts`
   `autoRevertOnCapBreach`). The demotion wrote `strategyAuthority: "propose"` to storage but
   left the loop's in-memory policy on `"decide"`, so later proposals in the same run kept
   producing decide-style soft-blocked cards after the account was demoted to Ask-first. The
   function now also updates the passed policy object in place, binding all four call sites.
3. **Refusal-path writes can no longer revive non-pending rows** (`src/lib/strategy.ts` +
   new `transitionProposalIfPending` in `src/lib/db-proposals.ts`). The wash-sale
   re-escalation wrote `status='proposed'` unconditionally; a proposal expired by the
   scheduler or rejected in another tab during the approval's async scan/review could be
   resurrected with fresh override tokens. Both approval-refusal writes (re-queue 'proposed'
   and retire 'blocked') now use an atomic `status='proposed'` CAS (same shape as
   `claimProposalForExecution`); a lost race audits `proposal_reescalation_skipped` and
   returns the row's actual status instead of re-queuing. Tests: 4 new CAS tests in
   `test/deep-safety-fixes.test.ts`.

Round-2 verification: lint 0 errors, tsc clean, **2298 tests pass (235 files)**, build green —
after merging `origin/main` @ post-#324.

## Follow-ups

- The approvals card renders escalated block reasons via the existing "Policy gate"
  reasons list; a dedicated wash-sale cost callout on the card would be a nice polish.
- `mobile-api.ts` policy.patch whitelist intentionally does NOT accept
  `washSaleHandling` (consistent with `washSaleMinLossUsd`) — loosening stays a
  console action with the typed-word ritual.
- Consider surfacing `wash_sale_auto_proceed` / `proposal_escalated` audit events with
  dedicated humanized copy in the Activity feed (they render via the generic audit path
  today — visible, not silent).
- Behavior note: the IRA-replacement block now applies even with `washSaleGuard: false`
  (previously the whole gate was skipped). Documented in the field help; intentional per
  spec ("always block").
