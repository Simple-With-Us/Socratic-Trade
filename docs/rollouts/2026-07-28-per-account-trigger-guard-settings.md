# 2026-07-28 — Per-account event-trigger settings + guard tuning UI (KIMI)

## 1. Context & Objective

Owner-directed follow-up to the guard enablement that landed in PR #2249. Two gaps called out at
the time: (a) the new `policy.tuning` guard fields (vol-target sizing, vol target %, portfolio
heat budget %, risk receipts) shipped with defaults but had no per-account UI, and (b) the
event-driven trigger engine (`docs/event-driven-transition-plan.md`, gaps G1/G2/G3) was
configurable ONLY via process-wide env — no per-account opt-out, no safety-floor cadence in
event-only mode (a silent producer = no runs at all), and event runs always ran full strategy.
This branch exposes the tuning guards in Guardrails and adds an optional per-account
`policy.triggerSettings` object wired through the scheduler cadence lane, the trigger engine, the
policy API, and the Guardrails UI.

## 2. Changes Made

**Part A — tuning guard fields in the Guardrails UI (per account):**
- `app/console/guardrails/field-defs.ts` — new `VOL_TARGETING` group (`tuning.volTargeting` bool,
  `tuning.targetPortfolioVolPct` / `tuning.portfolioHeatBudgetPct` optional pct,
  `tuning.riskReceipts` bool), added to `ALL_DEFS`.
- `app/console/guardrails/page.tsx` — new Advanced rulebook group "Volatility targeting & risk
  receipts" (rendered between "Entry quality gates" and "Volatility panic brake").
- `app/api/policy/route.ts` — validation: `tuning.volTargeting`/`riskReceipts` must be boolean;
  `tuning.targetPortfolioVolPct`/`portfolioHeatBudgetPct` 0-100 (blank = off). The existing
  `tuning` deep-merge already accepted the nested paths; the load/save path needed no whitelist
  change (`tuning` is merged, not whitelisted).
- `app/settings-search.ts` — catalog entries `guardrails.volTargeting`, `guardrails.heatBudget`,
  `guardrails.riskReceipts` with synonyms ("wild names", "volatile", "size taper", "heat",
  "risk budget").

**Part B — per-account event-trigger settings:**
- `src/lib/types.ts` — new `TriggerSettings` interface + optional `triggerSettings` on
  `TradingPolicy` (enabled / mode / fallbackIntervalMinutes / eventRunMode; every field optional,
  unset = follow global env).
- `src/lib/triggers.ts` — new pure exported helpers `resolveAccountTriggerConfig` and
  `cadenceLaneDecision`; `admitRun` rejects accounts with `triggerSettings.enabled === false`
  (reason `account_triggers_disabled`); `eligibleMaterialTriggerUserIds` filters them out of
  broadcast fanout; `fire()` resolves the account's `eventRunMode` and threads
  `runStateOverride: "close_only"` into `runStrategyOnce`, stamped on the `trigger_run` audit.
- `src/lib/scheduler.ts` — the cadence lane (~line 745) now resolves per account via
  `cadenceLaneDecision`: lane runs when the engine is disabled for the account (pure interval,
  byte-identical default), when the mode includes interval, or when mode is "event" AND
  `fallbackIntervalMinutes` is set (fallback replaces `runCadenceMinutes` as that account's
  cadenceMs). All safety maintenance above the lane is untouched.
- `src/lib/strategy.ts` — `runStrategyOnce` options gain `runStateOverride?: "close_only"`; new
  exported pure helper `runScopedGatePolicy` builds a run-scoped CLONE with
  `systemState: "close_only"` (active policies only), threaded into the two
  `evaluateTradeProposal` contexts and the `runPolicy` LLM-context derivation; the pristine
  `policy` object still feeds every persistence path. Audited as `run_state_override`.
- `app/api/policy/route.ts` — `triggerSettings` deep-merge in the PUT body (materialized only
  when set, so "follow global" stays distinguishable; null-cleared sub-keys strip back to absent)
  + validation for all four sub-fields.
