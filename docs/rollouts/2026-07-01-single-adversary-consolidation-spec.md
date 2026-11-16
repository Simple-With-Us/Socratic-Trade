# 2026-07-01 — Single-adversary consolidation design spec

Branch `claude/wonderful-bell-32958a`.

## Summary

Design-only change. Added `docs/single-adversary-consolidation.md`, a verified,
adversarially-reviewed design spec that consolidates the strategy engine's **two**
adversarial LLM passes into **one** hardened "Adversary Review" (working name).
No code changed.

## Why

A user's dashboard tooltip showed `Red Team review: gemini-3.5-flash/gemini
(fallback)`. Investigation surfaced three converging problems:

1. **Redundancy:** the in-flow "Bear" inside `proposeTrades`
   (`src/lib/strategy.ts` ~2225-2440) and the standalone `debateProposal`
   (`src/lib/red-team.ts`) both resolve their model from the same
   `policy.redTeamLlmModel` field, so by default they run the **identical model
   twice** with different prompts — paying for two adversarial runs from the same
   family for one net critique.
2. **Reliability:** the adversary parse path does a bare `JSON.parse` with zero
   fence-stripping and zero retries; Gemini's OpenAI-compatible endpoint returned
   fenced/prose-wrapped JSON, the parse threw, and the review **silently failed**
   and the trade proceeded weakly-reviewed.
3. **Invisibility:** when the adversary is unavailable and a trade routes to human
   approval, the UI renders it identically to a routine manual-approval proposal —
   `formatNotificationDisplay` overwrites the notification title, and the reason
   lives only in a transient in-memory array, never persisted.

## What the spec decides (positions taken)

- **One adversary**, built by extending the existing **post-sizing**
  `debateProposal` call site (`strategy.ts:447-464`); delete only the in-flow
  Bear's **LLM call** while **retaining** the non-redundant deterministic
  pre-filter (phantom-exit / regime-contradiction vetoes, momentum annotation).
- Reviews the **finalized** trade; three discrete verdicts —
  `approve` / `approve-at-half` / `reject` — with `approve-at-half` a down-only
  `0.5x` haircut that **re-checks placeability** (no-op + log if it would breach
  the bracket/share minimum) so the down-only guarantee can't be silently
  defeated.
- Runs on **risk-adding trades only**, gated on **net exposure direction** (not
  raw side), so a net-reducing buy/short is exempt alongside sell/cover — the
  adversary can never block or shrink a risk-reducing trade (fixes today's hazard
  where `debateProposal` can reject a stop-loss `sell`).
- **Never fails silently:** `broker/live` + `broker/paper` fail closed to human
  review; `test/local` recommended to route the same path. Runs on **all**
  openings (conviction gate removed) **with concurrent** per-proposal calls so
  universal coverage doesn't extend the per-user scheduler-lock hold.
- **Independence enforced:** hard rule adversary model != proposer model (blank no
  longer silently falls back to Green); strong default + warning (not hard block)
  at the provider/company level; the hidden `RED_TEAM_LLM_PROVIDER` env override
  and hardcoded `claude-haiku-4-5-20251001` default are removed in favor of a
  first-class Strategy Studio setting.
- Reliability fixes: shared `extractJsonPayload` fence-stripping, enable strict
  `json_schema` where supported (mind the DeepSeek special-case), bounded
  retry + failover, and fail-**closed** on unknown/missing verdict (fixes the
  current `!!parsed.rejected` fail-open coercion).
- Visibility: distinct amber warning badge on the pending-approval card, stop
  overwriting the `pending_approval` notification title (payload metadata flag,
  no type-union migration), and **persist** the reason into the proposal's
  `decision.reasons` (no schema migration). Plus Strategy Studio help copy on
  which models suit the structured-JSON critique role.

## Process

Built via a background workflow: a verification pass re-grounded every file:line
against the current worktree, a draft pass wrote the spec, and two adversarial
reviewers (technical/convention-compliance + design-coherence) stress-tested it.
The design review's 5 material findings (net-exposure gating hole, half-haircut
vs sizer floors, universal-coverage latency, `test/local` visibility wiring,
pre-filter retention) plus 3 minors were folded back into the doc before commit.

## Files

- `docs/single-adversary-consolidation.md` (new).
- `docs/rollouts/2026-07-01-single-adversary-consolidation-spec.md` (this note).
- `STATUS.md` (new snapshot entry).

## Verification

This change is **docs-only** (a design spec + these handoff docs — no `src/`/`app/`
code changed), but the repo's verify gate was run anyway to confirm nothing regressed
and to record the exact commands per the Handoff Protocol:

```bash
npx tsc --noEmit   # clean
npm run lint       # 0 errors (pre-existing grandfathered warnings only)
npm test           # green
npm run build      # passes
```

The spec's §10 carries this same gate as the required check for the eventual
*implementation* PR (which will change code).

## Follow-ups

- **Decisions are RESOLVED, not blocking** (spec §9): O1 = "Red Team", O2 = remove
  the conviction gate (+ concurrency), O3 = default-route `test/local` through human
  review, O4 = fail-closed on blank/no-second-key. (An earlier draft of this note said
  O1–O4 were open — corrected to match spec §9.) The only remaining design nuances are
  captured as review-reconciliation items R1–R20 in spec §12.
- **PLAN.md and `docs/phase-7-strategy.md` updated** to reference this design path (an
  earlier draft deferred both; done now per the Pre-Commit / Handoff Protocol).
- Implementation not started — this is a proposal. When it lands, the implementation
  PR carries its own verify run + doc updates.
- Separate workstream (not in this spec): order fill-confirmation / reconciliation
  design (extend the existing `placing`-intent + `flagStalePlacingIntents`
  reconciliation rather than a fragile in-memory poll loop; prefer broker push
  streams, terminal-state-aware, restart-durable).
