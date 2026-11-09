# 2026-07-04 — Wave 2: The Outcome Engine (outcome writer, multi-horizon schema, kill-survivorship, per-decision lessons)

Branch `claude/w2-outcome-engine`, based on `origin/claude/w1-learning-loops` (needs its
trading-day helper, lifecycle re-index hook, and veto counterfactuals). One of the Wave-2
lanes from the composite expert review (`docs/reviews/2026-07-04-composite-expert-review.md`,
§A). Lands via the landing train after the base branch lands — push only, no PR from this lane.

## Summary

Four §A items, in dependency order:

1. **The outcome writer** (§A "Build the outcome writer", high/M — the single most-blocked-on
   item). New scheduled maturation job `src/lib/outcome-engine.ts`
   (`matureSocraticDecisionOutcomes`) piggybacking the counterfactual cadence (fired
   fire-and-forget in `strategy.ts` right after `materializeSkippedCandidateCounterfactuals`).
   It joins **placed** decisions to their `fill_events` entry basis (new
   `listFillEventsByProposalId` in `db-fills.ts`) and, when the FIFO lot has closed, to the
   realized closed-lot P&L from `performance.calculatePnl`; **blocked/rejected** decisions
   (including Bear vetoes — they insert counterfactual rows since W1) join to their
   skipped-candidate counterfactual `refPrice` via new `getSkippedCounterfactualByRunSymbol`.
   Writes `outcome` + `measuredAt` through new `writeSocraticDecisionOutcome` in
   `db-socratic.ts`, which emits a `socratic_outcome_recorded` receipt per case and AWAITS the
   vector-memory lifecycle re-index (`indexSocraticDecisionMemory` — deterministic for a
   background job, still non-fatal). Job-level `socratic_outcome_job` receipt carries counts +
   coverage disclosure.

2. **Multi-horizon outcome schema** (§A high/L). `SocraticDecisionCase.outcome` now carries
   `outcomes: SocraticOutcomeHorizonRow[]` — `{horizon: 15m|1h|1d|1w, returnPct, spyExcessPct,
   altReturnPct?, maturedAt, priceBasis, resolution: ok|unresolvable(+reason)}` — on decision
   cases AND on `skipped_candidate_counterfactuals` rows (new `outcomes` JSON column). 1d/1w
   are measured from daily closes via the provider cascade (`history.fetchDailyOHLC`),
   SPY-relative under the same side convention (a short is compared against shorting SPY);
   horizon arithmetic is TRADING days via the shared W1 `addTradingDays` helper. 15m/1h resolve
   ONLY when the job actually samples a live quote inside the horizon's tolerance window
   (Yahoo quote, `fetchQuote` seam) — since no intraday history source exists, a missed window
   is recorded honestly as `unresolvable(no_intraday_source)`, never interpolated from daily
   bars. Pure horizon math lives in new `src/lib/outcome-horizons.ts`, shared by the outcome
   engine and the counterfactual materializer. `altReturnPct` is reserved in the schema
   (optional) and not yet populated — no alternative join exists yet, and we don't fabricate.

3. **Kill survivorship in the learner joins** (§A high/M-L, scoped). Terminal `unresolvable`
   status (+ `resolution_reason` column) on skipped counterfactuals after a bounded recheck
   window (`UNRESOLVABLE_AFTER_TRADING_DAYS = 10` trading days past target): delisted/renamed
   symbols stop sitting 'pending' forever. Unresolvable rows count in every denominator:
   `getSkippedCounterfactualCoverage` / `getSocraticOutcomeCoverage` produce
   "N/M resolved (X%) — U unresolvable; may be survivor-biased" disclosures, stamped on the
   maturation job receipt; `getRedTeamEfficacy` gains `unresolvableVetoes` + `coverage`;
   `summarizeMissedOpportunities` accepts/propagates an optional `coverageDisclosure` (wired
   in the tuning context via new `getMissedOpportunityCoverage`); `certifyForwardResolution`
   gains a `coverageDisclosure` string.