- `app/console/lib/policy-diff.ts` + `app/console/components/policy-form.tsx` — minimal FieldDef
  extension `optionValues` (string option -> typed draft value) so a select can express the
  three-state "Use global (env) / On / Off" boolean honestly ("" writes `null`, which strips back
  to the global default).
- `app/console/guardrails/field-defs.ts` + `page.tsx` — new `TRIGGERS` group rendered as Advanced
  rulebook "Event triggers": enabled (three-state select), mode select, fallback interval minutes
  (optional), event run scope select (full/close_only).
- `app/settings-search.ts` — catalog entries `guardrails.eventTriggers`,
  `guardrails.triggerFallbackInterval` ("event trigger", "signal", "regime flip run",
  "fallback interval").

**Part C — Kimi lane registration:**
- `AGENTS.md` — `~/apps/trading-kimi` (branch `agent/kimi-lane`) added to the CAUTION block lane
  list, the "Hosting & dev servers" worktree roster, and the "How each agent works" bullet.
- `scripts/land.sh`, `scripts/githooks/pre-push` — Kimi row added to the lane lists in the
  die-message help text (text only, ASCII-only `->`; `bash -n` clean).

**Part D — docs/protocol:**
- `STATUS.md` (new top entry), `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`
  (KIMI row), `docs/event-driven-transition-plan.md` (gap-closure line), this note.

**Tests (18 new, 3 files):**
- `test/trigger-account-settings.test.ts` — (a) fallback interval: event mode with
  `fallbackIntervalMinutes` runs the cadence lane on the fallback interval, without it the lane
  is dropped; engine-off/interval/both unchanged. (b) `enabled === false` suppresses
  admission + broadcast fanout for that account while another account still fires. (c) close_only
  event run invokes `runStrategyOnce(userId, { runStateOverride: "close_only" })` and the stored
  policy is unchanged after the run.
- `test/run-state-override.test.ts` — `runScopedGatePolicy` returns an unmutating clone (identity
  + field assertions), never widens stored halted/close_only, and the clone rejects an opening at
  the policy gate while exits pass and the pristine policy admits both.
- `test/policy-trigger-settings-route.test.ts` — (d) route validation accepts/rejects the new
  fields; (e) tuning + triggerSettings round-trips through the PUT path, deep-merge survival on
  unrelated saves, null-clear semantics, absent-stays-absent.

## 3. Decisions & Trade-offs

- **Three-state enabled UX = a select, not a tri-state checkbox.** The FieldDef select pattern
  was string-only, so a minimal `optionValues` map was added ("" -> `null`, "true"/"false" ->
  booleans). Choosing "Use global" writes `null`, which `stripNullsDeep` turns back into an
  absent key — the honest representation of "unset = follow env", matching how every other
  optional policy field clears. Semantics: `enabled === false` opts the account OUT of event
  runs even when the env engine is on; `enabled === true` keeps it in; unset follows the env.
  A per-account `true` cannot power the engine on when the env has it off (producers no-op on the
  env gate) — noted in the type doc.
- **close_only = run-scoped clone, mirroring the runLlmOverride/runPolicy budget-downgrade
  pattern.** `policy` (the object the drawdown/vol breakers mutate and `setPolicy` persists, and
  that `autoRevertOnCapBreach` writes) stays pristine; a separate `gatePolicy` clone feeds the two
  `evaluateTradeProposal` gates and the `runPolicy` LLM-context derivation. Persistence of the
  override is therefore structurally impossible, not just careful — verified by test. Behavior of
  the gated run is exactly the existing mid-run close_only semantics (policy.ts:319: openings
  rejected, exits/safety maintenance flow; the close-only reason stays overridable-classified
  exactly as it is for a breaker-flipped run — deliberately identical, not a new gate class).
- **mergePolicy: no `triggerSettings` deep-merge added.** `DEFAULT_POLICY` has no triggerSettings
  default (unlike `tuning`), so the stored object passes through `...policy` wholesale and there
  is nothing to inherit. `pickAccountFields` is a blocklist, so the object is account-scoped
  (correct: per-account setting).
