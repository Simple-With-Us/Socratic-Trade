# 2026-08-19 — Full-App Review Part II (Adversarial Re-Verify + Gap Coverage + Deduped Fix Plan)

## Context & Objective
Part I (2026-08-18) shipped with two stated weaknesses: its verification round confirmed 336 of 336 findings and refuted none (leniency, not proof), and several lanes admitted they had only grepped surfaces they should have read.  Owner asked to complete the review, managing subagents on the most economical model that is competent for each task.  Part II closes both gaps and turns the register into a work plan.

## Changes Made
- `docs/reviews/2026-08-18-full-app-expert-review.md` — appended **Part II** (§A second-round verdicts on every P1, §B five gap lanes, §C 45 deduped clusters, §D 22 tranche-1 implementation plans, §E method + what is still unproven); added a supersede banner at the top, corrected the `tsx-01` executive-summary claim in place, and inserted **LIVE-21** (uptime-flap diagnosis) into the live-pass section.
- `docs/rollouts/2026-08-19-full-app-review-part2.md` (this note), `STATUS.md`, `docs/EFFORT-LOG.md`.

## Method (model economics)
22 agents in one workflow.  Tier matched per task, not per session: **frontier** for the money-path / accounting / backend-reliability / security re-attacks (a wrong call there costs real money); **mid (sonnet)** for the LLM, market-data, client-surface and process re-attacks, all five gap lanes, all five gap skeptics, and the three plan authors.  Assembly, dedup review and publication were done in-session rather than by a synthesis agent (that agent died on the session limit in Part I).
- Second round prompt was explicitly adversarial: default DISBELIEF, a finding survives only with a concrete repro chain (file:line per step) plus a stated worst-case blast radius in dollars; verdicts UPHELD / UPHELD_NARROWED / REFUTED / ALREADY_FIXED / UNPROVABLE_FROM_CODE.

## Results
- **P1 re-attack:** 27 UPHELD, 11 UPHELD_NARROWED, 2 ALREADY_FIXED, 0 REFUTED outright.  Downgrades below P1: `tsx-01` -> P3, `perf-01` / `berel-02` / `dweb-02` / `sre-01` / `sre-02` / `sre-03` / `llm-03` / `llm-04` / `qa-05` -> P2.  Already fixed on branch: `copy-04` (#2857), `api-03` (#2850).
- **Gap lanes:** 50 new findings (45 upheld, 5 narrowed), including P1s Part I missed entirely — Coach `draft_order` side coercion, guardrail "Import from account" arming Autopilot, draining-account reactivation, price alerts silently not evaluating, iOS first-run dead end, unauthenticated chat-history writes.
- **Clusters:** 45 work items (22 / 16 / 7 by tranche), each with one root cause and one closing change; 22 tranche-1 plans name edit sites, the post-change contract, and the test that must fail first.

## Decisions & Trade-offs
- Part I text was corrected in place rather than rewritten, with a banner, so the record shows what was claimed and what survived scrutiny.
- The P2/P3 tail was NOT re-verified; §E states that and warns to re-check individual items before acting, given the 28% narrow/already-fixed rate on P1s.
- No product code was changed in Part II.  The only code this review produced is hotfix #2851 (live).

## Verification State
- Docs-only.  Report renders (2,433 lines, 11 + 5 sections); cluster/plan ids cross-reference the register uids.
- Live checks were read-only: three spaced `/api/health` samples, GitHub API for merge/webhook history.  No prod writes, no deploys, no Coolify actions.

## Next Steps & Blockers
- Work the tranche-1 clusters in §C/§D order.  First data question to settle: the fill-count query above, which decides whether `realized-pnl-ledger` is urgent or merely correct-to-fix.
- Owner decisions still open, listed in Part I §11 tranche 3.