4. **Real per-decision lessons at maturation** (§A high/M). When the job closes a case with at
   least one resolved horizon, a budget-gated (`isOverLlmBudget` + `withLlmGeneration`'s durable
   backstop), batch-capped (default 3/run) LLM post-mortem pass judges belief + dissent +
   evidence against the realized multi-horizon outcome → 1-3 concrete lessons with direction
   `(repeat|avoid|adjust-sizing|adjust-timing)` plus `{verdictOnBelief, whichDissentMattered}`.
   Lessons replace the creation-time template strings via new `writeSocraticDecisionLessons`
   (receipt + awaited re-index) and each routes through `ingestLearned` (origin `autonomous`,
   fail-closed classifier decides fact vs pending-approval tier). No LLM key / over budget /
   unparseable response → `socratic_lessons_skipped` receipt with the reason; the job never
   fails. `llm` option is an injectable seam for tests.

Also: `socratic-memory.ts` now renders the horizon ladder (+ SPY excess + unresolvable reasons)
in the embedded case text, so retrieval sees matured outcomes, not "outcome: pending".

## Why

Both expert panels independently identified loop-step-5 closure (matured outcomes on decision
cases) as the highest-leverage blocked item: lessons, analogs, usefulness scoring, and the
harness are all downstream of it. The philosophy constraints are binding: receipts everywhere,
advisory-only (this lane writes memory, gates nothing), honest `unresolvable` over fabricated
numbers, sole user / no compat shims (the outcome shape was extended in place; nothing ever
wrote it before).

## Files

- `src/lib/outcome-engine.ts` — NEW: the scheduled maturation job + LLM post-mortem pass.
- `src/lib/outcome-horizons.ts` — NEW: pure multi-horizon forward-return math (shared).
- `src/lib/types.ts` — `SocraticOutcomeHorizon(+Row)`, `SocraticOutcomeResolution`; outcome
  object extended with `outcomes[]` + `unresolvable` status.
- `src/lib/db.ts` — `outcomes`/`resolution_reason` columns on
  `skipped_candidate_counterfactuals` (CREATE TABLE + guarded ALTERs).
- `src/lib/db-learning.ts` — row mapping for the new columns;
  `markSkippedCounterfactualUnresolvable`, `listSkippedCounterfactualsByStatus`,
  `getSkippedCounterfactualCoverage`, `getSkippedCounterfactualByRunSymbol`;
  `markSkippedCounterfactualMatured` accepts `outcomes`.
- `src/lib/db-socratic.ts` — `listSocraticDecisionCasesNeedingOutcome`,
  `writeSocraticDecisionOutcome`, `writeSocraticDecisionLessons`, `getSocraticOutcomeCoverage`.
- `src/lib/db-fills.ts` — `listFillEventsByProposalId`.
- `src/lib/counterfactual-learning.ts` — multi-horizon rows at maturation (incl. one SPY fetch
  per run), bounded-window terminal `unresolvable`, `markedUnresolvable` in the result.
- `src/lib/performance.ts` — `getRedTeamEfficacy` `unresolvableVetoes` + `coverage`;
  `getMissedOpportunityCoverage`.
- `src/lib/strategy-tuning.ts` — optional `coverageDisclosure` on
  `SummarizeMissedOpportunitiesOptions`/`MissedOpportunitySummary`, wired in the tuning context.
- `src/lib/backtest.ts` — `coverageDisclosure` on `ForwardResolutionCertification`.
- `src/lib/socratic-memory.ts` — horizon ladder rendered in the case memory doc.
- `src/lib/strategy.ts` — one fire-and-forget cadence hook after the counterfactual
  materialization (dynamic import; outside the risk-lane and retrieval-lane regions).
- `test/outcome-engine.test.ts` — NEW: placed join (fill + closed lot + receipts + re-index +
  lessons + idempotency), blocked/counterfactual join, terminal-unresolvable case + coverage +
  red-team disclosure, lesson-skip receipt, materializer multi-horizon rows, bounded-window
  pending→unresolvable transition.
- `test/counterfactual-learning.test.ts` — updated fetcher-call expectation (SPY prefetch).

## Verification (run in this worktree, in order)

- `npm run lint` — 0 errors (308 pre-existing grandfathered warnings).
- `npx tsc --noEmit` — clean.
- `npm test` — full suite green: 2383 tests passed, 246 files (includes the 6 new outcome-engine
  test cases; 9 assertions files-wide across the new + updated learning tests).
- `npm run build` — green.

## Follow-ups

- Console/Results UI for the outcome ladder, coverage badges, and lessons — console lane owns
  the rendering; everything needed is on the case JSON + coverage functions.
