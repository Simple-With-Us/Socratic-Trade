# 2026-07-15 — ST-audit execution wave 1 (MONET, owner-directed pickup of CLAUDE cap handoff)

## Summary

First execution wave of the prioritized backlog in
`docs/handoffs/2026-07-15-claude-to-monet-st-audit.md` (§8 "do-first / do-now"), implemented
by a coordinated subagent team (6 implementers + 3 adversarial reviewers + 2 fix agents),
landed as one batched PR from branch `monet/socratic-trade-audit-subagents-a100e1`.

What shipped:

1. **§6b.1(a) — boot-halt notification (P0).** `reconcileAutonomyOnBoot()`
   (`src/lib/scheduler.ts`) now sends ONE summary notification per user per boot when it
   reverts active autonomy to halted (which happens on **every auto-deploy**), naming the
   halted account(s) and both re-arm paths (Settings toggle / `autoResumeOnBoot` /
   `AUTONOMY_RESUME_ON_BOOT=1`). New `NotificationEventType: "autonomy_halted_on_boot"`
   (types.ts + dashboard-ui.ts label). Delivery uses the established forcedPolicy pattern
   (as `usage-limit-alerts.ts` / `db-health.ts` do) so pre-existing persisted notification
   policies — whose `enabledEvents` arrays predate the new type — cannot silently gate this
   P0 visibility event to "skipped"; channels/webhook still come from the account's real
   policy. Fire-and-forget (`.catch` backstop): notification failure can never break boot.
   Interlock semantics and the `autoResumeOnBoot` default are UNCHANGED (owner decision
   pending — see follow-ups).
2. **§4.3 + §6b.3 — pending-fill reconciliation (learning + visibility).**
   `reconcilePendingFills` (`src/lib/strategy-execution.ts`):
   - Re-fires `recordClosedLotExperience` when a `pending_reconciliation` **sell/cover**
     flips to `filled` via a **matched broker order** — live closed lots finally write
     episodic memory (previously paper-only). Idempotent: flip transition guard +
     stable vector id (`exp:<entry>:<exit>` accession) + content-hash dedup
     (verified at `experience-memory.ts:176`, `vector-db.ts:1777-1783`, `:2292-2320`).
   - Age-based escalation for **genuinely unresolvable** pending fills (order absent from a
     non-authoritative listing, or matched-terminal-without-price): audit event + one
     notification per fill (persisted once-marker), 30-min default threshold
     (env-overridable). Healthy matched working orders (e.g. open day limits) do NOT
     escalate — that surface belongs to stale-limit alerting. Advisory only; nothing is
     blocked or canceled.
   - The adversarial review **killed** the originally-implemented position-delta
     auto-flip fallback (infer execution from broker position quantity): quantity
     arithmetic cannot distinguish this order's execution from external/manual/MCP trades
     or pre-app holdings, so it could mark a never-executed order as filled at a fabricated
     price. Replaced with rich diagnostic context on the escalation instead.
3. **§3.1 + §3.2 — paid-for FMP data now reaches the LLM.** `compactCandidateForPrompt`
   emits `roa`, `grossMarginPct`, `tgtMean`, derived `tgtUpsidePct` (1dp, omitted entirely
   when absent — never placeholders). `deriveMetrics` prefers provider-reported
   `returnOnEquity` (FMP ratios-ttm) over the eps×pb approximation (approximation kept as
   fallback). No enrichment plumbing was needed — all four fields already reached
   `MarketQuote`/`MarketQuoteSummary` end-to-end; they were simply never read.
   Console drilldown updated to pass `returnOnEquity` through `QuoteView` →
   `deriveForView` so the owner-facing ROE tile shows the same number the model sees
   (tooltip copy updated to say provider-reported-with-fallback).
4. **§4.4 — balanced counterfactuals.** The skipped-candidate feedback block in
   `src/lib/strategy.ts` now injects top **avoided losers** (`returnPct <= -3`,
   `label:"avoided_loser"`) alongside top missed winners (`label:"missed_winner"`), budget
   split 4/4 within the existing cap of 8 (underfilled side donates), each SPY-relative via
   the tuner's existing benchmark plumbing (field omitted when SPY fetch fails — never
   fabricated). New exported pure helper `selectBalancedCounterfactuals`
   (`src/lib/strategy-prompts.ts`). The model stops only ever learning "you're too cautious."
