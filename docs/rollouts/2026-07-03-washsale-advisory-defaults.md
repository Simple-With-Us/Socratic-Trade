# 2026-07-03 - washsale-advisory-defaults

## Summary

- Flipped the shipped defaults for the wash-sale gate: `taxSettings.washSaleHandling` default
  changed from `"block"` to `"auto"`; `taxSettings.iraWashSaleHandling` default changed from
  `"block"` to `"disregard"` (`DEFAULT_TAX_SETTINGS` in `src/lib/defaults.ts`). `block`/`ask`
  remain valid enum values — persisted policies may still reference them, and the console
  Guardrails "Tax rules" selects still offer all options — they are simply no longer the default.
- Mid-task owner course-correction (see "Why"): removed the deterministic edge-vs-tax-cost
  threshold that used to gate `"auto"` mode. `"auto"` now ALWAYS proceeds on a wash-sale-locked buy.
  The priced tax cost (`estimatedTaxCostUsd`) and the expected-edge figure
  (`washSaleExpectedEdgeUsd`) still ride `decision.washSale` as receipt telemetry (never silent),
  and are now explained to the strategist LLM in the system prompt so it can weigh the tax cost
  against its own conviction and say so in the rationale.
- `WashSaleGateAudit.outcome` union: removed `"auto_skipped"` (now unreachable — `"auto"` never
  refuses). `WASH_SALE_AUTO_EDGE_MULTIPLE` is retained only to label the `edgeMultiple` receipt
  field, no longer as a veto threshold.
- `STRATEGY_PROMPT_VERSION` bumped `"agentic-strategy@1.2.0"` → `"agentic-strategy@1.3.0"` (the
  Bull system prompt's wash-sale guidance line changed).
- Every place that previously read `taxSettings?.washSaleHandling ?? "block"` /
  `taxSettings?.iraWashSaleHandling ?? "block"` as an inline fallback (not just the DB-seeded
  default) now derives from `DEFAULT_TAX_SETTINGS`, so an explicitly-`undefined` field behaves the
  same everywhere (`src/lib/policy.ts` lines ~537/574 equivalent, `src/lib/strategy.ts`
  taxContext construction).
- UI copy updated to describe the actual default (console Guardrails Tax rules selects,
  `app/settings-search.ts` search-index help text) — "(default)" labels moved from Block to
  Auto/Disregard, and the "edge must beat cost" / "ONLY when edge clears Nx" framing was rewritten
  since that threshold no longer exists.
- All receipt/annotation/audit machinery is untouched: the verbatim IRA-disregard note
  ("Wash Sale (Technically, but IRA purchase unreported to IRS)"), the `wash_sale_*` audit events
  (`wash_sale_ira_disregarded`, `wash_sale_auto_proceed`, etc.), the approvals-card rendering, and
  the ask-mode escalation/override-token framework (shared with time-context gates like daily/
  hourly notional caps) all behave exactly as before.

## Why

- **Owner decision, settled**: the wash-sale gate must not hard-block by default. This is part of
  the broader "nothing is hard except the account" guardrail philosophy — see
  `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md` on branch
  `claude/correct-drawdown-decision` (unmerged as of this note; referenced for the philosophy, not
  yet integrated into this branch).
- **Mid-task spec update (owner, relayed by coordinator)**: after the initial defaults-flip was
  underway, the owner rejected keeping the `"auto"` mode's deterministic edge-vs-cost veto. The
  rationale: `washSaleExpectedEdgeUsd`'s inputs (`confidenceScore`, `bracketTakeProfit`, order size)
  are themselves the LLM's own outputs — comparing them against a fixed `WASH_SALE_AUTO_EDGE_MULTIPLE`
  (3x) constant wasn't an independent check, it was re-arithmetizing the model's own judgment and
  then vetoing on an arbitrary multiple. The fix moves the *real* deterministic information (the
  priced tax cost) to where it belongs: into the strategist's prompt context (so the model can
  weigh it against its own conviction) and onto the decision receipt (so the owner can see it) —
  rather than using it as a silent second-guessing mechanism.
- **Second mid-task note (owner, relayed by coordinator)**: the owner is currently the app's only
  user, so no backward-compatibility contortions were added for hypothetical other users' saved
  settings. No migration shims, no "(kept for compatibility)" hedging in copy/comments. The
  block/ask enum values were kept (cheaper than deleting them, and `block`/`ask` share the
  escalation framework with time-context gates), but nothing was added purely to protect a
  hypothetical other user's persisted policy.
