# 2026-07-02 - console-qa-fixes

## Summary

12 owner-reported QA issues from the /console walkthrough, fixed on branch
`claude/console-qa-fixes` (cut from `origin/main` @ 8f828af). Every diagnosis
was verified against the real code before fixing.

1. **Bogus save rejection** (also reported as #6 — same root cause): saving
   notification prefs / enabling short selling failed with "gpt-5.5 with high
   reasoning is disabled...". Root cause confirmed: `validatePolicy` in
   `app/api/policy/route.ts` ran `isDisallowedInteractiveStrategyReasoningConfig`
   against the MERGED policy on every PUT, so a stored gpt-5.5+high config
   poisoned every unrelated save. Fix (server): the rule is enforced only when
   the request actually changes `llmModel`/`redTeamLlmModel`/`llmReasoningEffort`
   (stale stored configs are already runtime-clamped to medium by
   `interactiveStrategyReasoningEffort`). Fix (console): the notifications card
   now sends a minimal patch (only touched subfields); other console savers were
   audited and already minimal. Regression test added.
2. **Performance vs market -80% after a withdrawal**: `computeSpyBenchmark`
   compared raw equity growth. No broker transfer ledger exists (checked: no
   Alpaca activities fetcher anywhere), so external flows are now INFERRED per
   snapshot gap as `cash delta − recorded trade cash` with a materiality floor
   (max(0.5% of prior equity, $25)) so dividends/fees never register; the
   account line chains a time-weighted return over those flows.
   `BenchmarkComparison` gains `cashFlowAdjusted` + `netExternalFlows`;
   `EquityCurvePoint` gains optional `cash` (populated from portfolio
   snapshots; absent on synthetic curves → honest degradation). The console
   Results page states the adjustment explicitly either way, and the raw
   equity chart is labeled "includes any deposits/withdrawals".
3. **Results buckets**: the page now shows only the selected account's
   money-reality bucket by default, with an explicit "Compare with
   practice/real money" toggle (and copy that the buckets never share an axis).
4. **washSaleMinLossUsd**: new optional account-scoped
   `taxSettings.washSaleMinLossUsd` — losses below the floor no longer
   contribute to the 30-day rebuy lockout (default undefined = every loss
   locks, unchanged). Threaded through `getWashSaleLockProvenance` /
   `getWashSaleLockedSymbols` / `getTaxSummary` and the cross-account lockout
   (`getUserWashSaleLockProvenance` resolves each account's OWN policy floor
   via `getPolicy(userId, accountId)`). Route validation added; Guardrails
   gains a "Tax rules" advanced group (money field, `looserWhen: "up"` so
   raising it costs the LIVE typed word; help text states the IRS still
   applies §1091 to any size and reporting is unaffected). Verified ask-first
   mode already surfaces wash-sale-blocked BUYs as blocked proposal cards +
   notifications (`strategy.ts` inserts `status: "blocked"` + sends the block
   notification when the gate refuses) — no silent pre-proposal drop exists.
5. **Too much red on LIVE**: danger treatment is now reserved for the reality
   banner/viewport frame, STOP, and destructive confirms (wind-down). LIVE
   approve/commit primaries are neutral accent buttons with a small `LiveTag`
   word chip (new primitive + `.con-live-tag`, contrast-inverted inside filled
   buttons for WCAG in both themes). Non-destructive typed rituals use the
   warn tint instead of the red frame.
6. Same root cause as 1 — covered there.
7. **Unsaved-changes warning**: new `DirtyGuardProvider` +
   `useUnsavedChanges`/`useNavDirtyGuard` (`app/console/lib/useDirtyGuard.tsx`):
   beforeunload warning + "Discard unsaved changes?" confirm on nav-rail /
   mobile-tab clicks. Registered by the policy save bar (covers guardrails incl.
   universe extraPatch), strategy prompt/models/weights drafts, settings cards,
   and pending AI reviews.
8. **Run-event consolidation + attribution**: `candidates_considered` and
   `rationale_diversity` audits now carry `connectedAccountId` (strategy.ts —
   the two calls that were missing it; `strategy_run`/`signal_snapshot` already
   had it). `buildUnifiedFeed` consolidates a run's
   strategy_run/diversity/candidates/signal-snapshot/llm_step events into ONE
   `run-<runId>` group; strategy_run is the primary (title/summary rendered
   once), the rest are sub-rows; the console card no longer repeats the summary
   3x (no fullText echo, duplicate sub-row filtered) and shows the Account line
   from any attributed event in the group.
9. **Humanized ops events**: `web_source_refresh` and `congress_share_daily`
   audits render human one-liners ("Refreshed 103 congressional-trade entries",
   "515 of 515 tickers priced · 34 posts sent · 30 failed"); raw JSON moved
   behind an explicit "raw data" toggle; pure-ops events collapse into a
   "System" bucket at the end of the console Activity feed (`OPS_AUDIT_KINDS`
   exported from dashboard-feed).
10. **Cross-account leak**: notifications are user-wide rows; they now stamp
    their `connectedAccountId` onto unified-feed groups, and the console
    Activity feed + Alerts tab hide events tagged to a DIFFERENT account (with
    an honest "N events from other accounts are not shown" note) and label
    untagged legacy rows "account unknown" instead of implying they belong to
    the current account. Fill/order rows are already account-scoped server-side
    and stay label-free.
11. **"web source refresh · Count 103"**: covered by the #9 formatter + System
    bucket (emitters found in `src/lib/web-sources/*` — payloads carry
    `id`/`ok`/`recordCount`).
12. **AI strategy review in console**: new "AI review" panel on the Strategy
    page — reviewer-model picker (curated data from `app/ui/llm-model-catalog`,
    a pure data module; no legacy UI component imports), POST the existing
    `/api/strategy/tune`, render summary/rationale/cautions/confidence plus an
    exact from→to diff of the proposed prompt/weights/policy patch classified
    LOOSER/TIGHTER via the same guardrail field metadata as the Guardrails
    editor. Apply writes through the existing `PUT /api/policy` (sectorCaps
    merged over current — the endpoint whole-replaces that map); LIVE loosening
    costs the typed CONFIRM; Discard clears.

## Why

Owner walkthrough of the new /console surfaced honesty, correctness, and
usability defects; the two save failures (#1/#6) were outright blockers, and
the -80% benchmark figure (#2) was materially misleading after a withdrawal.

## Files

- `app/api/policy/route.ts` — reasoning-rule gate only on change; washSaleMinLossUsd validation
- `app/console/activity/page.tsx` — account scoping, System bucket, raw toggles, dedupe
- `app/console/components/approval-card.tsx` — neutral LIVE approve buttons + LiveTag
- `app/console/components/chrome.tsx` — TypedConfirm variants, LIVE start/switch re-toning
- `app/console/components/nav.tsx` — nav dirty-guard interception
- `app/console/components/policy-form.tsx` — dirty registration, primary commit + LiveTag
- `app/console/components/shell.tsx` — DirtyGuardProvider wiring
- `app/console/console.css` — `.con-live-tag`
- `app/console/guardrails/field-defs.ts` — TAX_RULES group
- `app/console/guardrails/page.tsx` — Tax rules group render, Autopilot re-toning
- `app/console/lib/api.ts` — `tuneStrategy` client
- `app/console/lib/useDirtyGuard.tsx` — NEW: unsaved-changes guard
- `app/console/results/page.tsx` — selected-bucket default + compare toggle + honest benchmark copy
- `app/console/settings/page.tsx` — minimal notification patch, dirty registration, LiveTag
- `app/console/strategy/page.tsx` — AI review panel, dirty registration
- `app/console/ui/primitives.tsx` — `LiveTag`
- `src/lib/benchmark.ts` — `inferExternalCashFlows`, TWR chaining, flow-aware `computeSpyBenchmark`
- `src/lib/dashboard-feed.ts` — ops formatters, run grouping, notification attribution, `OPS_AUDIT_KINDS`
- `src/lib/dashboard.ts` — fills threaded into the benchmark
- `src/lib/performance.ts` — `cash` on equity-curve points
- `src/lib/strategy.ts` — connectedAccountId on candidates_considered/rationale_diversity audits
- `src/lib/tax.ts` — washSaleMinLossUsd threading (per-account in the user-wide lockout)
- `src/lib/types.ts` — `TaxSettings.washSaleMinLossUsd`, `EquityCurvePoint.cash`, `BenchmarkComparison.cashFlowAdjusted/netExternalFlows`
- `test/policy-notification-events.test.ts` — #1 regression
- `test/benchmark.test.ts` — flow inference + TWR incl. the -80% repro
- `test/tax.test.ts` — threshold below/at/above, default unchanged, per-account floors
- `test/dashboard-feed.test.ts` — run consolidation, ops humanization, notification attribution
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-qa-fixes.md`

## Verification

- `npm run lint` — 0 errors (281 pre-existing grandfathered warnings)
- `npx tsc --noEmit` — clean
- `npm test` — 234 files, 2241 tests, all pass
- `npm run build` — clean
- Targeted runs during development: `npx vitest run test/policy-notification-events.test.ts`,
  `test/benchmark.test.ts test/performance.test.ts`,
  `test/tax.test.ts test/washsale-provenance.test.ts test/washsale-test-account-excluded.test.ts`,
  `test/dashboard-feed.test.ts test/dashboard-fill-batching.test.ts test/dashboard-ui.test.ts`

## Follow-ups

- Cash-flow inference is an estimate (snapshot cash deltas minus recorded
  trade cash). If a broker activities/transfer API is ever wired (Alpaca
  `/v2/account/activities` TRANS/CSD/CSW), swap the inferred flows for real
  ones — the `flowsByDate` plumbing already accepts any source.
- The legacy dashboard consumes the same unified feed, so it also gets the run
  consolidation + humanized ops events; its own rendering wasn't otherwise
  touched.
- LIVE loosening on the AI-review Apply is a client-side ritual (same as the
  Guardrails commit); a server-side typed-confirm contract for policy loosening
  remains a possible hardening.
- `notify.bridge.error` is bucketed as ops in the console but has no bespoke
  formatter (generic detail); add one if it starts appearing regularly.
