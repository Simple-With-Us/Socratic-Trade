# 2026-07-29 — Accuracy breaker (nofx-style consecutive-miss safety mode) + mutation-preview inventory finding

## Context & Objective

Owner-directed OSS-lessons program (`docs/oss-lessons.md`, PR #2272). Two items from that
program land here:

1. **§8 nofx safety mode — implemented.** nofx tracks rolling prediction accuracy and degrades
   the system after N consecutive misses. Our drawdown breaker bounds the account's *bleed* but
   says nothing about the account being *wrong*: a thesis regime can degrade long before a 15%
   drawdown shows it, especially with small positions. This adds the missing accuracy brake.
2. **§5 generalized mutation preview renderers — zero-code finding.** A full inventory of every
   mutating console surface shows the Hivekeep preview pattern is already landed in bespoke,
   proportionate form everywhere; a shared abstraction is not advisable.

## Changes Made

**Accuracy breaker** — mirrors the drawdown breaker (`risk-breaker.ts`) pattern exactly:
pure evaluator + quiet internal-settings KV state + strategy-loop wiring, advisory-by-default
philosophy ("nothing is hard except which account to work in; agent decides, logs everything").

- `src/lib/accuracy-breaker.ts` (NEW) — pure `evaluateAccuracyBreaker` (streak trigger: newest K
  decisive outcomes all `lost`; hit-rate trigger: win rate over a full rolling window below a
  floor — never fires on a partial window; recovery: M most-recent outcomes with no loss, default
  2) + degraded-marker KV helpers (`risk:accuracy-degraded:{user}:{scope}`). Clamps treat
  unset/<=0 as disabled (never clamped up into "on").
- `src/lib/db-socratic.ts` — `listRecentDecisiveOutcomeStatuses`: newest-first matured decisive
  outcomes (won/lost/flat) on REAL decisions only (`status IN ('placed','filled')`).
  Counterfactual outcomes of blocked/rejected proposals are excluded — avoiding a bad trade is a
  good call, not a miss; counting them would corrupt the streak. `unknown`/`unresolvable`
  terminals excluded (not decisive either way).
- `src/lib/types.ts` — `RiskRules.accuracyBreakerConsecutiveLosses`, `accuracyBreakerWindow`,
  `accuracyBreakerMinHitRatePct`, `accuracyBreakerRecoveryWins`, `accuracyBreakerAction`
  (`"advisory" | "close_only"`, default advisory — no "halt"; accuracy degradation is not an
  emergency, the owner can halt manually). All opt-in; unset = no breaker at all.
- `src/lib/strategy.ts` — evaluation block after the drawdown breaker in `runStrategyOnce`.
  Runs in ANY system state so a degraded marker observes recovery (and owner re-arm) during
  close-only runs; only FIRES from `active`. Advisory: `policy_violation_accuracy` receipt + one
  `risk_advisory` notification per degradation (marker suppresses repeats; same enabledEvents
  force-include precedent as the drawdown advisory). `close_only`: flips the run's TARGET account
  via `setPolicy` + `kill_switch` notification. Recovery clears the marker + notifies, but NEVER
  flips systemState back; owner re-arm after a hard flip clears the marker (audited
  `accuracy_breaker_rearmed`), re-arming the breaker.
- `app/api/policy/route.ts` — `accuracyBreakerAction` enum validation + exclusion from the
  numeric risk-rules sweep (same stored-string-enum regression class as `drawdownBreakerAction`).
- `app/console/guardrails/field-defs.ts` — 4 Guardrails rows (streak limit, hit-rate window,
  min hit rate, recovery streak) with loosening directions for the live typed-CONFIRM friction.
- `app/settings-search.ts` — searchable "Consecutive-loss breaker" entry.
- `test/accuracy-breaker.test.ts` (NEW, 21 tests) — pure evaluator (streak/hit-rate/recovery/
  clamping/junk), marker KV round-trip + scoping, DB helper (ordering, counterfactual exclusion,
  non-decisive exclusion, user/account scoping).
- `test/accuracy-breaker-api.test.ts` (NEW, 6 tests) — route validation mirror of
  `drawdown-breaker-action-api.test.ts`, incl. the stored-enum-vs-numeric-sweep regression.

**§5 finding (zero code)** — full mutation-surface inventory:

| Surface | Existing preview/confirmation UX |
|---|---|
| Policy/Guardrails edits | Review Sheet with per-field diff + Locks Down/Unlocks + typed CONFIRM for loosening on live (`policy-form.tsx`) |
| Account deletion | Server-side preview (counts + blockers) + 5 acknowledgements + typed email + typed phrase (`danger.tsx`) |
| Live proposal approve | Typed batch Sheet with notional (`approvals/page.tsx`) |
| Proposal reject | 4-second arm-click, stale-arm auto-disarm |
| Learned-context approve | Confirm dialog with exact effect preview (`learned-context.tsx`) |
| Learned-context reject | One-click discard (applies nothing — proportionate) |
| Learned-fact delete / broker disconnect / API-key delete | Inline confirms with consequence text |
| Autonomy re-arm (halted→start) | One-tap — deliberate owner-directed design (`chrome.tsx` ControlSheet) |

## Decisions & Trade-offs

- **Streak and hit-rate are independent triggers (OR), not the sketch's AND.** nofx itself fires
  on consecutive misses alone; requiring both would mute the streak trigger whenever a floor
  isn't configured. Documented deviation from the §8 sketch.
- **Only REAL (placed/filled) outcomes feed the breaker.** A "lost" counterfactual on a rejected
  proposal means the rejection was RIGHT.
- **"flat" breaks a loss streak** (it is not adverse) but **counts as clean for recovery**
  (recovery = no losses in the recent tape, not "must win").
- **No auto re-arm of systemState.** Recovery clears the marker and tells the owner; flipping an
  account back to `active` autonomously would contradict the drawdown breaker's owner-re-arm
  precedent. Owner re-arm after a hard flip clears the marker (deliberate, audited).
- **Off by default.** Unlike the owner-approved 2026-07-28 drawdown enablement (15% advisory
  default), no enablement was approved for this breaker — all fields unset = no breaker.
- **No strategist-prompt threading in v1** (the drawdown advisory injects context into the
  prompt). Receipt + notification + Guardrails copy cover it; prompt threading is a clean
  follow-up if the owner wants the agent to see the advisory mid-run.
- **§5: no shared `MutationPreview` component.** Refactoring 8+ tuned surfaces for consistency
  would churn carefully-designed UX (typed rituals, arm-click, server-side previews) for marginal
  benefit and real regression risk. The lesson is already absorbed; new mutating surfaces should
  copy the nearest existing pattern.

## Verification State

- `npx tsc --noEmit` — clean.
- `npx eslint <touched files>` — 0 errors (warnings all pre-existing grandfathered in strategy.ts).
- `npx vitest run test/accuracy-breaker.test.ts test/accuracy-breaker-api.test.ts` — 27/27 pass.
- Related suites: drawdown-breaker-action-api, guard-enablement, strategy-moneypath-drawdown-flip
  (14/14); settings-search-index, openSettings-relocation, guardrails-essentials,
  console-policy-diff, settings-tree-scope (41/41).
- FULL suite (load ~2-6, shards): `npx vitest run --shard=1/3` 1846 pass, `--shard=2/3` 1750
  pass, `--shard=3/3` 1827 pass — 5,423/5,423 green.
- `npm run build` — exit 0.

## Next Steps & Blockers

- PR auto-merge armed; `verify` CI is the gate. NOTE: the self-hosted runner fleet was degraded
  at push time (`fleet-ci-socratic-ci` and `-2` OFFLINE; only `oracle-a1-socratic-ci` online and
  busy) — PR #2272's verify was already queued ~40 min. Expect slow CI until the fleet recovers.
- After PR #2272 merges, fold the §5 inventory table + §8 "implemented" status into
  `docs/oss-lessons.md` (the file only exists on that unmerged branch — deliberately not
  duplicated here to avoid a cross-PR conflict).
- Optional follow-ups: strategist-prompt threading of the accuracy advisory; `accuracyBreakerAction`
  UI select (API-only today, same as `drawdownBreakerAction`).
- Remaining program rows (unassigned): backtest-integrity suite (§6), brokerage-model
  order-state hardening (§7).

## Zero-Code Findings

§5 (above) is the zero-code finding: every mutating surface already has proportionate,
bespoke confirmation UX; the generalized preview-renderer effort is closed as
already-landed-in-bespoke-form.