- **IMPORTANT nuance preserved, not changed further**: taxable `"auto"` mode's math
  (`washSaleExpectedEdgeUsd`, `estimatedTaxCostUsd`) is retained as receipt telemetry per the
  owner's course-correction above — it is no longer a gate, but the owner may in the future want
  even the receipt-math simplified or reframed. Flagging for future consideration, not acted on
  here.

## Files

- `src/lib/defaults.ts` — `DEFAULT_TAX_SETTINGS.washSaleHandling` → `"auto"`,
  `DEFAULT_TAX_SETTINGS.iraWashSaleHandling` → `"disregard"`, updated doc comments.
- `src/lib/types.ts` — `WashSaleHandling`/`IraWashSaleHandling` doc comments rewritten for the new
  defaults and "auto always proceeds" semantics; `TaxSettings.washSaleHandling`/
  `iraWashSaleHandling` field comments updated; `WashSaleGateAudit.outcome` union drops
  `"auto_skipped"`, comments on `expectedEdgeUsd`/`requiredEdgeUsd`/`edgeMultiple` and each outcome
  updated.
- `src/lib/policy.ts` — the two `?? "block"` inline fallbacks (taxable `handling`, IRA
  `iraHandling`) now derive from `DEFAULT_TAX_SETTINGS`; the `"auto"` branch of the wash-sale gate
  rewritten to always proceed (no `requiredEdgeUsd` comparison, no `wash_sale_auto_skip` reason, no
  `auto_skipped` outcome) while still recording `expectedEdgeUsd`/`edgeMultiple` on the audit;
  updated doc comments on the gate, `WASH_SALE_AUTO_EDGE_MULTIPLE`, and `washSaleExpectedEdgeUsd`.
- `src/lib/strategy.ts` — the two `?? "block"` inline fallbacks in the taxContext-construction
  section now derive from `DEFAULT_TAX_SETTINGS`; updated surrounding comments.
- `src/lib/strategy-prompts.ts` — removed the now-unused `WASH_SALE_AUTO_EDGE_MULTIPLE` import; the
  `"auto"` wash-sale guidance line rewritten from "allowed ONLY when expected edge is at least Nx
  the priced cost" to "this is your judgment call — weigh `taxContext.washSaleRebuyCosts` against
  conviction, account for the tax cost in the rationale"; `STRATEGY_PROMPT_VERSION` bumped to
  `1.3.0`; doc comment on the `washSaleHandling` param field updated.
- `app/console/guardrails/field-defs.ts` — `TAX_RULES` select option labels moved "(default)" from
  Block to Auto/Disregard (now "Block (strict)" / "Auto (proceeds, priced) — default" and
  "Block (strict)" / "Disregard (accept audit risk) — default"); hint text rewritten to describe
  auto's always-proceeds behavior instead of the removed threshold.
- `app/settings-search.ts` — help text for `guardrails.washSaleHandling` and
  `guardrails.iraWashSaleHandling` rewritten to match the new defaults and auto's behavior.
- `test/washsale-modes.test.ts` — header safety-contract comment rewritten; default-mode describe
  block replaced (asserts unset `washSaleHandling` → `"auto"`, and a policy with no `taxSettings`
  at all still gets auto+disregard defaults — new test per the brief); explicit-`"block"`-mode
  tests unchanged in behavior, just retitled/regrouped; "auto" describe block rewritten (proceeds
  even at small/zero/unpriceable edge — `auto_skipped` tests deleted, replaced with
  always-proceeds assertions that still check the receipt telemetry); IRA-hard-block describe
  block now explicitly sets `iraWashSaleHandling: "block"` on every case (previously relied on the
  unset-defaults-to-block fallback); added a new "IRA wash-sale default" describe block asserting
  unset `iraWashSaleHandling` → `"disregard"`.
- `test/ira-washsale-api.test.ts` — "defaults to 'block'" test renamed/changed to assert
  `"disregard"`.
- `test/console-policy-diff.test.ts` — blank-value classification tests recomputed for the new
  default ranks (`washSaleHandling` blank now resolves to `"auto"` rank 2; `iraWashSaleHandling`
  blank now resolves to `"disregard"` rank 1) — tightening/loosening directions flipped
  accordingly; a same-as-default case now asserts `"changed"` per the existing pattern.
  `looseRank`/`options` orderings themselves are unchanged.