5. **§3.7 — Alpha Vantage deregistration.** `getEnrichmentProvider` no longer registers the
   AV enrichment provider when an Alpaca data key is configured (AlpacaNews already supplies
   batched sentiment earlier in the cascade; AV added nothing while burning its 25/day free
   cap — the recurring daily quota alert). AV remains fully functional when Alpaca news is
   NOT configured. Cascade `source` attribution self-corrects (derived from registered
   providers).
6. **§7.1 — Voyage usage-monitor double-count (~2× real dollars).** Fixed at the **push
   boundary**: provider-dispatch usage events pushed/replayed to the external
   API-Usage-Monitor now always carry cost 0 (dispatch is externally a request/quota
   signal; the `rag`/`llm` ledger lanes own external cost). The **local** durable dispatch
   fuse is untouched — `reserveProviderDispatch` still records real
   `estimateVoyageDispatchCost` estimates, so the $25/day default cap and the
   `PROVIDER_DISPATCH_VOYAGE_*` operator knobs keep working (the first-cut fix zeroed the
   local estimates and was caught by the adversarial review as silently disabling that
   fuse). `docs/usage-monitor-integration.md` updated to document the invariant. No
   receiver-side change required.
7. **§5.1 — root `global-error.tsx` dark mode.** Dependency-free inline `<style>` with
   `@media (prefers-color-scheme: dark)` using the app's own `.dark` palette hex values
   (bg `#111827`, fg `#e7eef6`, accent button `#58c7d3`/`#04130d`). Light appearance
   byte-identical. No imports; the file stays self-contained (it replaces `<html>/<body>`
   so no theme system is reachable).
