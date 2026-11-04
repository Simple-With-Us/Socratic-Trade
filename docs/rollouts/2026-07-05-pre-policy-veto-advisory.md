# Pre-policy vetoes become advisory-overridable (CLAUDE, #799 follow-up)

**Date:** 2026-07-05
**Seat/lane:** CLAUDE (risk-engine work this account is carrying)
**Branch:** `claude/veto-advisory-overridable`

## Summary

Completes the "everything overridable except the account boundary" philosophy from PR #799 by making the
two **pre-policy vetoes** advisory: a vetoed candidate is now **tagged, not dropped**, so the agent can
proceed on a logged `autonomyOverride` thesis — while the veto is still fully recorded.

- **New contract (`types.ts`):** `TradeProposal.preVetoReasons?: string[]` and `redTeamVerdict.overridden?: boolean`.
- **Fold-in (`strategy.ts`):** right before the single `resolveSocraticOverride` call, any `preVetoReasons`
  are appended to the sized `PolicyDecision` as reasons. Because `isHardGateReason("deterministic_bear_veto: …")`
  and `isHardGateReason("red_team_veto: …")` are both `false` (from #799), the **existing** override path
  classifies them as overridable and applies the thesis — openings only, subject to `socraticOverrideMode`
  and the override cap. **No parallel system, no change to `policy.ts` or the `resolveSocraticOverride` resolver.**
- **Veto A — `deterministicBearFilter`:** Rule 3 (below-median buy in risk-off/crisis) and Rule 4
  (FCF/debt-equity fundamentals) tag `preVetoReasons` and keep the candidate instead of hard-dropping it.
  **Rule 1 (phantom sell/cover) stays a hard drop** — it's an accounting impossibility on a non-opening side,
  not a preference. `deterministicBearFilter` stays a pure function and keeps its `{kept, vetoed}` shape.
- **Veto B — approval-time Red Team:** when the Bear rejects an opening AND an `autonomyOverride` thesis is
  present AND `socraticOverrideMode !== "off"`, the veto is tagged (`red_team_veto: …`), `redTeamVerdict.overridden`
  is set, and the proposal falls through (no `continue`). Otherwise today's behavior is preserved verbatim.

With no override thesis (or `socraticOverrideMode: "off"`) every veto keeps the candidate blocked exactly as
the old hard-drop did — nothing auto-overrides.

## Three correctness fixes (from the adversarial design pass)

- **FIX #1 — learning-data integrity.** On the override path we emit a **distinct** audit kind
  (`red_team_veto_overridden`) and **do not** write `recordRejectedProposalCounterfactual`. The trade may
  actually execute, so recording it as a Bear-vetoed missed opportunity would corrupt `getRedTeamEfficacy()`
  (which keys off `proposal_rejected_by_red_team` joined to the counterfactual return) — double-booking one
  symbol as both a missed winner and a real position. The non-override path is byte-for-byte the old audit +
  counterfactual + `continue`.
- **FIX #2b — durable audit for Veto A.** `deterministicBearFilter` previously recorded only a `console.log`.
  Every deterministic-bear veto (kept-and-tagged or hard-dropped) is now `audit("deterministic_bear_veto", …)`,
  account-scoped, so an overridden fundamentals/regime veto is visible in the Activity/Audit feed.
- **FIX #3 — sell-to-fund ordering.** In `"propose"` mode, an overridden opening is added to
  `requiresHumanReview` **before** the sell-to-fund planner reads it, so it can't drive automated funding sells
  for a buy that then routes to human. Mirrors the existing Bear-unavailable / rationale-collapse gates. The
  authoritative sized cap/mode decision still runs once at `resolveSocraticOverride`.

## ⚠️ Owner-ratification flag: Rule 4

Rule 4 is a **deliberately model-independent** fundamentals veto — it exists precisely because the Bull and Bear
share one model and can jointly rationalize a weak long, so it vetoed cash-burning / over-levered names
regardless of what the LLMs agreed. This change makes it **overridable by an `autonomyOverride` thesis authored
by that same model**, per the owner's "nothing is hard but the account boundary" philosophy — which re-couples
the exact failure mode Rule 4 was built to be independent of. It's flagged in-code at the Rule 4 site with a
one-line revert (change the tag-and-keep back to `vetoed.push({...}); continue;`) so the owner can keep Rule 4
absolute while leaving Rule 3 (and the Red Team veto) overridable. **Rule 3 and Veto B carry no such caveat.**

Default posture: `socraticOverrideMode` already defaults to `"execute"` (from #799), so this ships **active** —
i.e. the agent can self-override a veto on a logged thesis. Flip the default to `"propose"` (human-gated) or
`"off"` (dormant) if a more conservative rollout is wanted.

## Files

- `src/lib/types.ts` — `preVetoReasons`, `redTeamVerdict.overridden`.
- `src/lib/strategy.ts` — fold-in block; FIX #3 pre-route; Veto B override branch; Veto A tag-not-drop + FIX #2b audit.
- `src/lib/socratic-runtime.ts` — `dissentForDecision` distinguishes an overridden Red Team rejection (advisory/warning) from a blocking one (negative).
- Tests: new `test/pre-veto-override.test.ts` (8 tests: fold-in + override path, off/no-thesis blocked, hard-reason-mixed refused, openings-only); `hard-gate-classification` (both veto strings are preferences); `deterministic-bear` (Rules 3/4 tag-not-drop, Rule 1 drops); `socratic-runtime`, `regime-gate-adoption`, `strategy-hardening` updated to the tag-not-drop contract.

## Adversarial verification caught two real bugs (both fixed)

A 3-lens adversarial verification pass (run before landing, over a green test suite) found **two
money-path bugs the tests missed** — both introduced by the tag-not-drop change:

- **ISSUE 1 (severe) — phantom funding sells.** A pre-veto-tagged opening that will actually be
  *blocked* (no override thesis, or `socraticOverrideMode !== "execute"` — the common case) was no
  longer dropped, so it inflated `intendedOpeningNotional`; under `sellToFundBuy: "automated"` +
  `strategyAuthority: "decide"` this could auto-liquidate real holdings to fund a buy the system then
  refuses. **Fix:** new exported `preVetoTaggedOpeningWillPlace(p, mode)` — a tagged opening counts
  toward the funding notional only when it auto-executes (execute mode + a requested override thesis);
  propose+thesis is already excluded via `requiresHumanReview`. Restores the pre-change "vetoed buy
  funds $0" invariant. (`strategy.ts` intended-notional filter.)
- **ISSUE 2 (moderate) — free-text misclassification.** `isHardGateReason` substring-scans for
  `"broker"` / `"buying power"` / `"PERMANENTLY"` / `"wash sale"`; a Red Team veto's reason is
  unconstrained LLM prose, so a `red_team_veto: …the broker-dealer…` string was misclassified HARD →
  a valid override silently refused (and the card mislabeled). **Fix:** `isHardGateReason` now
  classifies any `deterministic_bear_veto:` / `red_team_veto:` **prefixed** reason as a preference
  before the substring scan (these prefixes are only produced by the pre-veto tagging, so it can never
  mask a real hard gate). (`policy.ts`.)

Both fixes carry dedicated regressions: `hard-gate-classification` (prefix stays a preference despite
an embedded hard-gate substring) and `pre-veto-override` (`preVetoTaggedOpeningWillPlace` matrix).

## Verification

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; full Vitest suite green; `npm run build` ok.
- Independent 3-lens adversarial verification (execute-that-shouldn't / learning-data / funding-ordering)
  run before landing; the two issues above were surfaced by it and fixed, then re-verified.

## Coordination & follow-ups

- Claimed on `#ag***-s**c` with an overlap heads-up to the not-yet-landed `claude/redteam-policy-aware-routing`
  lane (different concern — Red-Team *unavailable* routing vs Red-Team *veto* overridable; same strategy.ts
  region; whoever lands first, the other rebases).
- Deferred (design verdict): extending override to **exit** sides (low value — exits already bypass nearly all
  preference gates). The batch inline Bear (b1) still drops silently — separate effort if the owner wants it overridable.