- **Fallback interval validation floor is 1 minute; 0/non-positive is rejected at the route and
  treated as unset at resolution** — a stored 0 would read as "fallback every tick".
- **Punted:** `app/api/mobile/snapshot/route.ts` exposes a whitelisted policy subset and was left
  unchanged (trigger settings aren't in the mobile snapshot; no consumer asked for them). The
  settings catalog's `legacySection` tags for the new entries are "tuning"/"operate" (account
  tier) — no legacy modal section actually renders them there, they're search metadata only.

## 4. Verification State

```bash
npx tsc --noEmit                                                          # clean
npm run lint                                                              # clean (errors gate)
npx vitest run test/trigger-account-settings.test.ts \
  test/policy-trigger-settings-route.test.ts test/run-state-override.test.ts   # 18/18 pass
npm test                                                                  # full suite — see below
npm run build                                                             # full Next.js build — see below
```

Focused run: 3 files, 18 tests, all passing. Full verification executed 2026-07-28 on this
branch in `~/apps/trading-kimi`:

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (654 grandfathered warnings, expected baseline).
- `npm test` — full suite run in 4 alphabetical chunks (single run exceeds the 300s shell
  timeout): **464 test files, 5377 tests, all passing** (1423 + 1366 + 1279 + 1309 per chunk).
  One mid-verification failure was found and fixed: the first `fire()` edit always passed a
  second options arg to `runStrategyOnce`, breaking `toHaveBeenCalledWith(userId)` assertions in
  `test/trigger-durability.test.ts` / `test/token-budget-ceiling.test.ts` /
  `test/web-sources-sec8k.test.ts`; the final code passes the options arg ONLY when the
  close_only override is active, so the default call shape is byte-identical to before.
- `npm run build` — full Next.js production build, passes (route table emitted, no errors).

## 5. Next Steps & Blockers

- Land via the owner/parent (this lane commits locally only; do not push from here).
- Stage-2 trigger-engine rollout (`docs/event-driven-transition-plan.md`): G1 (fallback interval)
  and G2 (close-only event runs) are now per-account settings; G3 (per-user caps) remains
  env-global and deferred.
- Mobile snapshot can surface triggerSettings later if the mobile app grows a trigger UI.

## 6. Zero-Code Findings

N/A — code shipped.

## 7. Verifier Review (second pass, 2026-07-28)

**Verdict: SHIP-WITH-NITS.** Two verifier nits fixed in a follow-up commit on this branch:

- **D1 (fixed):** the `tuning.targetPortfolioVolPct` / `tuning.portfolioHeatBudgetPct` UI hints
  said "Blank = no vol/heat taper" — wrong post-#2249. Blank reverts to the shipped
  `DEFAULT_POLICY` values (25% vol target / 10% heat budget, both tapers active when
  `volTargeting` is on); entering **0** is what disables each taper (resolution gates on
  `> 0` in `strategy-risk.ts`). Both hints now say "Blank = revert to the default 25%/10%
  taper. Enter 0 to disable."
- **C1 (fixed):** the `triggerSettings.enabled` hint now tells the user that "On" is inert
  when the deployment-level `TRIGGER_ENGINE` env is off — a per-account On opts the account
  IN only when the engine is on globally; it cannot power the engine by itself.

**A1 — owner-awareness note (no code change, by design):** `eventRunMode: "close_only"` is a
SOFT constraint against two existing explicit-override paths: when
`socraticOverrideMode = "execute"` the Socratic override executes proposals regardless of the
gate state, and an `autonomyOverride` similarly bypasses the gate for that account/run. An
account in close_only event mode with either override armed can still open positions through
those override paths — same as a breaker-flipped close_only run today (deliberately identical
semantics, not a new gate class). Owner should know close_only is "gate state", not an
absolute kill switch, when overrides are in play.

**Verification for this nit-fix commit:** `npx tsc --noEmit` clean; `npm run lint` 0 errors;
adjacent suites `console-policy-diff` / `guardrails-essentials` / `learning-review-policy-route`
/ `policy-trigger-settings-route` / `settings-search-index` — 5 files, 44 tests, all passing.
(Hint-text-only change; no behavior touched.)