- `test/chat-draft-policy.test.ts` — the "does not stage a wash-sale-blocked buy draft" test now
  explicitly sets `taxSettings.washSaleHandling: "block"` on its policy (previously relied on the
  DB default; under the new default the same draft would silently auto-proceed at $0 priced edge
  instead of hard-blocking, and even the reason-string assertion would break because "auto"'s
  message text differs from "block"'s).
- `test/policy.test.ts` — three tests ("blocks a buy of a wash-sale-locked symbol when the guard is
  on...", the two `getUserWashSaleLockProvenance` call/no-call tests) now explicitly opt into
  `taxSettings.washSaleHandling: "block"` since they rely on `enabledPolicy` (which inherits
  `DEFAULT_TAX_SETTINGS`) hard-blocking a locked buy.
- `test/run-strategy-offline.test.ts` — updated a stale comment ("Default block" → "an explicit
  stricter opt-in, no longer the default"); added a new test asserting the "auto" prompt line no
  longer contains threshold language and does contain `taxContext.washSaleRebuyCosts` /
  "YOUR judgment call" / `estimatedTaxCostUsd`, satisfying the "add one test asserting the prompt
  taxContext includes a locked symbol's priced cost" ask via the prompt-builder unit test (no
  existing test exercised the deeper `strategy.ts` taxContext construction directly, and adding
  DB/LLM-mock integration scaffolding for that was out of scope for this change).
- `STATUS.md` — new entry (this rollout).
- `docs/EFFORT-LOG.md` — new "In Progress" row (landing deferred).
- `docs/rollouts/2026-07-03-washsale-advisory-defaults.md` — this file.

## Verification

- `npm run lint` — 0 errors, 295 warnings (pre-existing grandfathered backlog; none introduced).
- `npx tsc --noEmit` — clean (exit 0). One round of fixes needed: three `test/policy.test.ts`
  edits initially spread `enabledPolicy.taxSettings` (typed `TaxSettings | undefined`, so
  `shortTermRatePct`/`longTermRatePct` became `number | undefined`); replaced with an explicit
  `TaxSettings` literal.
- Targeted suite: `npx vitest run test/washsale-modes.test.ts test/ira-washsale-api.test.ts test/console-policy-diff.test.ts test/chat-draft-policy.test.ts test/policy.test.ts test/run-strategy-offline.test.ts test/tax.test.ts test/washsale-provenance.test.ts test/washsale-test-account-excluded.test.ts test/staleness-gate.test.ts test/strategy-hardening.test.ts test/strategy-prompt-version.test.ts`
  — 218/218 passed across 12 files.
- `npm test` (full suite) — 2352 passed, 17 failed. All 17 failures are in exactly the 8
  pre-declared holiday-broken files: `persistence-notification.test.ts`,
  `redteam-observability-g10.test.ts`, `strategy-bear-fail-closed.test.ts`,
  `strategy-bull-truncation.test.ts`, `strategy-llm-failover.test.ts`,
  `strategy-money-path-f-g.test.ts`, `strategy-moneypath-drawdown-flip.test.ts`,
  `strategy-rationale-collapse-gate.test.ts`. Every failure is a `run_skipped_market_closed` /
  date-sensitive assertion, unrelated to wash-sale/tax code — confirmed by inspecting each failure
  message (none reference wash-sale, tax, or the touched files). No stray `data/app.db` /
  "no such column" issue encountered.
- `npm run build` — exit 0, clean.
- A background research agent independently audited every other `test/*.ts` file that touches
  `evaluateTradeProposal`/`runStrategyOnce` or the wash-sale surface
  (`test/washsale-provenance.test.ts`, `test/washsale-test-account-excluded.test.ts`,
  `test/staleness-gate.test.ts`, `test/strategy-hardening.test.ts`, plus the dozen
  `runStrategyOnce`-driving files) and confirmed none of them rely on the old default/veto —
  they either test `tax.ts` lock computation directly (not gate enforcement), mock the lock
  resolver to empty, or run against a fresh temp DB with no seeded losing trades (so the lock set
  is empty regardless of mode).

## Follow-ups

- **Landing is explicitly deferred** per instruction until the holiday-date test fix (tracked
  separately, not part of this branch) merges to `main`. This branch is pushed
  (`claude/washsale-advisory-defaults`) but intentionally has **no PR** yet.
- The `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md` doc referenced above lives on
  branch `claude/correct-drawdown-decision`, which had not merged as of this note — re-check that
  reference once it lands.
- `requiredEdgeUsd` remains on `WashSaleGateAudit` as a legacy/unused optional field (no longer
  populated by the gate) — harmless, but a future cleanup pass could remove it if nothing else
  starts relying on the shape.
- The taxable "auto" mode's edge-vs-tax-cost numbers are now purely receipt telemetry + prompt
  context, not a gate. If the owner later decides even the receipt-math framing is unwanted
  (e.g., wants a simpler "rebuy proceeded, cost was $X" line with no "expected edge" figure at
  all), that's a follow-up scoping question, not something this change assumed.

## Blockers

- None for the code change itself. Landing is deferred by instruction (see Follow-ups), not
  blocked by any failing verification.