8. **§2 — effort-board hygiene (both boards).** Corrections (a)–(d) applied to
   `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`: back-filled Completed
   rows for merged-but-unrecorded PR #1482 (AG) and #1614 (CODEX); flipped stale
   In-Progress/Planned rows for already-merged #1593 (mirror), #1594, #1604, the four #1492
   sub-effort rows (annotating the dead #1525/#1526 PR numbers), and the TS 7.0.2 top row;
   collapsed the verbatim #1587 duplicate paragraph. All corrections in place with
   annotations; no rows deleted.

## Why

Owner directive: pick up CLAUDE's capped session (handoff doc above) and execute with a
subagent team. Wave 1 = the handoff's do-first P0 + all do-now S items. Every finding was
re-verified refute-first against the current tree before implementation (all six CONFIRMED;
none refuted). A 3-lens adversarial review (money-path on the frontier model, cross-file
consistency traps, product-philosophy/docs) produced 3 must-fix findings — two of which
(position-inference over-trust, Voyage local-fuse kill) were real money-path/ops defects in
the first-cut implementations and were fixed before landing. Product philosophy respected
throughout: everything is advisory/notify-only; no hard blocks, no paternalism, no defaults
changed.

## Files

- `src/lib/scheduler.ts` — boot-halt notification (+ helper)
- `src/lib/types.ts` — additive `NotificationEventType` `"autonomy_halted_on_boot"` (notification-event region only; AG order-machinery regions untouched)
- `src/lib/dashboard-ui.ts` — event-type label (exhaustive Record enforced by tsc)
- `src/lib/strategy-execution.ts` — reconciliation re-fire + unresolvable-fill escalation
- `src/lib/db-fills.ts` — `netAccountingFillQuantity` helper + escalation once-marker persistence
- `src/lib/strategy.ts` — counterfactual balance + prompt field pass-through (prompt/counterfactual regions only; AG placement-loop untouched)
- `src/lib/strategy-prompts.ts` — `compactCandidateForPrompt` fields + `selectBalancedCounterfactuals`
- `src/lib/derived-metrics.ts` — real-ROE preference
- `src/lib/data-providers.ts` — AV registration gate
- `src/lib/vector-db.ts` — NET UNCHANGED (first-cut zeroing reverted after review; file is byte-identical to main, which also eliminated the #1632 merge surface)
- `src/lib/usage-monitor-push.ts` — `createProviderDispatchUsageMonitorEvent` no longer threads cost into the outbound event (single provider-dispatch emission choke point; covers live pushes and crash-replay by construction)
- `app/global-error.tsx` — dark-mode styles
- `app/console/ui/drilldown-data.ts` — `returnOnEquity` through QuoteView/deriveForView + ROE tile tooltip
- `docs/usage-monitor-integration.md` — dispatch-lane cost invariant
- `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — hygiene pass + wave rows
- `STATUS.md`, `docs/rollouts/2026-07-15-st-audit-exec-wave1.md` (this note)
- Tests: `test/scheduler-boot-halt-notify.test.ts` (new), `test/pending-fill-reconcile-refire.test.ts` (new), `test/strategy-prompt-wiring-counterfactuals.test.ts` (new), `test/vector-db-voyage-dispatch-cost.test.ts` (new), `test/derived-metrics.test.ts` (+1), `test/data-providers.test.ts` (+2), `test/strategy-prompt-safety.test.ts` (version pin)

## Verification

Full gate run on the merged tree (wave commit `d2fb2208` + merge of `origin/main` @ `951fe45c`,
which brought in #1629/#1630/#1631/#1632/#1636/#1637; a second pre-land merge then brought in
#1634 @ `ab400bbc` — both merges auto-resolved with zero conflicts; overlapping files touched
disjoint regions as coordinated on #ag***-s**c. land.sh's fork-point same-file guard
(STATUS.md/docs/EFFORT-LOG.md) was bypassed with LAND_ALLOW_STALE_OVERLAP=1 only after this
deliberate merge-and-review, per the script's own instruction),
under node@24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`, node v24.18.0 — system node v26
ABI-breaks better-sqlite3):

```
npm run lint       # 0 errors (500 grandfathered warnings)
npx tsc --noEmit   # clean
npm test           # 390 files, 4470 tests — all passed (245s)
npm run build      # clean
```

Per-item targeted suites were also run by each implementing agent before the gate
(scheduler-boot-halt-notify 3/3; pending-fill-reconcile-refire 9/9 + reconciliation-risk 35/35 +
synthetic-stops 47/47; strategy-prompt-wiring-counterfactuals 9/9 + derived-metrics +
strategy-prompt-safety; vector-db-voyage-dispatch-cost 5/5 + usage-monitor push/replay/dispatch
family 495 total; data-providers 110).

Review process: 3-lens adversarial review (money-path on the frontier model, cross-file
consistency traps, product-philosophy/docs) over the pre-fix diff produced 3 must-fix findings,
all fixed and re-tested (see Why); a focused post-merge re-review then re-checked the two
rewritten regions and the semantic sanity of the origin/main auto-merge.

## Follow-ups / owner decisions surfaced

- **§6b.1(c) owner decision:** enable `autoResumeOnBoot` (or `AUTONOMY_RESUME_ON_BOOT=1`)
  in prod now that auto-deploy makes boot-halts routine? Wave 1 only adds the notification.
  §6b.1(b) (graceful-deploy marker vs crash-loop distinction) deferred — M effort.
- **§3.1 flag:** `FMP_PRICE_TARGETS_ENABLED` is still `off` in prod — the new prompt fields
  ride along whenever the owner enables it in Infisical (takes effect next deploy/restart).
  Without it, `tgtMean`/`tgtUpsidePct` simply stay absent (roa/grossMargin flow regardless
  via ratios-ttm).
- Settings UI: verify the notification-preferences panel renders a toggle for the new
  `autonomy_halted_on_boot` type if it enumerates types explicitly (backend delivery is
  forced-on regardless; a missing toggle is cosmetic).
- AV dereg is presence-based, not health-based: a configured-but-dead Alpaca news key now
  means no sentiment at all rather than AV fallback (accepted trade-off; revisit if it bites).
- Re-fire durability residual: a crash in the instant between the fill-flip transaction and
  the fire-and-forget experience write loses that one experience doc (fill no longer pending
  → no retry). Accepted for wave 1; a durable outbox would close it.
- `estimateVoyageDispatchCost` stays (still feeds the local fuse).
- Deferred to later waves (per handoff §8): §4.1 retrieval-usefulness join, §4.2/§1b branch
  fates (`w2-coaching-durable`, `w2-reflection-decompose`, `delegation-standard-docs`),
  §3.3 Quiver producer + STATUS claim fix, §3.5/§3.6, §6b.2/§6b.4/§6b.7 autonomy
  observability, §5.2/§5.4 UI, §3.8 FMP budget split (cross-repo), §7.2 FMP request
  double-emission decision, §7.3 API-usage-monitor untracked Safari-extension scaffold
  (owner: commit/discard/gitignore).
