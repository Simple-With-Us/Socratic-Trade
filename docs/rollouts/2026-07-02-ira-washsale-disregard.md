# 2026-07-02 - ira-washsale-disregard

Branch `claude/ira-washsale-disregard` (cut from `origin/main` @ 0cdd509, right after
PR #323 — wash-sale handling modes — merged with the round-2 review fixes in 02c5532).
Owner-requested follow-up.

## Summary

**IRA wash-sale disregard setting.** The Rev. Rul. 2008-5 IRA-replacement hard block is now
the DEFAULT of a per-account setting instead of an unconditional rule:

- New account-scoped **`taxSettings.iraWashSaleHandling: "block" | "disregard"`**
  (default `"block"` = the pre-existing hard block, byte-compatible; validated in
  `/api/policy`).
- **"disregard"**: an IRA rebuy of a taxable-loss-locked symbol PROCEEDS through the normal
  authority flow — no blocking reason is pushed, all other gates unchanged, override tokens
  remain irrelevant to IRA outcomes. NEVER silent: `decision.washSale` records the new outcome
  **`"ira_disregarded"`** carrying the verbatim owner-approved note
  **"Wash Sale (Technically, but IRA purchase unreported to IRS)"**
  (`IRA_WASH_SALE_DISREGARD_NOTE` in policy.ts) plus the usual priced provenance
  (binding account, clearDate, disallowedLossUsd, estimatedTaxCostUsd).
- Audit trail exactly like auto_proceeded: the run loop and `executeProposal` both emit a
  **`wash_sale_ira_disregarded`** audit event with the full washSale record.
- Rendering: the approvals card shows the note (warn tone, honest tooltip) whenever
  `decision.washSale.note` is present; the Activity feed humanizes the
  `wash_sale_ira_disregarded` event with the verbatim note, the contributing account, and the
  technically-forfeited deduction dollars (`dashboard-feed.ts`).
- Guardrails → Tax rules: new "IRA wash-sale rebuys" select next to washSaleHandling with
  honest help copy (what Rev. Rul. 2008-5 destroys, that brokers don't report cross-account
  IRA wash sales to the IRS, that disregarding is an explicit audit-risk acceptance, and that
  disregarded purchases are annotated). block→disregard classifies **LOOSER** (typed CONFIRM
  on LIVE); settings-search entry added.
- The taxable-buyer paths (block/ask/auto machinery, override tolerance, escalation
  framework) and the 02c5532 buyerIsIra precedence logic are untouched.

## Why

Owner decision (rationale verbatim in intent): wash-sale purchases in an IRA are not reported
to the IRS by brokers and only matter under audit — so whether to respect the wash-sale rule
when rebuying inside an IRA should be the account owner's per-account call, with the strict
hard block remaining the default. The design keeps every safety property: default unchanged,
loosening costs the typed word on LIVE, the disregard is annotated on the card and in
Activity, and every disregarded execution is audited.

## Files

- `src/lib/types.ts` — `IraWashSaleHandling`, `TaxSettings.iraWashSaleHandling`,
  `WashSaleGateAudit.note` + outcome `"ira_disregarded"`
- `src/lib/defaults.ts` — `DEFAULT_TAX_SETTINGS.iraWashSaleHandling: "block"`
- `src/lib/policy.ts` — `IRA_WASH_SALE_DISREGARD_NOTE`; buyerIsIra branch is now
  setting-aware (disregard proceeds annotated; block copy names the setting)
- `src/lib/strategy.ts` — run loop + approval path audit `wash_sale_ira_disregarded`
- `src/lib/dashboard-feed.ts` — Activity humanization for the new event
- `app/console/components/approval-card.tsx` — renders `decision.washSale.note`
- `app/console/guardrails/field-defs.ts` — "IRA wash-sale rebuys" select (LOOSER on disregard)
- `app/api/policy/route.ts` — enum validation
- `app/settings-search.ts` — `guardrails.iraWashSaleHandling` entry
- `test/washsale-modes.test.ts` — default unchanged (all modes), disregard proceeds with the
  verbatim note in block/ask/auto, other gates still bind, override tokens irrelevant,
  ConnectedAccount-row detection
- `test/console-policy-diff.test.ts` — LOOSER/TIGHTER classification
- `test/ira-washsale-api.test.ts` (new) — API enum validation round-trip
- `docs/rollouts/2026-07-02-ira-washsale-disregard.md`, `STATUS.md`, `PLAN.md`

## Verification

- `npm run lint` — 0 errors (grandfathered warnings only)
- `npx tsc --noEmit` — clean
- `npm test` — 2344 passed (237 files)
- `npm run build` — succeeds

## Codex review fixes — round 1 (applied by the coordinator session; the build agent hit its
## usage-credit limit before this review arrived)

All three P2 findings verified against the code and confirmed real:

1. **Surface IRA-disregard to proposal generation** (`strategy.ts` prompt path +
   `strategy-prompts.ts` + `execution-mode.ts` + `policy.ts`). The gate now permits IRA
   locked rebuys under `disregard`, but the LLM prompt still told the model to "NEVER propose"
   a locked buy (its `washSaleHandling` defaults to `block`), so autonomous runs would never
   surface the very rebuys the setting exists to allow. Fix: extracted the gate's IRA-buyer
   precedence into a shared exported `isIraTaxRegime(...)` (so the gate and the prompt cannot
   drift); widened `ExecutionAccount` to carry `taxationType` (additive — the full row is already
   passed at runtime); threaded an `iraWashSaleDisregard` flag into `taxContext` and
   `buildBullSystem`; added a wash-sale guidance line that PERMITS proposing locked rebuys for a
   disregard IRA (annotated + audited), taking precedence over the taxable-buyer
   block/ask/auto branch. `STRATEGY_PROMPT_VERSION` → `agentic-strategy@1.2.0`.
2. **Defer the IRA-disregarded audit to actual execution** (`strategy.ts` run loop). The
   `wash_sale_ira_disregarded` / `wash_sale_auto_proceed` trail fired at gate-eval time, so an
   idea that only became a PENDING card under Ask-first/propose authority logged an Activity
   entry claiming the wash sale was disregarded and the deduction forfeited even if the owner
   rejected or let it expire. Fix: removed the gate-time audit; a new `auditWashSaleProceed(...)`
   helper fires the trail only at the actual paper-fill and live-placement points. A propose-mode
   card that is later approved gets the trail from `executeProposal` when the order places.
3. **Require an approved decision before logging the disregard** (`strategy.ts`
   `executeProposal`). The approval-path trail fired before the `!decision.approved` block, so a
   re-evaluation that returned `approved:false` for another gate (daily cap, buying power,
   staleness) while still carrying `ira_disregarded` logged a forfeiture for an order that never
   placed. Fix: gated that audit on `decision.approved`.

Round-1 verification: tsc clean, lint 0 errors, full suite green, build ok (after merging
`origin/main` post-#325/#327). Tests extended in `test/washsale-modes.test.ts` (prompt-guidance
assertions) — the audit-timing paths are covered by the gate-outcome tests plus the deferral logic.

## Follow-ups

- The mobile policy.patch whitelist intentionally does NOT accept `iraWashSaleHandling`
  (consistent with the other wash-sale loosening knobs) — loosening stays a console action.
- The legacy dashboard's approvals UI does not render `decision.washSale.note`; the console
  is the primary surface. Port if the legacy UI outlives expectations.