- `altReturnPct` (vs-alternatives) — needs an alternative-taken join; reserved in the schema.
- A durable due-jobs substrate for guaranteed 15m/1h sampling (separate later item per the
  composite review); today intraday rows resolve only when the cadence happens to land inside
  the window, otherwise honest `unresolvable(no_intraday_source)`.
- Multi-horizon IC (1/5/20/60d) in `buildFactorObservations`/`computeFactorICs` + tuner
  horizon targeting — the §A item's second half, not in this slice (backtest learner untouched
  beyond the coverage disclosure).
- Exit-side counterfactuals (§A medium) would reuse `outcome-horizons.ts` directly.

## 2026-07-04 addendum — landing operator merge-forward, dedup fix, re-verify

This branch had been sitting on top of `origin/claude/w1-learning-loops` since before PR #365's
Codex-review fixups and PR #437 landed on `main`; the worktree (`~/apps/trading-wt-w2-outcome`)
was left mid-merge (conflict markers present, uncommitted) by the prior operator. Resolved every
conflicted file:

- `docs/EFFORT-LOG.md`, `docs/phase-7-strategy.md`, `docs/rollouts/2026-07-04-w1-learning-loops.md`
  (add/add) — keep-both-newest-first per the docs protocol; main's continuations were strict
  supersets in every hunk (PR numbers filled in, w1-learning-loops marked **merged**, the Codex
  review-fixes section appended).
- `src/lib/strategy.ts` — two small hunks around the Bear-veto audit call (~line 809). This
  branch never touched these lines itself (inherited them from its `w1-learning-loops` base
  before that base's own Codex-review fixup landed on main); took `origin/main`'s newer version
  verbatim (adds `connectedAccountId` account-scoping to the audit call + explanatory comments).
  Not in Monet's owned regions (breaker ~340-405, drawdownAdvisory ~2624).
- `src/lib/db-socratic.ts` — HEAD added four new outcome-engine functions
  (`listSocraticDecisionCasesNeedingOutcome`, `writeSocraticDecisionOutcome`,
  `writeSocraticDecisionLessons`, `getSocraticOutcomeCoverage`) in a slot where main had nothing;
  kept HEAD's additions in full, just removed the markers.
- `test/performance.test.ts` — two new `getRedTeamEfficacy` tests from main
  (kind-scoped-audit-flood, exit-veto-exclusion) landed in the same slot as nothing on HEAD's
  side; kept both (union), no actual overlap.
- `src/lib/backtest.ts`, `src/lib/counterfactual-learning.ts` — flagged `UU` by git status but
  had **zero actual diff** between the merged working-tree content and either parent; git had
  already resolved these via its own line-level merge (HEAD's Outcome Engine additions —
  `coverageDisclosure`, `markedUnresolvable` — coexist correctly with main's `marketDateOf`
  America/New York timezone fix for snapshot/anchor dates). Just needed `git add` to clear the
  unmerged flag.

**Real semantic conflict caught by `tsc`, not by git:** the merge silently produced two full
duplicate copies of `RedTeamEfficacy` (interface) and `getRedTeamEfficacy` (function) in
`src/lib/performance.ts` — no textual conflict markers because git's line-level merge algorithm
treated each copy as a clean insertion in a different hunk, but the result was two exported
symbols with the same name (`TS2323`/`TS2393`). Compared both: the surviving one (kept, ~line
875-1017) is the newer Codex-reviewed implementation — `connectedAccountId`-scoped, uses
`listAuditByKind` (LIMIT-after-kind-filter) + `getMaturedSkippedCounterfactualByRunSymbol` keyed
lookups, excludes exit-side vetoes from `totalVetoes` — matching the "Codex review fixes" section
in `docs/rollouts/2026-07-04-w1-learning-loops.md`. The duplicate (removed, was ~line 1043-1179)
was the older pre-review version (`listAudit` + full scan, no account scoping, no exit-veto
exclusion). Separate commit `e28db55` isolates this fix from the merge commit itself.

Re-ran the full local quartet after the merge + dedup fix, in this worktree:
- `npm run lint` — 0 errors (308 pre-existing grandfathered warnings).
- `npx tsc --noEmit` — clean (this is what caught the duplicate-function conflict above).
- `npm test` — 252 files / 2455 tests passed (up from 2383 pre-merge; deleted stale gitignored
  `data/app.db` first).
- `npm run build` — green.

Landing via `scripts/land.sh` next; this is a push-only lane (no PR) per the original plan —
lands via the active landing train.
