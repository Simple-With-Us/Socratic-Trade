# Socratic Trade — Expert Design Review & Improvement Backlog

*Produced by an 8-expert panel (ML/learning, RAG/embeddings, LLM prompting, quant/risk, data-providers, data-ingestion, UI/UX, ML-systems), synthesized by Monet — 2026-07-04.*

This document reviews Socratic Trade, a real-money autonomous stock-trading application (Next.js + TypeScript, SQLite, an LLM Bull/Bear/Manager loop in `src/lib/strategy.ts`, Pinecone + Voyage RAG, a ~15-provider market-data cascade, and an explainability-first `/console` pro UI). The panel found an unusually mature codebase — a real learning loop, a rigorous walk-forward backtest with point-in-time certification, a strong RAG pipeline, honest per-field data provenance, and a decision-receipt approval UI. The findings below are the *next* layer of rigor on top of that base, not a rescue of a stub. Every recommendation honors the product philosophy: real trading at the owner's accepted risk, guardrails as overridable preferences, and no paternalistic "are-you-sure" ceremony or paper-mode defaults.

Each finding is written as: **title** — the gap and why it matters; **How:** the concrete fix with the real techniques and file references; and an **[impact / effort]** tag (effort S/M/L).

## Executive summary

The panel converged on twelve cross-cutting themes, ordered by leverage:

1. **Episodic trade memory is the missing bridge between learning and RAG.** The loop learns only *aggregate* scorecards and the vector store holds only SEC filings; there is no case-based recall of "the N most similar past setups and how they actually resolved," and no regime-conditioned retrieval of lessons. The same Voyage/Pinecone infrastructure that serves filings should serve realized-trade analogs and tagged lessons — this is the single highest-leverage decision-quality lever missing.

2. **Query construction is the ceiling on an otherwise excellent RAG stack.** Every symbol fires the identical static template into a strong rerank+hybrid pipeline, and the built-and-tested relevance-floor / near-dup / hybrid stages sit dormant at the two real call sites. HyDE + evidence-derived multi-query, plus wiring the dormant stages on, is a large retrieval-quality gain for little code.

3. **Scout-then-analyst staging ties prompting ↔ ingestion ↔ cost.** A cheap pre-pass to shortlist candidates, agentic on-demand evidence tools for the 1–3 names actually being weighed, per-data-class cache TTLs, and cross-provider field-demand planning together cut token and provider spend by an order of magnitude while sharpening what the expensive model sees.

4. **Point-in-time / look-ahead integrity must be certified across the whole stack, not per-module.** Prices are rigorously PIT in the backtest, but macro reads today's revised FRED print, RAG as-of filtering is lossy post-fetch, horizons are counted in calendar (not trading) days, amended filings never supersede, and IC is measured on a survivor set. Each is a silent hindsight leak into the real-money auto-apply gate.

5. **The autonomous weight-tuner is not yet statistically honest about repeated testing.** Overlapping 5-day IC windows are treated as independent (inflating the paired-t), and there is no multiple-testing / Deflated-Sharpe / PBO correction across the ~365×/yr auto-apply cadence — exactly how an autonomous loop eventually "finds" and persists a spurious edge on real capital.

6. **The per-model learning loop is recorded but never closed.** `proposedByModel` is persisted on every proposal and shown on the approval card, yet nothing scores realized outcomes *by model*, no randomized assignment makes the comparison causal, and no bandit routes toward the stronger model — model choice is the highest-leverage decision variable with a wide-open loop.

7. **Regime handling should be a graduated, multi-signal, typed severity — not a binary VIX-40 brake.** Credit spreads, VIX term-structure, and breadth are fetched but never enter the deterministic label; de-risking is all-or-nothing at panic; and gates couple to regime *strings* via brittle substring matching. A typed severity score driving vol-targeting, portfolio-heat, and a continuous exposure taper upgrades every regime-conditioned behavior at once.

8. **The flagship pro surface has the stalest data of the three clients.** The `/console` polls a full 15s snapshot while the phone already streams SSE; it also ships a hand-rolled SVG chart while `lightweight-charts` is a paid, wired dependency, and exposes no live risk-utilization board though the server already computes every cap. Wiring the stream, adopting the chart lib, and surfacing risk headroom are pure upside.

9. **Portfolio-level risk lives in the gaps between per-name gates.** There is no total-open-risk ("heat") budget, no factor-crowding aggregation (a book of momentum names is one bet), only symmetric full-sample correlation (blind to crisis correlation convergence), and no joint construction over the surviving batch — the true "Manager" step the Bull→Bear→decide framing implies.

10. **Evaluation does not yet feed model/prompt selection.** The strategist prompt "is the product," but only its hard schema guards are regression-protected — there is no behavioral golden eval, no run-level trace tree, no factor-adjusted alpha, and no registry mapping (promptVersion × model) → realized outcome with a promotion gate.

11. **Large cost savings are available with no quality loss.** A single global 6h TTL pins even the "real-time" Alpaca snapshot stale; providers skip negative-caching and single-flight coalescing; paid fundamentals are fetched per-symbol instead of in bulk and for fields another tier already filled; and content-hash dedup + embedding quantization are off. These are mostly one-line or single-module fixes.

12. **The app's core differentiator — honest, legible decision support — is silently lost on touch and to keyboard/AT users.** Most provenance and "what this means" text is trapped in native `title` tooltips (invisible on mobile, on focus, and to screen readers), and the approval card omits the sizing rationale, evidence citations, failover/truncation history, and per-model calibration the backend already holds.

---

## A. Memory & learning (remembering and learning lessons)

**Current state.** This is an unusually mature learning loop, not a stub. Realized outcomes are bucketed by thesis, regime, thesis×regime, sector, dominant-factor, entry-signal, and confidence band — all Bayesian-shrunk (`performance.ts`) and injected into the Bull prompt. Post-mortem reflection is history-signature-gated and also emits structured qualitative track-record facts. Autonomous factor-weight tuning (`strategy-tuning.ts` + `auto-tune-scheduler.ts`) is genuinely sophisticated: cadence-gated, an OOS walk-forward IC gate, paired-t significance, drawdown/starvation guards, IC-shrinkage, purge+embargo splits, a unified `learning_mutations` ledger with revert, a shadow ledger, a fail-closed invariant guard, a read-only dry-run, and a point-in-time forward-exit invariant plus survivorship certification. Counterfactuals mature skipped candidates and rejected proposals at a forward horizon. The gaps are concentrated at the top of the stack: no episodic memory of past *trades*, reflection is one opaque per-account blob, Bear vetoes go unmeasured, overlapping-sample statistics are treated as independent, and there is no per-model attribution, drift detection, multiple-testing correction, cross-account pooling, or exploration policy.

**No episodic experience-replay / case-based memory of past trades at decision time** — `vector-db.ts` stores only SEC filings; the `findRelevantExperiences`/`upsertExperiences` the design references do not exist. At proposal time the Bull gets aggregate scorecards but never "here are the N most similar historical setups and exactly how they resolved," so aggregate stats wash out the setup-specific structure the LLM reasons best over.
**How:** Build a trade-experience store — on every closed lot, embed a state vector (the 8 factor sub-scores + `entryMarketRegime` + macro snapshot + thesisTag + sector, optionally a Voyage-embedded rationale) into a dedicated Pinecone namespace or local ANN index keyed by `proposalId`, with realized `{returnPct, holdingDays, riskExit, mae, mfe}` as metadata. At proposal time, k-NN retrieve the 5–10 closest priors per candidate and inject a compact "analogous past trades and outcomes" block. Write hook in `performance.recordFillFromProposal`, read hook in `strategy.ts` `proposeTrades` alongside `ragContext`/`learnedContext`; new `src/lib/experience-memory.ts`. Must exclude same-run/future neighbors and stamp as-of like the filing RAG.
**[high / L]**

**Reflection is a single opaque per-account blob; no regime/thesis-conditioned retrieval of lessons** — `generateReflectionSummary` writes ONE ≤130-word string per account and injects it wholesale into every Bull prompt regardless of today's regime; `retrieveLearnedContext` accepts a `regime` arg that "is not yet used as a filter," so a lesson formed in a high-VIX panic is fed verbatim during a calm trend.
**How:** Decompose reflection into discrete, tagged, retrievable lesson rows (dimensions: regime, thesisTag, dominantFactor). Store each in `learned_context` with its regime/thesis, then wire `retrieveLearnedContext` (`learned-context/store.ts`) to filter/boost by the current run regime (`determineMarketRegime` already computes it) and the candidate theses; only inject lessons whose regime/thesis match today. Gate emission on a minimum sample and fall back to regime-agnostic lessons for thin regimes.
**[high / M]**

**Bear (Red Team) vetoes are dropped with zero counterfactual** — the debate loop does `audit('proposal_rejected_by_red_team')` then `continue`, never calling `recordRejectedProposalCounterfactual` (policy-blocked openings ARE fed to the counterfactual pipeline; Bear-vetoed ones are not). There is no realized-outcome tracking of what the Bear killed and no way to compute its hit rate — the adversarial pass runs the model twice per high-conviction trade on pure faith and could be silently costing alpha.
**How:** In the Bear-reject branch call `recordRejectedProposalCounterfactual({symbol, refPrice: proposal.referencePrice, regime, runId})` exactly as the policy-block path does, then add `getRedTeamEfficacy()` in `performance.ts` joining matured vetoed-candidate returns to compute avoided-loss vs would-have-been-a-winner rates. Surface it advisory in the tuning context and dashboard; reuse the shared materializer for horizon/PIT care.
**[high / S]**

**Overlapping-sample IC statistics treated as independent — the auto-apply gate's paired-t SE is overstated** — `backtest.ts` computes per-date ICs on daily snapshots against a 5-day forward return; `pairedICDiffStats` derives `seDiff = std/sqrt(n)` assuming i.i.d. per-date diffs, but 5-day-overlap windows are heavily autocorrelated (effective n ≈ n/5), so the t-stat feeding `minOosPairedTStat` is inflated — exactly how overfit weights get auto-applied.
**How:** Replace the naive SE with an overlap-aware estimator: Newey-West/HAC standard errors with lag = `horizonDays−1` on the per-date IC-difference series, or a stationary/block bootstrap (block ≈ horizon), or de-overlap by subsampling every horizon-th snapshot date. Apply the same to `oosICIR`. Gate math in `pairedICDiffStats`/`computeCompositeIC`/`applyAutonomousWeightTuning`. Correct SE makes the gate stricter (the safe direction) — document it so the cadence isn't misread as broken.
**[high / M]**

**No multiple-testing correction across repeated auto-apply attempts** — the 24h auto-tune cadence runs the OOS/paired-t gate ~365×/yr at a fixed threshold (§E.6/E.15 explicitly defers Šidák/Bonferroni "until a per-account trial counter exists"); with enough trials at a fixed t you eventually pass by chance.
**How:** Add a per-account trial counter (a settings row beside `last_auto_tune_at`) and deflate the bar with the number of prior evaluations: Bonferroni/Šidák on the effective trial count, or better a Benjamini-Hochberg FDR over the trial series, or a Deflated Sharpe Ratio (Bailey & López de Prado 2014) using the trial count. Wire the counter into `autonomousOosThresholds` so `minOosPairedTStat` scales with trials. Pair with the overlap-SE fix (same gate).
**[high / M]**

**No per-model outcome attribution despite multi-model failover** — `TradeProposal.proposedByModel` is persisted per proposal but no scorecard groups realized outcomes by it, so the agent cannot learn which model produces better realized P&L, detect a model regression, or route toward the stronger model.
**How:** Add `getModelScorecard(accountNumber, source)` in `performance.ts` (reuse `aggregateClosedLots` with key = `lot.proposedByModel`, threading `proposedByModel` onto `ClosedLot`). Surface advisory in the tuning context and dashboard. Step-change: a contextual bandit (Thompson sampling over per-model shrunk win-rate, conditioned on regime) to bias failover order toward the historically-better model, with an exploration floor. Confounded by regime/time — condition on regime and shrink hard on small samples. (Converges with G1/G2 and B22.)
**[medium / M]**

**Single fixed 5-day horizon for all IC/counterfactual learning, mismatched to actual holding periods** — both `counterfactual-learning.ts` and `backtest.ts` use `DEFAULT_HORIZON_DAYS=5`, but the playbook spans Value, Earnings Catalyst, Mean Reversion, and Breakout with wildly different natural horizons; IC at 5d optimizes weights for a horizon the strategy may not trade.
**How:** Compute multi-horizon IC (1/5/20/60 trading days) in `buildFactorObservations`/`computeFactorICs` and let the auto-tuner target the horizon matching each thesis's median realized `holdingDays`. At minimum, horizon-match the counterfactual to the thesis's empirical median hold. Report the IC term structure so weight changes are validated at the horizon traded. Cache OHLC per symbol (already done) and cap horizons.
**[medium / M]**

**Calendar-day horizon arithmetic biases forward returns vs true trading-day windows** — both `targetBusinessDate` implementations do `snapshotDate + horizonDays * 86_400_000ms` then pick the first bar on/after, so a Thursday snapshot spans a weekend (~3 trading days) while a Monday snapshot lands ~5 — the effective horizon silently varies with weekday/holidays, adding noise to every IC and counterfactual the auto-apply gate actuates.
**How:** Offset by trading-day bar count, not calendar milliseconds — index into the already-fetched, business-day-keyed OHLC series by `horizonDays` bars after the entry bar, sharing one helper across both modules and honoring `market-calendar.isTradingDay`. Snapshot-test the new resolution and note the one-time discontinuity in historical counterfactuals.
**[medium / S]**

**Learning is single-account-siloed with a fixed neutral prior; no hierarchical partial pooling** — every scorecard shrinks toward a fixed 50%/0% neutral prior and each account must independently accumulate ≥20 closed lots before weights move, so a new or thin account borrows no strength from the owner's other accounts.
**How:** Empirical-Bayes / hierarchical partial pooling — estimate the population mean win-rate/IC per thesis×regime across the owner's accounts (or the opt-in shared tier) and shrink each account toward that data-driven prior instead of a fixed constant (James-Stein / Beta-Binomial in `aggregateClosedLots`; `resolveShrinkPrior` is the seam). Respect isolation: aggregate only within one owner's accounts or the opt-in shared tier, never leaking another user's outcomes.
**[medium / L]**

**No drift / change-point detection; all history weighted equally with no time-decay** — scorecards aggregate the last 500 fill events with no recency weighting, so an 18-month-old lot counts as much as last week's, and there is no CUSUM/Page-Hinkley monitor on realized IC or win-rate to detect a decayed edge.
**How:** Add exponential time-decay (half-life ~60–90 trading days) to scorecard aggregation and a change-point detector (Page-Hinkley or CUSUM) on the per-date OOS IC series in `backtest.ts`; on a downward change-point, widen exploration, discount pre-break history, and notify the operator. Couple with the hierarchical prior so decayed thin buckets fall back to population estimates.
**[medium / M]**

**Selection-biased training signal with no exploration policy or inverse-propensity correction** — positive outcomes come only from names the strategy chose, chosen by the very weights being tuned (a closed loop); skipped-candidate counterfactuals cover only the top-25 skipped-by-score, so deep-underdog names are never sampled and factor ICs are estimated on a truncated, endogenous slice.
**How:** Introduce a small exploration budget — with probability epsilon (or via Thompson sampling on factor-weight posteriors) size a floor position in a lower-ranked candidate for unbiased coverage, and apply inverse-propensity / doubly-robust weighting when computing factor ICs to de-bias the selected sample. The counterfactual materializer is the natural home for propensity bookkeeping. Keep epsilon at the exploratory sizing floor and make it an overridable owner preference.
**[medium / L]**

**Missed-opportunity nudge is one-sided (up-only) and transient, never fed to the persisted OOS-gated path** — `applyMissedOpportunityNudge` only ever ADDS weight to a factor recurring among missed winners, never symmetrically down-weighting a factor that dominated skipped names that then fell; it is also this-run-only and bypasses the rigorous OOS gate, biasing weights monotonically upward.
**How:** Make the nudge symmetric — down-weight a factor recurring among skipped losers (avoided-loss signal), using the existing hit-rate machinery that classifies winners AND losers — and route the persistent version through `applyAutonomousWeightTuning` (candidate-vs-baseline IC) so a nudge only sticks if it survives walk-forward.
**[medium / S]**

**OPRO-style prompt self-optimization missing; AI-LEARNED directive blocks only append, never prune** — §3.D.3 calls for OPRO prompt auto-pruning ("still TODO"); `mergeStrategyDirectiveBlock` only appends attributed blocks, so the strategy prompt grows monotonically and carries stale rules from prior regimes, and the offline eval harness isn't used to optimize the prompt.
**How:** Add an offline prompt-optimization loop (OPRO / APE / DSPy-style): generate candidate directive edits, score them on the deterministic offline eval + a held-out slice of `signal_snapshot` outcomes, keep only improving edits. Tag each AI-LEARNED block with its regime and add a pruning pass that expires directives not validated in the recent regime. Keep human-approved-apply and version every change through `learning_mutations`.
**[medium / L]**

**Factor/signal attribution reads a 500-row rolling audit ring, so long-horizon learning silently decays** — `getFactorScorecard`/`getSignalEfficacy` resolve a closed lot's entry factors by scanning `listAudit(500)` for the matching `signal_snapshot`; once a run ages past 500 rows, attribution falls back to the persisted `dominantFactor` stamp only and full `factorBreakdown`/bulletin context is lost — exactly for the long-horizon trades most valuable to learn from.
**How:** Promote `signal_snapshot` to a first-class indexed table (`run_id, symbol, factor_breakdown JSON, regime, bulletins, chosen`) with retention independent of the audit ring, and query it directly in the scorecards. `db.ts` `migrate()` adds the table; `counterfactual-learning.ts` and `backtest.ts` already parse the same payload. Keep the audit write and dual-read during transition.
**[medium / M]**

**MAE/MFE timing lessons bypass the provider cascade and never feed exit/stop tuning** — `calculateExcursions` fetches `query1.finance.yahoo.com` directly (no cascade, no caching, no PIT guard), and the resulting `capturePct`/`avgMae`/`avgMfe` are shown as advisory prose but never wired into stop-loss/take-profit tuning despite the design intent.
**How:** Route excursion OHLC through `history.fetchDailyOHLC`/the provider cascade (as `backtest.ts` already does) for caching and consistency, then close the loop: chronically low `capturePct` → recommend a wider take-profit; consistently deep `avgMae` before winners → recommend a wider/ATR-scaled stop, surfaced as an OOS-gated tuning suggestion (`riskRules.takeProfitPct`/`stopLossPct` already in the schema). Keep human-approved.
**[medium / M]**

**Confidence calibration limited to 4 coarse win-rate bands; no Brier/ECE or continuous fit, long-only** — `getConfidenceCalibration`/`calibratedConviction` bucket into 4 bands and isotonic-remap downward-only, long-only; there is no Brier/ECE/log-loss, no reliability diagram, and shorts get no calibration.
**How:** Compute Brier / ECE and a reliability curve over the continuous `confidenceScore`, fit the isotonic/Platt remap on the continuous score, and extend to a separate short-side reliability curve. Report ECE on the dashboard. Keep the downward-only sizing safety but drive it from the continuous fit; shrink toward the band curve when thin. (Converges with B12/G14.)
**[low / M]**

## B. LLM prompting & utilization

**Current state.** A genuinely sophisticated LLM harness, well above typical app-level prompting. Structured output is done right per transport — OpenAI strict `json_schema` with `additionalProperties:false` + full `required` + null-unions, Anthropic forced `tool_use`, DeepSeek `json_object` fallback (`llm-call.ts`, `llm-request.ts`) — and prompts are versioned (`STRATEGY_PROMPT_VERSION`) and stamped onto every proposal + Langfuse trace. The Bull proposer has a real cross-provider failover chain with served-model attribution, truncation is detected across all three transports (`detectLlmTruncation`), reasoning-effort is clamped to avoid run-lock timeouts, Anthropic prompt caching is wired via `cache_control` + beta header, and a rich realized-outcome scorecard suite (thesis/regime/combo/sector/factor/signal-efficacy/confidence-calibration, all Bayesian-shrunk) is injected into the Bull prompt. Main weaknesses: no self-consistency/ensembling (single `temperature:0` sample); robustness applied unevenly (Bull has failover+truncation handling; Bear/revalidation/post-mortem/debate do not); no structured-output repair loop; prompt-cache efficiency undercut by interleaving volatile data into the system prompt; and the "Manager/decide" step being purely deterministic with no LLM judge synthesizing Bull-vs-Bear disagreement.

**No self-consistency / k-sample ensembling on the money path** — every LLM call is a single greedy `temperature:0` decode (`llm-request.ts`); one sample is high-variance for a real-money decision.
**How:** Optional k-sample majority-vote for the Bull (k parallel calls at temp≈0.4–0.7 or varied effort; keep proposals recurring in ≥⌈k/2⌉ samples; recurrence frequency = an independent confidence signal into sizing) behind a policy knob, in `proposeTrades`.
**[high / L]**

**Robustness features are Bull-only; Bear/revalidation/debate/post-mortem are single-attempt** — a 429/5xx on the Bear just fails to `bearUnavailable` and dumps to human review.
**How:** Extract the Bull's attempt-chain into a shared `callWithFailover(attempts, parse)` and reuse in the inline Bear, `debateProposal` (`red-team.ts`), `revalidatePendingProposals`, and `generateReflectionSummary`.
**[high / M]**

**Failover fires only on transport errors, never on parse/schema failure** — unparseable JSON degrades the Bull to zero proposals / the Bear to `fallbackToBull` without trying the fallback model.
**How:** Treat `JSON.parse`/schema-validation failure as retryable inside the failover loop; only degrade after all attempts fail.
**[high / M]**

**No structured-output repair loop** — a 95%-valid response (trailing comma, fence, truncated last object) is discarded.
**How:** One repair round-trip on parse failure ("your previous output failed with `<error>`; return only valid JSON"). Recovers most drift far cheaper than a full re-run.
**[medium-high / M]**

**Parsed output is never validated against the declared JSON schema at runtime** — `sanitizeProposals` only checks symbol/side/type; OpenAI-compatible providers (Gemini/xAI/Qwen via chat-completions) vary in strict-schema fidelity, so drift passes as "JSON-shaped."
**How:** Compile schemas with `ajv`/`zod`, validate post-parse, route failures into the repair/failover path.
**[medium-high / M]**

**Volatile data interleaved into the Bull SYSTEM prompt defeats prompt caching** — `buildBullSystem` bakes reflection, tax lines, execution mode, horizon, and numeric limits into the system string; any change busts the cached prefix.
**How:** Make the system prompt 100% static (glossary+rules); move all per-run/user values into the user message to maximize Anthropic `cache_control` + OpenAI auto-prefix hits and enable cross-run cache sharing.
**[medium / M]**

**Prompt caching is Anthropic-only, single-breakpoint, and doesn't cache shared per-run evidence across Bull→Bear→debate** — only system text carries `cache_control`; the forced-tool `input_schema` + shared evidence resent to Bear/debate is not cached.
**How:** Use up to 4 `cache_control` breakpoints (tools/schema, static system, stable leading evidence block) so same-run Bear/debate reuse the Bull's cached KV; verify via `cache_read_input_tokens`.
**[medium / M]**

**No scout-then-analyst two-stage evidence retrieval; every top candidate gets ~40 fields unconditionally** — `compactCandidateForPrompt` emits ~40 fields for the full `topCandidates` list, so token spend scales with universe size, not decision value.
**How:** A cheap "scout" pre-pass (DeepSeek Flash / Grok Fast) ranks a shortlist from a slim field set; send full evidence only for the shortlist to the expensive Bull. (Ties to D's field-demand planner and C's JIT ingest.)
**[high / L]**

**The "Manager/decide" step has no LLM judge to synthesize Bull vs Bear** — aggregation is deterministic (policy gate + `applyDeterministicSizing`).
**How:** Optional lightweight Manager/judge turn over `{bullProposal, bearCritique, scorecards}` → reconciled decision + calibrated size multiplier (downsize on unresolved disagreement rather than drop). The deterministic gate stays the backstop.
**[medium / M]**

**Same-family echo chamber is the default; cross-provider Bear is off unless env-set** — Green and Red resolve to the same model by default; cross-family Bear needs `RED_TEAM_LLM_PROVIDER`.
**How:** Default Bear/debate to a different model family (Bull=GPT-5.x → Bear=Claude) as a first-class policy setting via `redTeamLlmModel`.
**[medium / S]**

**Everything runs at temperature 0, including adversarial red-teaming** — one greedy Bear surfaces one failure mode.
**How:** Run the Bear (or a small ensemble) at temp≈0.7 and union objections; temperature is already plumbed via `withLlmRequestBounds`.
**[medium / S]**

**Confidence→size recalibration exists but is opt-in/off and never measured** — `calibratedConviction` (isotonic remap) only runs when `policy.tuning.calibrationSizing` is set (default OFF), buys only; no ECE/Brier computed.
**How:** Compute ECE/Brier from the `confidenceCalibration` buckets and make monotone recalibration (isotonic/Platt) the DEFAULT into sizing, closing the loop instead of only asking the model to self-correct. (Converges with A16/G14.)
**[medium-high / M]**

**No adaptive reasoning-effort / model-tier routing by decision difficulty** — every reasoning model defaults to "medium"; an easy "nothing to do" tick costs the same as a hard conflicting-signal tick.
**How:** Escalate effort/tier only on hard cases (pre-filter vs Bear disagree, borderline confidence, conflicting evidence). Cost-aware routing per `manager-model-options.md`.
**[medium / M]**

**Truncation is detected but only audited, never auto-recovered; Bear/revalidation don't check it** — a truncated Bull logs + tells the operator to raise the cap manually; the visible cap is a shared 1500 while Anthropic gets 4096 (asymmetry).
**How:** Auto-retry once with a larger cap / failover model; add the truncation check to Bear/revalidation; raise the visible caps.
**[medium / S–M]**

**No agentic tool-use for on-demand evidence; RAG is pre-baked into the prompt** — `retrievedFinancialContext`/`learnedContext` are pushed wholesale; the Bull can't request more detail on a specific name.
**How:** Give the Bull a small tool set (`get_filing(symbol)`, `get_more_evidence(symbol, field)`) via native function-calling; fetch deep evidence only for the 1–3 names it's weighing. Step-change in grounding + token efficiency.
**[high / L]**

**Two overlapping red-team mechanisms with one un-versioned prompt** — the inline batch Bear (versioned) and per-proposal `debateProposal` coexist, but the debate system prompt is an inline string in `red-team.ts` that drifts independently of `STRATEGY_PROMPT_VERSION`.
**How:** Move the debate prompt into versioned `strategy-prompts.ts` and consolidate the adversary paths (see `docs/single-adversary-consolidation.md`).
**[medium / M]**

**No explicit reward for abstaining; the schema invites over-production** — the Bull schema caps at `maxItems` but never signals an empty array is a valid common outcome (the Bear prompt does; the Bull doesn't).
**How:** Add "returning zero proposals is correct when nothing clears your bar" to `buildBullSystem`; track the realized value of abstention (counterfactual on skipped runs).
**[medium / S]**

**No input-side token budgeting / pre-flight size guard** — `userContent` is `JSON.stringify`'d and sent unmeasured; only the per-day $/token ceiling backstops it.
**How:** Tokenizer pre-flight (`tiktoken`/Anthropic count-tokens) trims lowest-value context to a target budget; log estimated vs actual.
**[medium / M]**

**Fallback bodies are built eagerly for every configured fallback model** — `proposeTrades` pre-builds a request body per `llmFallbackModels` entry even though most runs never fail over.
**How:** Build fallback bodies lazily inside the loop, reusing the single serialized `userContent`.
**[low / S]**

**Bear reviews only proposed symbols, so it can't critique selection ("wrong name")** — `candidatesUnderReview` is filtered to the Bull's picks.
**How:** Include a slim ranked list of top non-proposed candidates (symbol+score+3–4 fields) so the Bear can flag selection errors.
**[low-medium / S]**

**Reflection memory is a single opaque free-text paragraph fed into the prompt** — `generateReflectionSummary` writes a ≤130-word blob into `reflection_summary` injected into the Bull system prompt; lossy, drift-prone, cache-busting. The structured `writeThesisTrackRecordFacts` sink already exists and is better.
**How:** Demote the free-text paragraph out of the system prompt (or replace with structured learned facts). (Converges with A2.)
**[medium / S–M]**

**Per-model performance is captured but not routed back into automatic model selection** — `proposedByModel` is persisted; `manager-model-options.md` describes A/B intent; selection stays manual.
**How:** A scheduled evaluator reads per-model realized scorecards and adjusts the strategist model (bandit / Thompson sampling on realized edge) within an owner-set allowlist. (Converges with A6/G1/G2.)
**[medium / L]**

## C. RAG, data ingestion & memory embedding

**Current state.** A genuinely mature RAG stack, well above typical app quality. `src/lib/vector-db.ts` runs a real pipeline: Voyage `voyage-finance-2` (1024-dim, finance-tuned) embeds into a cosine Pinecone index (`ensureIndex` even audits the metric via `assertIndexMetric`), over-fetch → cosine floor (`VECTOR_MIN_SCORE` 0.30) → point-in-time as-of guard (`isWithinAsOf` with acceptance_datetime→published_at→as_of precedence and a strict mode) → optional BM25/RRF hybrid → `rerank-2.5` cross-encoder (ON by default, fail-safe) → optional post-rerank relevance floor → optional Jaccard near-dup suppression, all in a pure, unit-tested `rankPool`. Ingestion is structure-aware (480-token chunks, 12% overlap, atomic tables, deterministic context headers, acceptance_datetime) with SHA-256 content-hash dedup plus accession-level dedup for 10-K/10-Q and 8-K. There is an embedding-integrity guard, a query-embed LRU cache, per-user + per-run budget guards with Write/Read-unit metering, an admin coverage route, and — impressively — an offline golden eval harness (~28 recall@k/MRR tuples) plus a faithfulness eval. Memory has three layers: salience-gated `user_memory`, structured `learned_context` (fail-closed classifier + approval inbox), and post-mortem reflection. The weaknesses are on the query/consumption side and in breadth/freshness of what reaches durable memory: a single static per-symbol query, several high-value stages left dormant, symbol-only scoping, no transcripts or embedded news, and a few point-in-time/reconciliation gaps (macro vintages, amended-filing supersede, no chunk text/model-version stored).

**Static per-symbol query — no HyDE, no evidence-derived multi-query, despite the RRF scaffolding existing** — every symbol's RAG query is the identical `Significant financial events, SEC filings, and macro catalysts for ${sym}`, retrieving only `topCandidates.slice(0,3)` at k=3; two different theses on AAPL (antitrust vs Services margin) fire the same query and get the same generic chunks, and a cross-encoder is only as good as its query. `rrfFuse` even documents "the multi-query item will reuse this," but neither HyDE nor multi-query was implemented.
**How:** Add HyDE (Gao et al. 2022) — have the in-loop LLM cheaply draft a 2–3 sentence hypothetical filing passage per intent facet (risk, guidance, litigation, supply chain), embed THAT, and retrieve. Add multi-query: derive 2–4 sub-questions from each candidate's actual evidence bulletins/thesis (the 8-K item text, congress cluster, technical trigger), retrieve each, and fuse with the existing `rrfFuse(rankedLists, 60)`. Widen beyond top-3 or make RAG demand-driven on candidates clearing the threshold. Cache HyDE embeddings via the query-embed LRU; gate by budget; measure on the golden set.
**[high / M]**

**Post-rerank relevance floor and near-duplicate suppression are built, tested, and dormant** — no caller passes `minRelevanceScore` or `dedupeSimilarity`; `strategy.ts` passes only `{docType, minScore, connectedAccountId}` and `orchestrator.ts` `{asOf, docType, minScore}`, so the Voyage relevance floor and Jaccard dedupe never run in prod. With 12% overlap plus repeated 8-K summaries, the final top-3 can be three restatements of one passage, crowding out the single risk chunk that would flip the decision.
**How:** Wire `minRelevanceScore` (~0.3–0.5 on rerank-2.5's scale) and `dedupeSimilarity` (~0.6 Jaccard) into both call sites now — the code, tests, and fail-open behavior already exist. Two-line change per site plus a golden re-run to tune thresholds.
**[high / S]**

**Retrieved chunks reach the LLM as a bare text blob — provenance, date, source, and relevance stripped** — `strategy.ts` does `validContexts.map(c => c.text).join('\n\n')` even though `RetrievedChunk` carries source, url, as_of, doc_type, section, score, and relevanceScore; the model can't weight a fresh 8-K over a 2-year-old 10-K risk factor and can't cite.
**How:** Format each chunk with a compact provenance header before joining, e.g. `[10-K · risk-factors · AAPL · 2026-02-01 · rel 0.82] <text>`, passing doc_type/section/as_of/source through. Purely additive, one call site.
**[high / S]**

**Retrieval is hard-scoped to `symbol:$eq` — no thematic/sector/macro cross-symbol recall** — every Pinecone query requires `symbol:{$eq:symbol}` and vectors carry no sector/industry/theme metadata, so a portfolio-level question ("which holdings have Taiwan supply-chain exposure") retrieves nothing unless you already know the ticker — exactly the cross-cutting questions that generate the best ideas.
**How:** Add `sector`, `industry`, and coarse `themes[]` metadata at ingest (available via `CascadingEnrichmentProvider`), and a symbol-optional retrieve mode filtering on `sector:$in`/`themes:$in` (or no symbol) for cross-cutting queries, exposed as a `searchKnowledge` chat-tool variant. Rely on the existing rerank + relevance floor to keep precision on larger pools.
**[high / M]**

**Earnings-call transcripts are retrieved-for but never ingested (dead doc_type)** — `strategy.ts` filters `docType` including `earnings-transcript` and `vector-db.ts` configures a `transcript` staleness horizon, but no producer ever writes a transcript vector; the single richest equity-RAG source (management tone, forward guidance, analyst Q&A) is absent, so the agent can propose the morning after a guide-down call with the contradicting transcript nowhere in the index.
**How:** Add a transcript connector mirroring `sec-filings.ts` — pull transcripts (the FMP `earningsTranscript` MCP tool is available here, or API Ninjas / earningscall.biz), chunk by speaker turn with `[CEO]`/`[Analyst Q]` role tags in the context header, set `doc_type="earnings-transcript"`, `acceptance_datetime = call datetime`, route through `storeDocument`, and dedup by (symbol, fiscalPeriod). Keep Q+A adjacency.
**[high / M]**

**News is fetched but never embedded into durable, point-in-time memory** — the Alpaca/Benzinga/Massive news paths feed only a transient scan-time bulletin overlay; no headline is chunked, dated, or upserted, so the agent cannot retrieve "what was the news around AAPL on 2026-05-02" and event-study/backtest replay is impossible.
**How:** Embed headline+summary as `doc_type="news"` with `published_at` as `acceptance_datetime`, entity-tag by symbol, dedup by URL/title SHA (reuse `hashContent` + the `storeContexts` dedup path), capped by the existing staleness horizons. Restrict to scan candidates + watchlist and apply the near-dup gate so syndicated wires don't multiply vectors.
**[high / M]**

**Post-mortem lessons are one overwritten per-account blob, not embedded or retrievable by symbol/regime** — `post-mortem.ts` writes a single ≤130-word `reflection_summary` injected into every Bull prompt; `writeThesisTrackRecordFacts` helps but its facts are directional-only and never embedded for similarity retrieval.
**How:** Write per-(thesis, regime) outcome lessons as vectors (`doc_type="lesson"`) carrying realized win-rate/MAE-MFE/capturePct, then at run time retrieve the lessons whose thesis/regime match this run's candidates and the current regime instead of dumping one global paragraph. Keep the blob as a fallback. (This is the RAG-side complement to A2's regime-conditioned reflection.)
**[high / M]**

**No options-flow / unusual-options / dark-pool ingestion in the alt-data mix** — alt-data breadth stops at FINRA short volume, Form-4 insiders, and congress; there is no options order-flow, unusual-activity, put/call skew, or gamma-positioning ingestion, and dark-pool prints are only proxied by short volume — a major positioning channel absent.
**How:** Add an options-flow connector (Robinhood option chains are available via MCP for a computed unusual-activity/skew summary, or a paid UOA feed), embed daily per-symbol summaries as `doc_type="options-flow"` with as_of dating, and surface a bulletin like the other web-sources. Start with the free Robinhood-derived skew/OI summary behind a flag. (Complements D6's Tradier IV enrichment.)
**[medium / M]**

**FRED macro regime and volatility signals are not embedded — macro context is unavailable to semantic retrieval** — congressional trades and insider filings can be embedded, but FRED macro series / regime narratives and the VIX/VVIX/SKEW brake context are never turned into retrievable documents, so macro reasoning relies only on live structured fields with no retrievable narrative memory.
**How:** Optionally synthesize short natural-language macro-regime documents ("As of <date>: yield curve inverted X bps, CPI trend…, regime=risk-off") from FRED + volatility signals and embed them as `doc_type="macro-regime"` with an `acceptance_datetime`, so thematic/macro queries can recall point-in-time macro context. Flag-gate like disclosure embedding; date honestly, never present as a forecast.
**[low / M]**

**Ingestion is manual + free-tier throttled with no coverage-driven prioritization of what the agent actually trades** — `refreshFilingBodies` caps at 1 filing/tick and processes symbols in list order; the scheduler only ingests the watchlist+universe union, so a fresh screener candidate not in anyone's watchlist has zero embedded filings and `retrieveContextDetailed` returns `[]` for exactly the names that most need diligence.
**How:** Add a coverage-driven prioritizer ranking the ingest queue by held position > watchlist > top-N scan candidates > rest, cross-referenced against `getChunkCoverage()`/`ingested_accessions` to skip covered symbols; and add just-in-time async ingest when a scan top-candidate clears the score threshold with zero chunk coverage. Keep it best-effort so a run never blocks on ingestion.
**[medium / M]**

**Corpus-wide hybrid is absent — BM25 IDF is computed only over the ≤50 dense candidate pool** — `hybridRetrievalEnabled()` defaults false, and even on, BM25 IDF is derived from the candidate pool itself, so it can only reorder within the dense top-N; a strong exact-term/accession/ticker match ranked 51st by cosine is never in the pool, and financial queries are full of exact tokens (CUSIP, accession, "Item 1.01").
**How:** Two-tier — (1) flip `HYBRID_RETRIEVAL` on by default (already fail-safe, RRF-fused); (2) adopt a real corpus-wide sparse channel: Pinecone native sparse-dense (a dotproduct index with sparse vectors / SPLADE), or a local SQLite FTS5 index over persisted chunk text queried in parallel and RRF-fused corpus-wide. Requires persisting chunk text (see below). Coordinate the index/metric change with embed-version tagging + reindex.
**[high / L]**

**Near-dup filter is lexical Jaccard, not embedding-space MMR — diversity is measured on shingles, not meaning** — trigram Jaccard catches copy-paste boilerplate but not two semantically-redundant passages worded differently, so the tiny 3–5 chunk budget can still be spent on one fact stated three ways.
**How:** Add an MMR pass (Carbonell & Goldstein 1998) in `rankPool`: `MMR = λ·sim(query,chunk) − (1−λ)·max sim(chunk, selected)`, computed on Pinecone vectors (request `includeValues:true`) or reusing rerank scores for relevance and candidate cosine for redundancy, λ≈0.7. Opt-in, eval-gated, complementary to Jaccard.
**[medium / M]**

**Rerank candidate pool capped at 50 while Voyage rerank supports far more** — `overFetchK` hard-caps the pre-rerank pool at 50, but `rerank-2.5` can rerank hundreds-to-1000 in one call; for a mega-cap with a full 10-K + several 10-Qs + many 8-Ks, the one risk chunk that flips the decision may sit at dense rank 60 and never reach the cross-encoder.
**How:** Make the cap env-tunable and raise it (~100–200) for the rerank path specifically, since the cross-encoder is the precision stage that absorbs a wider, noisier recall pool. Keep Pinecone topK modest for non-rerank paths; validate recall/latency on the golden set. One clamp change.
**[medium / S]**

**Chunk context headers are static templates, not Anthropic-style contextual retrieval prefixes** — the deterministic title/section/date header IS embedded (a smart, cheap approximation) but is metadata boilerplate, not the LLM-generated situating blurb that reduced retrieval-failure rate ~35–49%; ambiguous pronouns/figures in a bare chunk lose their referent.
**How:** For high-value docs (latest 10-K risk factors + MD&A, transcripts), add an optional ingest-time LLM contextualization pass generating a 1–2 sentence situating preamble per chunk (prompt-cache the full doc to make it cheap), prepend before embedding (`embedCleanTextEnabled` already separates embedded vs stored text so display stays clean), pair with contextual BM25. Gate by cost, scope to held-position + watchlist symbols, and version per embed-rev.
**[medium / L]**

**10-K/8-K section metadata is coarse because HTML→text extraction discards heading structure** — `extractFilingText` flattens all block tags to newlines, dropping `<h1–6>`/bold heading markup, so `chunk.ts`'s `isHeading` recognizes only a handful of regexes and most subsections collapse to `section='General'`, making `RetrieveOptions.section` nearly useless.
**How:** In `extractFilingText`, emit ATX markdown for heading elements (map `<h1–6>` and common EDGAR bold-title patterns to `#`/`##` lines) so `isHeading` captures real boundaries and the context_header carries a specific "Section: Item 7A — Quantitative Disclosures." Add fixtures to `rag-chunk.test.ts`; tune heuristics not to over-split.
**[medium / M]**

**No production faithfulness/groundedness gate between retrieval and generation** — a faithfulness eval exists offline and the orchestrator returns real provenance, but nothing at runtime checks that the LLM's claims are supported by the retrieved chunks, so a confident Bull can cite context that doesn't say what it claims and flow unflagged into the Manager's decision.
**How:** Add a lightweight runtime groundedness check on the generated proposal/answer — an NLI/LLM-judge pass verifying each load-bearing claim is entailed by a retrieved chunk (or a cheaper heuristic requiring the cited chunk_id text to support the claim). Surface an ungrounded-claim flag into the proposal audit / approval inbox rather than blocking — advisory, consistent with the overridable philosophy.
**[medium / M]**

**As-of point-in-time filtering is post-fetch only — no server-side range filter, small pools get silently emptied** — `isWithinAsOf` drops future-dated chunks AFTER the Pinecone query, and `acceptance_datetime` is stored as an ISO string Pinecone can't range-filter; a backtest as-of query over-fetches then drops, and if most of the pool is post-date the result collapses to near-empty even though older relevant chunks exist deeper in the corpus — silent look-ahead-adjacent starvation reading as "no relevant filings existed."
**How:** Store a parallel numeric `acceptance_epoch` (ms) at ingest and push `{acceptance_epoch:{$lte:asOfMs}}` into the Pinecone filter; keep the post-fetch guard as defense-in-depth. Makes as-of retrieval correct AND recall-preserving for the backtest/leakage work. Backfill legacy vectors or fall back to post-fetch for undated ones.
**[medium / M]**

**Macro (FRED) has no vintage/ALFRED realtime — revised values leak into point-in-time backtests** — `macro.ts` fetches the latest fully-revised print with no `realtime_start`/`realtime_end`, so any macro value read "as of" a past date returns today's revised number (GDP/CPI get revised for quarters) — a silent look-ahead in macro-conditioned backtests that won't reproduce live.
**How:** Use FRED ALFRED vintages — pass `realtime_start`/`realtime_end` (or `vintage_dates`) keyed to the backtest asOf to get the first-release value known then; persist observations with their vintage in `macro-history.ts` for reproducible replay. Keep latest-print for live runs.
**[medium / M]**

**Amended/superseded filings are never reconciled — stale vectors coexist forever** — `sec-filings.ts` parses only 10-K/10-Q and ignores /A amendments; `ingested_accessions` dedup treats a restated filing as a brand-new accession, so corrected text is upserted alongside the wrong original with no supersede, and retrieval can surface restated numbers (which exist precisely because the first number was wrong).
**How:** Ingest /A amendments, and on ingest of a newer filing for the same (symbol, fiscal period, form family) delete-by-id or mark-superseded the prior accession's vectors (Pinecone supports delete by id/filter). Track fiscal period in `ingested_accessions` to detect restatements.
**[medium / M]**

**Strategy-time retrieval omits asOf and doesn't stratify by doc_type** — `strategy.ts` omits `asOf` (fine live, but the same path can't be reused for PIT replay), and k=3 with no diversity means all three chunks can be 10-K risk-factor paragraphs, starving the model of the 8-K catalyst or transcript that also matched.
**How:** Pass `asOf: new Date().toISOString()` explicitly (consider `VECTOR_ASOF_STRICT` so undated gaps surface in the audit) and add doc_type-stratified or MMR-diversified selection guaranteeing ≥1 of each available doc_type before filling the remainder by score.
**[low / S]**

**Dedup is exact-hash only; no semantic near-duplicate gate at ingest time** — `document_chunks` is keyed on exact SHA-256, so near-identical text (boilerplate risk-factor sections repeated across a 10-K and the next 10-Q, or a syndicated story on multiple wires) hashes differently and gets embedded as many near-dup vectors, inflating Voyage/Pinecone cost and crowding retrieval; the Jaccard dedupe exists only at retrieval time and is opt-in.
**How:** Add a MinHash/SimHash LSH near-dup gate at INGEST (before embedding): cluster candidate chunks, keep the canonical, drop >~0.9 shingle-similar duplicates. Cheaper than re-embedding and permanently de-bloats the index.
**[medium / M]**

**content_hash dedup uses a 64-bit truncated SHA-256 — a silent collision would drop a distinct chunk** — `hashContent` truncates SHA-256 to 16 hex chars (64 bits) and `document_chunks` is keyed on content_hash alone; a collision makes `filterNewDocumentChunks` skip a genuinely-new chunk — a distinct risk-factor passage permanently absent with no log.
**How:** Widen to 128 bits (first 32 hex chars) — negligible storage, removes any realistic collision concern. Changing the width harmlessly re-embeds the current corpus once (`INSERT OR IGNORE` tolerates it).
**[low / S]**

**No embedding-model / representation version tag on vectors** — `cleanMetadata` writes text/userId/scope/doc_type but no `embed_model`/`embed_version`, and `VOYAGE_MODEL` is hardcoded; the `VECTOR_EMBED_CLEAN_TEXT` flip itself "invalidates direct comparability," but nothing records which representation a vector used, so a mixed population can't be detected, filtered, or migrated and the 0.30 cosine floor becomes meaningless across two spaces.
**How:** Stamp `embed_model` (e.g. `voyage-finance-2`) and a small `embed_rev` (bump on any representation change) into `cleanMetadata` for every vector; treat missing as rev 0 (same pattern as scope). Surface per-model counts in the rag-coverage route. Prerequisite for safe model migration / A/B / quantization.
**[medium / S]**

**`document_chunks` stores only a hash — no text, date, or embedding-model tag — blocking local reindex/sparse-index/reconcile** — the row is `(content_hash, symbol, source, chunk_id, created_at)`; any reindex, FTS5 sparse-index build, amended-filing supersede, or Voyage migration requires re-fetching and re-chunking from EDGAR because the corpus isn't reconstructable locally.
**How:** Persist chunk text + `published_at` + `acceptance_datetime` + `embed_model` + Pinecone vector id alongside the hash (all already computed in `storeDocument`). Then FTS5 sparse indexing, model migration, and supersede-by-id become local operations. Unblocks the corpus-wide-hybrid and amended-filing findings cheaply.
**[medium / M]**

**Content-hash dedup for re-embedded summaries is off by default** — `storeContextsDedupEnabled()` gates content-hash dedup behind `VECTOR_STORECONTEXTS_DEDUP` (default OFF), so the 8-K summary and disclosure-rag paths re-embed byte-identical text every daily refresh (the upsert is idempotent by contextId, but the Voyage embed and the Write-Unit are not free); the 10-K/10-Q path is already deduped.
**How:** Flip `VECTOR_STORECONTEXTS_DEDUP` on by default — it only ever skips work when text is byte-identical to an already-indexed hash (pure savings; genuinely-changed text still re-embeds). One-line default flip; the `document_chunks` table already exists and is tested.
**[medium / S]**

**Embedding model choice is frozen at voyage-finance-2 with no eval-gated comparison or quantization for cost** — `VOYAGE_MODEL` is hardcoded at full fp32 1024-dim; Voyage now offers voyage-3-large/3.5 with Matryoshka `output_dimension` and int8/binary quantization, and full precision costs ~4× the Read/Write-Unit footprint of int8 — never measured.
**How:** Use the golden eval harness to benchmark voyage-finance-2 vs voyage-3-large (and int8/512-dim Matryoshka variants) on recall@k/MRR before committing; if quality holds, adopt int8 and/or a smaller dimension to cut Pinecone storage + query Read-Units ~4×. Do this only AFTER embed-version tagging so the two spaces don't mix; the finance model may legitimately remain best.
**[medium / M]**

**Single Pinecone namespace — per-user isolation rides entirely on metadata filters** — everything lives in the default namespace with isolation as a metadata `$or` filter; correctness is fine, but every query scans the whole index space, per-user teardown is a filtered delete over the whole index, and isolation is filter-dependent.
**How:** Adopt Pinecone namespaces — a `shared` operator corpus and per-user `user:<id>` namespaces; queries target the relevant namespace(s) directly (smaller search space → lower latency + Read-Units, clean per-user delete-by-namespace, defense-in-depth isolation). The two-tier query already merges local+user, mapping naturally to `shared` + user namespace. Requires re-homing existing vectors (a migration).
**[low / M]**

**Ingestion is fixed-cadence polling — no event-driven path for material filings** — everything is TTL-gated (filing bodies weekly, congress/insider/8-K on their own TTLs) driven by the 60s scheduler; a market-moving intraday 8-K (guidance cut, M&A) isn't in memory until the next window, though a webhook push pattern (TradingView) already exists.
**How:** Poll the EDGAR full-text/latest-filings RSS (or the `efts` firehose) at short interval for watchlist CIKs and trigger an immediate targeted ingest on new 8-K item 2.02/1.01, mirroring the webhook-driven refresh; keep `politeFetch` pacing and per-CIK dedup. (Same underlying fix as D15's signal-latency item, framed here for RAG memory freshness.)
**[medium / M]**

**Durable memory extraction is regex rule-based, not the intended structured-output LLM extractor** — `salience.ts` itself says the production extractor "would be a cheap structured-output LLM call; this is the deterministic rule-based stand-in," and `store.ingestMessage` uses regex `extractCandidates` matching a handful of hardcoded patterns, so most natural-language user constraints are silently never captured. `salience-llm.ts` exists but isn't the primary path.
**How:** Wire `salience-llm.ts` structured extraction as the primary path (JSON schema: kind/subject/value/hard/confidence) with the regex extractor as offline fallback; keep the existing salience `score()` gate and PII gate. Same write policy, far higher recall of durable intent.
**[medium / M]**

## D. Data providers & connectivity

**Current state.** An unusually mature market-data layer. `CascadingEnrichmentProvider` fans ~15 providers over the candidate set with a first-wins-per-field merge, honest per-field source attribution (`sources`, `EnrichmentSourcedField`, `EMPTY_SOURCED`), `activeSources` tracking so `MarketScan.source` names only providers that actually filled a field, and analyst scores that are *blended* across sources. Freshness-tier ordering seats the Alpaca IEX real-time snapshot first, then delayed sources, then a keyless Yahoo floor. Resilience is strong: a per-(service,keySource) circuit breaker, a provider-level `applyCircuitBreaker`, a nightly tier watchdog that auto-clamps Massive's limiter, consent-scoped caching (private/pool/shared), careful negative-caching for App A and Massive, a real second short-interest source with a disagreement bulletin, per-lane health logging, and a decision-time staleness gate (`maxQuoteAgeSec`/`maxFundamentalsAgeSec`, default off). Breadth is wide: fundamentals across 7+ providers, news/sentiment, 19 FRED series + Cboe VVIX/SKEW, congress/insider/FINRA/8-K, and an App-A cross-app cache. The weaknesses are cost efficiency and cache/staleness granularity: one global 6h TTL for all classes (including the "real-time" snapshot), every provider fetches every field with no field-demand planning or coalescing, several providers skip negative-caching, the cache is process-local, options/IV data is a fragile opt-in tier, and news sentiment is a keyword bag.

**Global 6h TTL is applied to the real-time Alpaca snapshot — intraday prices pin to a stale morning quote** — `AlpacaSnapshotEnrichmentProvider` writes its cache entry with `now + ttlMs()` resolving `NEWS_CACHE_TTL_MS` (6h); it supplies the first-wins price family and is seated first, so within 6h every scan returns the same cached snapshot. Worse, `parseAlpacaSnapshot` never sets `asOf`, so the `maxQuoteAgeSec` gate can't even see the shown price is 6h old.
**How:** Split the single TTL into per-data-class TTLs — quote-family (Alpaca snapshot, Webull) 15–60s, news/sentiment 15–30min, fundamentals 6–24h — giving the snapshot its own `alpacaSnapshotTtlMs()` (~30s) and stamping `asOf` from `latestTrade`/`dailyBar` timestamps so `refreshSideProvenance` and the staleness gate operate on true quote age. Same for any provider filling price/bid/ask/volume. Mitigate call volume with the coalescing/negative-cache items below.
**[high / S]**

**No cross-provider field-demand planning: every provider fetches every field, first-wins discards the duplicates** — outside the App-A short-circuit, all providers run in parallel over all symbols and only then keep the first non-undefined value, so Finnhub's P/E, FMP's P/E, Intrinio's P/E, and Yahoo's `trailingPE` are all fetched though two or three are thrown away; for 30–50 candidates that is 150–350 mostly-redundant paid calls per provider per scan.
**How:** Introduce a two-phase field-demand planner independent of App A — run the free/keyless tier first (Yahoo quoteSummary + Alpaca snapshot, both batched/cheap), compute still-missing fields per symbol, then invoke each paid provider with a per-symbol coverage hint (generalize the existing `EnrichmentContext.coveredFields` mechanism beyond congress) so FMP/Finnhub/Intrinio skip satisfied sub-calls. Exclude analyst from the skip set (the blend wants every vote); keep a fast-path when no keyed tiers exist.
**[high / L]**

**No in-flight request coalescing (single-flight) for concurrent identical fetches** — the enrichment cache is a plain Map checked before fetch with no promise-level dedup, so two concurrent scans over overlapping symbols (dashboard refresh + strategy run, or two users on the shared operator key) each miss and issue their own Finnhub/FMP/Alpaca calls.
**How:** Add a per-(provider,symbol,flagState) `Map<string, Promise<SymbolEnrichment>>` single-flight table: on miss, store the in-flight promise and have concurrent callers await it; delete on settle. Key by the same namespace as the cache (incl. finnhub vs finnhub-norec, consent scope) so a coalesced result isn't written to the wrong scope.
**[medium / M]**

**Several providers skip negative-caching, so no-data symbols are re-fetched every scan** — Finnhub caches only when `!isEmpty`, Alpaca snapshot only `hasData`, Alpaca news only when headlines exist, so a symbol a provider legitimately has nothing for misses the cache every scan and re-issues its full call set (up to 5 Finnhub calls) within the TTL; App A and Massive already do principled negative caching.
**How:** Generalize the negative-cache pattern — on a genuine empty-but-successful result (not transient/circuit error), write an empty `SymbolEnrichment` under a short negative TTL (30–60min). Reuse `isTransientError`/`allRejected` exactly as App A does so outages still retry.
**[medium / S]**

**Enrichment cache is process-local and volatile — every deploy/restart triggers a cold-start provider storm** — `cache`, the Yahoo crumb, macro caches, and history cache are module-level in-memory with a 2000-entry cap, so each restart re-fetches every field for every candidate from cold, and the multi-worktree setup shares nothing between processes.
**How:** Back the slow-moving tiers (fundamentals, macro, short-interest, OHLC) with a SQLite table keyed by (scope, provider, symbol, expiresAt) so cache survives restarts and is shared across processes; keep the hot quote tier in-memory. Also enables a warm-on-boot preload. Keep consent-scope keying identical to the in-memory keys; add a `migrate()` step.
**[medium / M]**

**No options / implied-vol provider beyond the fragile opt-in Robinhood tier — despite a Tradier key already plumbed** — `nearTheMoneyIv`/`putCallRatio` come only from the default-OFF `RobinhoodOptionsEnrichmentProvider`; `TRADIER_API_KEY` is registered and resolved in `history.ts` but used only for daily OHLC, leaving its free per-strike IV/greeks/OI endpoints unused, so there is no IV rank/percentile, term structure, or skew signal.
**How:** Add a `TradierOptionsEnrichmentProvider` (reuse the Tradier key) pulling the near-dated chain and deriving ATM IV, IV rank vs trailing, 25-delta put/call skew, and put/call OI ratio, wired through the full enrichment trap (`SymbolEnrichment`, `EnrichmentSourcedField`, `EMPTY_SOURCED`, `takeScalar`, `applyEnrichment`, `quotesBySymbol`) and fed into `volatilityScore`/`positioningScore`. Cache per-symbol on a long TTL; unit-verify IV units before trusting them next to real numbers. (Complements C's options-flow ingestion.)
**[high / M]**

**News sentiment is a keyword bag except when Alpha Vantage is configured** — `scoreHeadlines()` counts membership in ~20 positive / ~24 negative words through tanh, with no negation handling, no entity/relevance weighting, and no finance model; it is the sentiment source for Finnhub, Alpaca, and FintechStudios headlines.
**How:** Replace/augment the lexicon with a finance-tuned scorer — a local FinBERT/DistilRoBERTa ONNX model over batched headlines, or reuse the in-loop LLM for one batched scoring call per scan (headlines → {−1..1} with ticker relevance), or prefer Finnhub's `/news-sentiment`. Add per-ticker relevance weighting so an index-wide headline doesn't move a single name. Batch and cache under the news TTL; keep the lexicon as offline fallback.
**[medium / M]**

**First-wins picks a value with no cross-provider plausibility/consensus check (only short interest is cross-validated)** — `takeScalar` keeps the first non-undefined value by registration order for price/peRatio/beta/eps, so an early outlier (a bad Finnhub P/E of 3 while Yahoo/FMP agree on ~30) wins silently; only `shortPercentOfFloat` has a disagreement cross-check.
**How:** Extend the disagreement-bulletin pattern to a small set of high-stakes fields (price, peRatio, beta, marketCap): when ≥2 sources are present, compute a median/MAD and prefer the median or flag values beyond N·MAD with an evidence bulletin, reusing `shortInterestDisagreementThresholdPct` as the template. Keep first-wins when only one source has the field so coverage isn't reduced.
**[medium / M]**

**Regime and volatility panic-brake read FRED VIXCLS (prior-close, day-lagged) when a FRED key is present, not live intraday VIX** — `fetchMacroData` fetches VIXCLS from FRED and caches the macro payload 24h; live Yahoo `^VIX` is used only on the no-key/failed-fetch fallback, so with a FRED key the panic brake can run on a VIX value up to 24h stale — exactly wrong for a volatility circuit-breaker.
**How:** Decouple VIX from the 24h FRED cache — always overlay a live `^VIX` (Yahoo chart, already implemented) with a short TTL before regime/brake evaluation, keeping the slow FRED series on 24h. Also make the macro TTL release-aware (shorten around CPI/NFP/FOMC windows). Cache the live VIX ~1–5min and fall back to FRED on failure.
**[medium / S]**

**Per-provider free-tier daily quotas are not proactively budgeted — only reactively circuit-broken after failures** — the tier watchdog covers only Massive and FMP, and only Massive gets auto-clamped; Finnhub, Alpha Vantage (25/day free), Tiingo, TwelveData, and the Intrinio trial have hard caps with no in-process token bucket, so the app blows through them and only the reactive breaker notices after 429/5xx.
**How:** Add an in-process, persisted per-provider token bucket (daily + per-minute) analogous to `reserveMassiveRestCall`, seeded with each provider's documented caps and env-adjustable; when a daily budget is exhausted, skip gracefully to the next tier instead of erroring, and surface remaining budget in the ops snapshot. Default conservative.
**[medium / M]**

**No field-level coverage/fill-rate telemetry — a silently-dark field (the known enrichment trap) goes unnoticed** — `activeSources` reports which providers contributed at least one field and per-cell `sources` names the winner, but nothing measures per-field FILL RATE across the candidate set ("peRatio coverage dropped from 95% to 10% after Yahoo started 401ing"), so a whole field going dark is invisible until a human eyeballs the table.
**How:** Emit a per-scan coverage metric — for each `EnrichmentSourcedField`, the fraction of candidates with a non-undefined value and the provider mix that filled it — surfaced in `ops-snapshot.ts` and alerting when coverage drops below a floor. Cheap from the `merged`/`sources` maps already built; keep it best-effort so a metrics write never breaks a scan.
**[medium / S]**

**Keyless default configuration leans almost entirely on unofficial Yahoo scraping — single point of failure for fundamentals** — with no keys, Yahoo is the sole source of sector/industry/PE/EPS/beta/52w-range/short-float/institutional-ownership/earnings-date via crumb+cookie auth against an IP-rate-limited, ToS-gray endpoint; the only keyless redundancy is SEC-XBRL (debtToEquity only).
**How:** Add a keyless fundamentals-redundancy tier so Yahoo isn't a SPOF — expand `SecXbrlEnrichmentProvider` to EPS/revenue/shares/debt-equity (derive P/E with a price); add Stooq (keyless) for quotes/closes; consider StockAnalysis/Nasdaq public JSON for sector/industry. Register below the keyed tiers but above Yahoo so an outage degrades gracefully rather than to `-`. Keep TTM/earnings-date on faster tiers; SEC is lagged.
**[medium / M]**

**Per-symbol N+1 fan-out to Finnhub/FMP/Intrinio instead of bulk endpoints** — Finnhub (5 calls), FMP (4–5), and Intrinio (7) are all issued per symbol in CONCURRENCY=5 chunks, while Alpaca snapshot batches 100/call and Alpaca news batches all symbols — the paid fundamentals providers don't, despite some offering bulk endpoints.
**How:** Use bulk endpoints where they exist (FMP batch quote/bulk ratios, Tiingo/TwelveData batch quotes), collapsing per-symbol P/E and quote calls into one request per scan; for providers without batch (Finnhub), combine with the field-demand planner. Detect availability via `provider-tier.ts` and fall back to per-symbol when a bulk call 403s.
**[medium / M]**

**Alpaca real-time tier uses the free IEX feed only, with no SIP fallback for thin names, yet wins price first-wins unconditionally** — `alpacaDataFeed()` defaults to IEX (~2–3% of consolidated volume; SIP 403s without a paid sub), so for less-liquid candidates the IEX NBBO/last-trade can be thin, wide, or stale — and the cascade seats Alpaca first, so a stale/thin IEX print wins over a fresher Yahoo consolidated quote.
**How:** Gate the Alpaca-first win by snapshot freshness/liquidity — if the snapshot's `latestTrade`/quote timestamp is older than a threshold or the symbol is low-IEX-liquidity, fall through to the next quote tier instead of pinning the stale IEX value. Requires stamping `asOf` on the snapshot (see the TTL finding). Ensure it doesn't demote a genuinely-fresh IEX quote on liquid names.
**[medium / M]**

**SEC insider (Form 4) and 8-K ingestion is fixed-cadence polling, not event-driven** — `web-sources/index.ts` refreshes congress/insider/finra/8-K on cadence TTLs; only congress has an SSE push path, so Form 4 clusters and 8-K material events (the most time-sensitive smart-money/material signals) are picked up whenever the polling cadence elapses.
**How:** Move insider/8-K to near-real-time via EDGAR's filing feeds — poll the latest-filings Atom/RSS or submissions API on a tight cadence for the watched universe and trigger incremental ingest on new accession numbers, rather than a full periodic re-scrape. Keep the rate-limited `politeFetch` (~10 req/s) and in-flight dedup. (Same fix as C25, framed for signal latency.)
**[medium / M]**

**Short-interest values carry no settlement-date age, so a bi-weekly FINRA figure can look current** — `shortPercentOfFloat` (Yahoo) and the Massive FINRA secondary are compared for disagreement, but neither the settlement date nor the value's age is surfaced; FINRA short interest is a bi-weekly settlement figure that can be ~2–3 weeks stale yet is treated as a current scalar in `positioningScore` and the squeeze bulletin.
**How:** Carry the settlement/report date alongside `shortPercentOfFloat` (Massive returns `settlement_date`; Yahoo has `dateShortInterest`), annotate the value's age in the evidence bulletin, and optionally down-weight the squeeze contribution when the figure is beyond one settlement cycle old. Purely additive metadata plus an optional weighting tweak.
**[low / S]**

**Intraday minute bars are streamed for triggers but not folded into scan-time momentum** — the Alpaca price-events stream subscribes to minute bars for active users' symbols, but `momentumScore` blends only intraday %change, 52-week position, and a daily-OHLC technical score — the freshest microstructure signal already ingested doesn't reach ranking.
**How:** Cache the latest streamed minute bars per symbol (like `getStreamedHeadlines` does for news) and derive a lightweight intraday-momentum feature (price vs session VWAP — already have `vwap` — plus short-window bar slope) feeding `momentumScore`, de-collinearized against `technicalScore` the same way the 52w weight already is. Guard for missing bars; meaningful only during RTH for streamed symbols.
**[low / M]**

## E. Decision-making in complex / atypical / unforeseen market conditions

**Current state.** An unusually mature, honest risk stack for a solo project. Verified strengths: a deterministic regime label (`determineMarketRegime` — VIX + curve inversion, 5 stable labels feeding thesis×regime learning); a default-ON volatility panic brake (VIX≥40 / VVIX≥150 / SKEW≥160 → close_only) reading real Cboe SKEW/VVIX; an account circuit breaker (trailing drawdown + daily-loss, hard-halt default, overridable); a broad gate set (per-order/daily/hourly notional, per-symbol %/notional, sector, gross/net 80%, opt-in `maxPortfolioBeta`, ADV market-impact cap, entry-drift + staleness gates, wash-sale modes); an opt-in correlation-cluster gate (90d Pearson); Kelly-lite sizing with Bayesian-shrunk realized edge, conviction caps on uncorroborated theses, and isotonic confidence calibration; volatility-aware stops (fixed/beta/ATR), broker OCO brackets, laddered take-profit trims, and proactive stop exits; a deterministic bear filter plus an LLM Bull→Bear debate fed rich macro context. Weaknesses concentrate in complex/atypical conditions: the regime engine ignores credit spreads / term structure / breadth it already fetches; sizing has no volatility-targeting or true fractional Kelly; there is no portfolio risk-heat budget, no graduated de-risking between normal and VIX-40 panic, no tail-hedging, no factor-exposure aggregation, no event/earnings blackout, and no joint portfolio construction — and several gates are brittle substring matches on regime strings.

**Regime classifier ignores credit spreads, VIX term structure, and breadth it already ingests** — `determineMarketRegime` keys only off VIX level + 10y-vs-fedfunds inversion; `hyCreditSpread`, `vixTermStructure` (VIX/VIX3M), `curve2s10s`, and full-universe breadth are all fetched and shown to the LLM but never enter the deterministic label that conditions the crisis cap, the bear filter, and the learning buckets.
**How:** Replace the VIX-only classifier with a multi-signal regime scorer — combine z-scored VIX level, term-structure backwardation (VIX/VIX3M>1), HY OAS level+1w change, `curve2s10s`, and breadth into a monotone risk-off severity in [0,1], bucketed to labels with hysteresis (cross a band for N ticks before flipping). Emit both a stable label AND a numeric severity so downstream gates read severity, not substrings. Backtest thresholds on historical macro; keep the old label as a fallback when feeds are unavailable.
**[high / M]**

**No volatility-targeting in position sizing — a name's own vol never shrinks its size** — `applyDeterministicSizing` sizes via `winRate × conviction × edgeFactor` bounded by notional caps; realized volatility affects only stop distance, never dollar size, so a 60%-vol biotech and a 15%-vol utility with equal conviction get the same notional and unequal risk contribution that doesn't auto-shrink when vol rises.
**How:** Add inverse-vol / target-volatility sizing — scale target notional by `clamp(targetDailyVol / realizedDailyVol, loFloor, hiCap)` where `realizedDailyVol` comes from the ATR%/EWMA-σ already computed, composed as another factor in the bounded-multiplier chain so caps still bind. Because realized vol rises in stress, this auto-de-sizes the whole book before any brake trips. Fall back to a beta×VIX proxy when bars are thin so a data gap can't zero or explode size.
**[high / M]**

**No portfolio "heat" / total-open-risk budget across positions** — every stop is per-position but the SUM of risk-to-stop across the book — Σ(notional × stopDistancePct) — is never bounded; gross/net/beta caps bound market value, not loss-if-stops-hit, so in a correlated gap-down every stop fires together and realized loss can far exceed any single cap.
**How:** Add a portfolio-heat control — compute open risk = Σ(|marketValue| × effectiveStopPct) plus the candidate's risk-to-stop, and block/downsize opening orders once total heat exceeds a policy cap (`maxPortfolioHeatPct`, default ~6% of equity). This is the standard van-Tharp/CTA total-open-risk budget and the portfolio-level companion to the per-name stop. Wire it into `openingRiskCapacity` using the same `effectiveStopPct` resolver the exit generator uses.
**[high / M]**

**Tail defense is binary and late — nothing between "normal" and VIX-40 panic** — the only automatic de-risking between calm and crisis is the VIX≥40/VVIX≥150/SKEW≥160 brake that hard-flips to close_only; `crisisMaxOpeningExposurePct` exists but is a blunt per-order cap defaulting OFF, so at VIX 25–39 with credit spreads blowing out the system behaves normally except for advisory prose.
**How:** Make de-risking continuous — derive a target gross/net-exposure ceiling as a smooth function of the regime severity score (`targetGross = maxGross × (1 − k·severity)`) fed into the opening caps, so exposure ratchets down as VVIX/SKEW/HY-OAS/term-structure deteriorate well before the kill switch. Keep the hard brake as the floor. Expose slope `k` as an overridable owner preference, defaulted modestly to avoid whipsaw on VIX head-fakes.
**[high / M]**

**Kelly-lite is an ad-hoc step function, not fractional Kelly on realized payoff** — `edgeFactor` is a coarse 4-step ramp on `avgReturn` multiplied by `winRate × conviction`; it never uses the win/loss PAYOFF ratio, so a 55%-hit thesis with 3:1 winners is sized like one with 1:1 winners.
**How:** Compute proper fractional Kelly from the realized scorecard you already keep per thesis×regime — `f* = (W·b − (1−W))/b` using shrunk win rate W and realized avg-win/avg-loss ratio b — then apply a conservative ¼–½ Kelly and the existing Bayesian shrinkage, clamped to the current floor/ceiling. Track avgWin/avgLoss (not just avgReturn) to feed b. Keep the unproven-thesis floor and ¼-Kelly cap so a lucky streak can't oversize.
**[medium / M]**

**VIX term-structure backwardation is shown to the LLM but is not a deterministic de-risk trigger** — `vixTermStructure = VIX/VIX3M` is the earliest fast-crash signal (backwardation >1 precedes VIX-level spikes), but `evaluateVolatilityBrake` reads only VIX level, VVIX, SKEW, so backwardation never trips a brake or de-risk.
**How:** Add `vixTermStructure` (and optionally 1-week HY-OAS change) as brake/taper inputs — trip a soft de-risk when VIX/VIX3M ≥ ~1.0–1.05 for consecutive reads even if VIX level is sub-30. Cheap, uses data already fetched, catches the Feb-2018 / Mar-2020 onsets the level threshold misses by days. Require persistence (2+ reads) to avoid chatter.
**[medium / S]**

**Correlation-cluster gate is full-sample 90d Pearson — blind to crisis correlation breakdown** — `avgReturnCorrelation` uses equal-weighted Pearson over ~90 days, unconditional and symmetric, but in stress cross-asset correlations converge toward 1 and downside correlation exceeds full-sample; the gate also refetches ~5y bars per holding per candidate each run and is default OFF.
**How:** Move to an EWMA (or short recent-window) correlation tracking the current regime, and gate on DOWNSIDE/semi-correlation (correlation of negative-return days) or downside beta rather than symmetric Pearson — that is the correlation that hurts. Consider a lightweight DCC-style decay; cache the candidate↔holding return series across the run; ship default-on with a sane cap. Blend EWMA with a longer prior; keep `MIN_CORRELATION_SAMPLES`.
**[medium / M]**

**Only single-factor (market beta) risk is aggregated — Fama-French factor crowding is invisible** — `maxPortfolioBeta` bounds market beta only; SMB/HML/MOM factor returns ARE fetched and shown to the LLM but the portfolio's aggregate factor EXPOSURES are never estimated or capped, so a book of momentum names carries huge hidden momentum-factor risk (a momentum crash hits them all at once) the beta cap can't see.
**How:** Estimate each holding's factor loadings (regress daily returns on Mkt/SMB/HML/MOM using the bar cascade) or approximate with proxies (pctFromHigh → momentum tilt, pb → value tilt), aggregate signed factor exposure across the book, and add optional caps + a momentum-crowding warning when net MOM exposure is extreme. At minimum, penalize sizing when the whole batch tilts one factor. Degrade to proxy tilts when bars are thin so it never false-blocks.
**[medium / L]**

**No event-risk awareness — earnings/FOMC/CPI blackout is entirely unmanaged** — `market-calendar.ts` covers only NYSE holidays; there is no `daysToEarnings` gate and no macro-event posture change, so the system will open a full-size non-catalyst buy the afternoon before a binary earnings print — preventable, uncompensated gap risk.
**How:** Add an earnings-proximity gate — fetch next-earnings date (Finnhub/Robinhood calendars are integrated) and block or hard-downsize OPENING buys within N days of earnings UNLESS `tradeThesisTag` is Earnings-Catalyst (owner-overridable); add a macro-event calendar (FOMC/CPI/NFP) that nudges regime severity / trims new-entry size on event days; surface `daysToEarnings` in the scan. Skip the gate when the date is unknown so it can't false-block.
**[medium / M]**

**Proposals are gated sequentially — no joint portfolio construction over the batch** — each proposal runs the policy gate independently and consumes shared capacity first-come-first-served; nothing looks at the whole surviving batch to diversify, net offsetting names, or allocate the risk budget, so two highly-correlated buys can both pass because neither individually breaches a cap.
**How:** Insert a lightweight "portfolio manager" construction pass after the bear filter and before per-order gating — cluster surviving candidates by correlation/sector/factor, keep the best-ranked representative per cluster (or split the risk budget), and allocate sizes to respect the portfolio-heat and exposure budgets jointly (a greedy risk-parity / max-diversification allocation is enough — full mean-variance is overkill). This is the true "Manager" step the framing implies. Keep it deterministic and cap the candidate count so latency stays bounded.
**[medium / L]**

**Multi-model is failover-only — model disagreement isn't used as an epistemic-uncertainty signal** — the Bull step uses multiple models purely as sequential failover; on a novel/ambiguous setup there is no measure of reasoning uncertainty beyond the LLM's self-reported `confidenceScore`, which the calibration layer already distrusts.
**How:** For high-conviction or high-notional candidates, sample the Bull twice (two models or two temperatures) and derive an agreement score per name — shrink size toward the floor when they disagree on side/thesis/size, let strong agreement lift within caps. Cheap ensemble disagreement is a proxy for epistemic uncertainty, the right dial for unfamiliar setups. Scope to high-notional/high-conviction to respect the LLM budget. (Converges with A6/G2.)
**[medium / M]**

**No pre-trade stress test / scenario P&L for tail scenarios** — nothing estimates what the current + proposed book would lose under a defined shock (−10% SPX, +20 VIX, HY-OAS +150bp); the human approver and the gates see notional caps, not a tail-loss number.
**How:** Add a cheap scenario engine — portfolio ΔP&L ≈ Σ(marketValue × beta × equityShock) + sector-shock terms + a vol-shock haircut on high-beta names, computed from beta/sector already on positions — surface the estimated shock loss on the approval card and optionally gate when projected shock loss exceeds a policy fraction of equity. Extend to a couple of named historical scenarios (2020 crash, 2022 rate shock). Label it an estimate; the linear beta approximation understates convexity.
**[medium / M]**

**No changepoint guard on the account's own edge — nothing throttles when the strategy stops working** — `regime-watch.ts` tracks the MACRO label flip and merely announces it; nothing monitors the account's OWN rolling hit-rate/IC/drawdown velocity to detect that the edge decayed — the most dangerous unforeseen condition is one where your own model silently stops predicting.
**How:** Add an online changepoint detector (CUSUM or Page-Hinkley) on rolling realized win-rate and per-run composite IC (`backtest.ts` already computes IC); on a downward changepoint, automatically raise the conviction/red-team threshold and shrink the sizing ceiling until performance recovers — a self-throttle distinct from macro regime. Persist detector state in the internal KV like the drawdown HWM. Gate on minimum sample and shrink rather than hard-stop. (Converges with A10.)
**[medium / M]**

**Regime gates couple to label STRINGS via brittle substring/prefix matching across modules** — `isCrisisOrInvertedRegime` does substring `'crisis'/'inverted'`, `deterministicBearFilter` does `startsWith('Crisis')/startsWith('Risk-Off')`, `isEscalationRegime` does yet another set, so "Cautious (Inverted Curve)" matches the crisis cap but NOT the bear filter — the same regime is treated differently by different gates, and any relabel silently breaks a gate with no type error.
**How:** Make regime a typed value — a discriminated enum plus the numeric severity from the regime-scorer finding, produced once by `determineMarketRegime` and consumed everywhere; replace every substring/`startsWith` check with severity thresholds or enum membership. Add a unit test asserting each label maps to the intended {crisisCap, bearRiskOff, escalation} behaviors so a future relabel can't desync them. Keep the string label for display only.
**[medium / S]**

**Regime-conditioned learning buckets are too sparse to activate** — `selectThesisStat` uses the thesis×regime bucket only at ≥5 trades; with ~10 theses × ~6 regime labels = 60 buckets (plus collapse to "Unknown" without a FRED key), the conditional record almost never reaches 5, so sizing/skip decisions fall back to the coarse thesis-only bucket and regime conditioning rarely fires.
**How:** Use hierarchical/partial-pooling shrinkage instead of a hard 5-trade cutoff — shrink the thesis×regime estimate toward the thesis-level prior (and that toward the global prior) with weight ∝ bucket sample size (empirical-Bayes). Also decouple the LEARNING regime key from the display label: bucket on a 3-way {risk-on, neutral, risk-off} severity band so cells fill ~2× faster while the UI keeps the richer label. Reuse the existing `shrinkPrior` machinery.
**[medium / M]**

**Account circuit breaker and crisis cap are opt-in and default null — the strongest tail brakes are off out of the box** — `DEFAULT_RISK_RULES` sets no `maxDrawdownPct`/`maxDailyLossNotional` and `DEFAULT_POLICY` sets no `crisisMaxOpeningExposurePct`/`maxPortfolioBeta`/`maxAvgCorrelation`, so on a fresh account the account-level drawdown breaker never arms until configured, even though the code and hard-halt default action are built.
**How:** Ship sensible, clearly-overridable defaults for the account-level brakes (e.g. `maxDrawdownPct` ~20, `maxDailyLossNotional` as a % of starting equity, `crisisMaxOpeningExposurePct` ~5). This is a coverage fix, not paternalism — the breaker is already an overridable preference with a hard-halt default; a null default just means the protection silently never runs. Pick defaults loose enough not to nuisance-halt a volatile-but-fine account.
**[medium / S]**

**Stops assume fills at trigger — overnight/halt gap risk is unmodeled and unsized** — synthetic stops fire market exits on a 60s tick and broker brackets are stop-market; both fill far below trigger after an overnight gap or halt-reopen, and nothing sizes down gap-prone names or offers hedge protection (the >10% bad-tick filter protects against spurious prints, not real gaps).
**How:** Treat gap risk explicitly — (a) size down names with high recent gap frequency or pending earnings, (b) prefer stop-LIMIT with a defined slippage band where the owner accepts non-fill risk, (c) expose an estimated worst-case gap loss on the approval card; and for genuine tail protection allow a small net-exposure reduction as a hedge action when the brake trips. Keep stop-market as the default for exit certainty (an owner choice).
**[medium / M]**

**The vol brake and close_only only STOP new entries — no active hedging or net-exposure reduction** — when the brake or drawdown breaker fires the system flips to close_only/halted: it stops opening risk and relies on resting stops, with no capacity to actively de-risk the EXISTING book (buy protection, reduce net exposure, rotate to defensives).
**How:** Add an optional, owner-enabled "defensive action on brake" beyond blocking entries — auto-propose trimming the highest-beta/most-correlated positions to a target net-beta, or (if the broker supports it) a small index-put or inverse-ETF hedge sized to residual net exposure. Even a deterministic "reduce net beta toward X on severity ≥ threshold" proposal set converts the brake from passive to protective. Keep it opt-in; start with the net-beta trim before any derivatives.
**[medium / L]**

**Sizing edge factor and conviction corroboration ignore the DISTRIBUTION of outcomes (skew/tail of the thesis)** — corroboration uses shrunk win-rate and mean edge only, so a thesis with a good average but a fat left tail (occasional −40% lots) is sized identically to a steady one with the same mean — the sizer is blind to downside skew, which is what blows up in atypical conditions.
**How:** Track and use per-thesis outcome dispersion — realized return volatility and downside deviation (or a simple Sortino/worst-decile) alongside avgReturn — and penalize size for high-dispersion / negatively-skewed theses (a risk-adjusted edge = mean/σ_down rather than raw mean). Pairs naturally with fractional Kelly. Shrink toward the thesis mean when thin so a couple of losers don't over-penalize.
**[low / M]**

## F. User interface (intuitive, powerful, professional)

**Current state.** The `/console` is a genuinely strong, explainability-first UI with a coherent scoped design system (`console.css` semantic tokens, light/dark kept in sync, WCAG-AA-targeted colors, a word-first money-reality banner + LIVE viewport frame). Decision support is a real differentiator: the approval card is a decision receipt with green/red-team model attribution (persisted `proposedByModel` via ModelBadge), confidence, thesis tag, entry regime, policy-gate reasons, wash-sale annotation, since-proposed counterfactual, and an honest three-outcomes block with expiry; the symbol drilldown carries per-field data provenance, factor-breakdown bars, analyst distribution/price-target range bars, and honest `—` for missing data; Activity gives real run forensics; Results/Macro are careful about buckets/estimates. But the console is behind its own capabilities in several pro dimensions: it polls the entire `/api/dashboard` snapshot every 15s and does NOT consume the SSE stream the legacy dashboard and mobile PWA already use; it ships a bare hand-rolled SVG chart while `lightweight-charts` is a wired dependency; there are no keyboard shortcuts or command palette; nearly all explainability is locked in native `title` tooltips (invisible on touch/keyboard); the scan table is unvirtualized with no column control/filter/heatmap/export; there is no risk-utilization surface; and three design languages coexist (console tokens, legacy `app/ui`, and the Tailwind mobile PWA).

**The pro console polls a full snapshot every 15s; wire it to the SSE stream it already ships** — `useConsoleData` refetches the ENTIRE `/api/dashboard` object on a 15s interval and never opens an EventSource, yet `/api/events/stream` and the Alpaca price/trade streams already power `dashboard-client.tsx` and the mobile PWA, so prices, positions, day-P&L, the approvals badge, and breaker state on the flagship desk lag up to 15s behind the phone (a breaker trip or fill is invisible for up to 15s — a UX and a risk gap).
**How:** Add an EventSource in `ConsoleDataProvider` subscribing to `/api/events/stream`; on `dashboard.proposal/order/run-complete/market-data/dirty` events call `refresh()` (debounced ~500ms) like the mobile client, keeping the 15s poll as a heartbeat fallback. Step-change: split the payload so price/quote ticks patch a lightweight client cache (per-symbol last price, marks, day-P&L) in place instead of refetching the whole snapshot, and add a live/reconnecting indicator in `FreshnessStrip` driven by `EventSource.readyState`. Debounce reconnects and reconcile on every full snapshot.
**[high / M]**

**Adopt lightweight-charts in the console drilldown — it already powers the legacy chart** — the drilldown renders a single close-price SVG polyline with no candles, volume, MAs, VWAP, crosshair, hover readout, or intraday, while `app/ui/price-chart.tsx` already does all of that with TradingView `lightweight-charts` (a current dependency) — so the flagship UI has a strictly worse chart than the code it replaced.
**How:** Port `PriceChart` into the console themed from `con-*` tokens (map `cssVar('--con-pos'/'--con-neg'/'--con-accent'/'--con-line')`), dynamically imported so it stays out of the main bundle, rendered in `SymbolDrilldownSheet` in place of `PriceHistoryChart`. Overlay the proposal's entry/stop/take-profit as priceLines when opened from an approval and mark average cost; keep the honest "<2 bars = a sentence" fallback. Add 30-bar sparklines to scan symbol cells and positions rows. Re-read cssVars on `data-theme` change so canvas theming reacts to the light/dark toggle.
**[high / M]**

**No keyboard-first ergonomics or command palette in the console** — the only keyboard handler is Esc-to-close; there is no Cmd/Ctrl-K palette (one exists but only in legacy), no j/k list navigation, no approve/reject hotkeys, no destination jumps, no `/` to focus search — a pro desk is driven from the keyboard.
**How:** Add a console `CommandPalette` (reuse the legacy one or add cmdk/kbar) on Cmd/Ctrl-K exposing every nav destination, Run once, STOP, account-scope switch, theme, and "open symbol …". Add a global keymap (react-hotkeys-hook): j/k to move a selection cursor through Approvals cards and scan rows, a/r to approve/reject the focused proposal (a on a LIVE card opens the typed-confirm sheet, never auto-fires), enter to open the drilldown, g-then-{h,a,s,m,o} to jump, ? for a shortcuts sheet. Suppress hotkeys inside inputs and while a typed-confirm sheet is open; never bind a single key to a real-money side effect.
**[high / M]**

**Explainability is trapped in native `title` tooltips — invisible on touch and keyboard** — the console's provenance, methodology, and "what this means" text is overwhelmingly delivered via the native `title` attribute (per-cell provenance, drilldown tile/row hints, macro tiles, guardrail hints, factor bars), which does not appear on touch at all, doesn't show on keyboard focus, has a ~1s delay, can't be styled, and truncates — so a large fraction of the app's core differentiator is simply unreachable on mobile and for keyboard/AT users.
**How:** Introduce one accessible tooltip/popover primitive on `@floating-ui/react` (or Radix Tooltip+Popover) with hover + focus + long-press/tap triggers, `aria-describedby` wiring, and token styling; replace the `title=…` convention across `primitives.tsx`, `columns.tsx`, `drilldown-sections.tsx`, and macro tiles. Promote dense provenance to a tap-to-open popover with real markup instead of `\n`-joined strings; keep `title` as a copyable fallback only. Do it as a primitive swap so behavior stays uniform; popovers must not trap scroll on mobile.
**[high / M]**

**No live risk-utilization board — the caps exist but their current usage is invisible** — guardrails define per-symbol, gross, net, beta, correlation, short, and hourly caps and the breaker/panic-brake thresholds, but the only cap-usage visualization anywhere is the daily-spend Meter; a trader can't see "gross 62% of cap, net +18% of ±40, beta 0.9 of 1.2, largest position 7% of 10%, drawdown 4% of 8% breaker" at a glance.
**How:** Add a Risk panel on Home (and a compact strip in chrome) mirroring the spend Meter for every active cap — compute current gross/net exposure, portfolio beta, avg correlation, and largest-position % server-side (the same math `policy.ts` already runs) and surface it in the snapshot as a `riskUtilization` block so the client doesn't re-derive; render each as a `con-meter` (warn≥75%/neg≥95%) and show breaker distance as gauges, each deep-linking to the relevant Guardrails field. Compute server-side and pass through so beta/correlation don't drift from the gate; match short/cover sign handling to `policy.ts` exactly.
**[high / M]**

**Approvals is a scroll of cards — no triage, bulk actions, sort/filter, or portfolio preview** — `approvals/page.tsx` maps pending proposals to full cards with no keyboard selection, no bulk approve/reject, no sort/filter (confidence, notional, thesis, live/paper, since-proposed drift), and no header summary, so when several proposals arrive the operator can't see aggregate pending notional, the net-exposure/beta delta if all were approved, or triage the strongest first.
**How:** Add a triage header (total pending count, summed est. notional, "if you approve all: gross → X%, net → Y%, +N bps beta" from the same `riskUtilization` block); a sort/filter bar; keyboard j/k selection with a/r (paper inline optimistic; LIVE routes to the existing typed-confirm sheet); and multi-select with "Approve selected (paper only)" plus an explicit "these N are LIVE — confirm each" guard so bulk never bypasses the per-ticket LIVE ritual. Keep the receipt as the expanded view. Hard-gate LIVE to per-ticket typed confirmation (never batch the phrase).
**[high / M]**

**The approval card doesn't surface the AI decision's full provenance (failover/truncation, sizing rationale, evidence citations, red-team transcript)** — the card shows model badge, confidence, thesis/regime, red-team reason, and gate reasons (strong) but the backend holds more that never reaches it: multi-model failover/truncation is persisted yet the card never says "model B produced this after A was truncated"; there is no "why this size" derivation; the RAG/evidence and 10-K/8-K citations that fed the thesis aren't shown; the red-team output is one sentence with no expandable debate; and confidence is a bare "82/100" with no calibration context.
**How:** Extend the card with (1) a model-provenance line when failover/truncation occurred, off the persisted run metadata; (2) a "Sizing" disclosure showing the binding constraint ("capped by max-per-order 5% of NAV" vs "confidence-scaled") from the policy dry-run; (3) an inline Evidence disclosure reusing `EvidenceSection` so filing/congress/insider bulletins and headlines are one tap away; (4) an expandable red-team block; (5) a per-model calibration chip ("this model: 61% win over 34 closed trades at this confidence band"). Keep it honest (`—` when unrecorded); reuse the <5-trade opacity convention so thin calibration isn't fabricated.
**[high / L]**

**Alerting is minimal — no browser notifications, sound, or a persistent alert center** — there is no Notification API, Web Audio, or `navigator.vibrate` anywhere in `app/`; in-console signals are only the nav badge and ephemeral toasts, and price alerts exist only on the mobile PWA as crossings, so a new LIVE proposal, a breaker trip, or a fill produces no push, sound, or desktop notification for a user on another tab.
**How:** Add an AlertCenter — (1) request Notification permission (once, opt-in) and fire a desktop Notification on new pending proposal, breaker/panic-brake trip, fill, and drawdown crossing, sourced from SSE; (2) an optional Web Audio ping for LIVE proposals/breakers with a mute toggle; (3) a persistent, filterable in-console alert inbox (promote the existing `AlertsList` feed to a bell popover with unread state); (4) generalize alert rules beyond price to proposal/breaker/fill/exposure thresholds, and add the Push API for background delivery via the existing service worker. Gate to high-severity by default with per-type toggles; Web Audio needs a user-gesture unlock; permission prompts must be user-initiated.
**[high / M]**

**Brackets are shown as numbers, not as risk:reward geometry** — the three-outcomes block prints "stop $X · take-profit $Y" as text with no visual of entry vs stop vs target vs current price, so the R:R ratio and how far price already drifted from entry aren't visible at a glance, even though `performanceSinceProposalPct` and `proposalReferencePrice`/`CurrentPrice` are on the object.
**How:** Add a compact horizontal price-scale bar (reuse the `con-range-bar` pattern from the analyst-target section): plot stop | entry | current | target on one axis, shade loss/profit zones, and label the computed R:R ((target−entry)/(entry−stop)) and the % already moved; when the drilldown adopts lightweight-charts, draw the same three as priceLines. Handle missing stop/target and short-side geometry (loss zone above entry for shorts) by keying off `side` like `SIDE_TONE`.
**[medium / S]**

**No operator-density mode or multi-pane layout — Home is a single novice-friendly column** — the console leans to a novice register (generous padding, one vertical column, fixed 1400px max-width, no density toggle); `react-resizable-panels` is a dependency used nowhere, and a pro wants a dense, rearrangeable, persisted multi-column cockpit.
**How:** Add a density toggle (`data-density=compact` on `.console-root` scaling the `con-fs-*` type ramp and padding via CSS vars — already centralized). For power users, offer an optional multi-pane "Desk" layout using `react-resizable-panels` with saved sizes and a widget catalog (positions, scan, approvals, macro strip, risk meters, blotter), persisted per user, keeping the single-column "Focus" layout as default. Ship the density toggle first (S) and panels as a later opt-in; don't let compact mode drop below AA hit-target sizes on touch.
**[medium / L]**

**Modal Sheet lacks focus trap, focus restoration, and aria-labelledby** — `ui/sheet.tsx` sets `role=dialog aria-modal=true` and Esc-to-close but doesn't move focus into the sheet, trap Tab, restore focus to the trigger on close, mark the background inert, or link its title via `aria-labelledby`; every drilldown, scope switch, run-state control, and LIVE typed-confirm rides on this Sheet, so keyboard/SR users can tab out of an open real-money confirmation into the page behind it.
**How:** Wrap Sheet content in a focus trap (focus-trap-react, or migrate to Radix Dialog for trap + restore + inert + labelledby + scroll-lock free), auto-focus the first interactive element (for the LIVE sheet, the typed-phrase input), restore focus to the opener on close, add `aria-labelledby` to the header h2, and set `aria-hidden`/`inert` on the app root while open. Add `prefers-reduced-motion` guards to the sheet/scrim transitions.
**[medium / S]**

**Perceived performance: whole-snapshot polling, no skeletons, no optimistic approve/reject** — the 15s poll refetches the entire `DashboardSnapshot` with no ETag/If-None-Match, first paint shows a single full-screen "Loading account data…" rather than per-card skeletons, and approve/reject awaits a full refresh before the card leaves (no optimistic removal).
**How:** Add conditional-GET support to `/api/dashboard` (ETag/Last-Modified; 304 when unchanged) or move to SSE-driven invalidation so idle polls are cheap; render per-card skeleton placeholders (a `con-skeleton` shimmer) instead of a blank shell; make approve/reject optimistic (remove the card immediately, undo toast for reject, reconcile/rollback on server response, LIVE still routes through the typed sheet); and cache `/api/history` in the drilldown via a small in-memory map keyed by symbol+timeframe. Optimistic UI must roll back cleanly when a blocked-at-approval result restores the card with reasons.
**[medium / M]**

**No global symbol omnibox — you can only reach a drilldown by clicking a table row** — `SymbolButton`/`SymbolDrilldownSheet` is excellent but only reachable from cells that already render a symbol, and the drilldown degrades to "not in the last scan" for anything off the candidate list, so there is no way to type a ticker anywhere and pull up its chart/fundamentals/exposure.
**How:** Add a persistent quote omnibox in chrome (or fold it into the Cmd-K palette) — type a ticker → open `SymbolDrilldownSheet` for any symbol, fetching `/api/scan?symbols=TICKER` (or a single-symbol quote endpoint) on demand so fundamentals/factors populate even for non-candidates. Autocomplete from the universe + watchlist + positions; show the same honest loading/degraded states already built into the sheet.
**[medium / S]**

**Charts are daily-only — no intraday for entries near earnings/events** — both the console SVG chart and legacy price-chart use `/api/history` daily bars with no 1m/5m view, so the operator can't see today's session shape, intraday VWAP, or the gap when approving a same-day entry, even though the drilldown flags "earnings in Nd" and the strategy trades an intraday tape.
**How:** Add an intraday timeframe (1D/5D at 1–5m) to the drilldown chart backed by an intraday history endpoint (Alpaca/Massive bars already ingested), plot intraday VWAP and prior close as reference lines, and default to intraday when the market is open and daily when closed, reusing the lightweight-charts instance. Cache aggressively and fall back to daily with an honest note when unavailable.
**[medium / M]**

**Three divergent design languages; the mobile PWA also under-guards LIVE approval vs the console** — `mobile-pwa-client.tsx` is a separate Tailwind-utility design unrelated to console tokens and legacy `app/ui` (a third system to maintain), and functionally its LIVE approve button is always enabled even with an empty confirmation phrase (it posts and lets the server 4xx) whereas the console disables the action until `typed === 'APPROVE LIVE <SYM>'`.
**How:** Either retheme the mobile PWA onto the console token system, or better, make `/console` the installable PWA and retire `app/mobile` (the console already has a mobile layout with a bottom tab bar). At minimum, bring mobile LIVE-approve to console parity (disable Approve until the typed phrase matches) and add a passkey/WebAuthn or biometric gate for LIVE approvals on mobile; unify money/side/reality formatting via the console format helpers. Do the client-side phrase gating first as a quick safety fix; consolidating the PWA needs the service-worker/manifest reworked.
**[medium / M]**

**Positions/blotter is static — no streaming P&L, day change, sparkline, sort, or inline act** — `positions.tsx` is a good honest table but values are snapshot-static (no mark-to-market tick), unrealized is total-only (no intraday day P&L per position), and there is no sort, per-row sparkline, or inline action (trim/close), so the operator must route through the assistant or wait for an agent proposal.
**How:** Mark-to-market positions from the Alpaca price stream (see F1) so value/unrealized tick live; add a Day P&L column (prior close per symbol via `/api/history` or the quote); make columns sortable (reuse the scan sort util); add a close-price sparkline; and add an inline "Close/Trim" that opens a pre-filled `DraftTicket` → stage → Approvals (reusing `draft-card.tsx`), keeping the approve-gate intact. Inline close must respect risk-reducing-exit semantics and still go through approval unless authority is Autopilot.
**[medium / M]**

**Quantitative signals rendered as bare numbers where a small viz would read faster** — confidence is "82/100" text (no gauge), the composite-score factor bars appear only in the drilldown (not on the card or scan row), and macro tiles are single values with no inline trend though `board.history` exists; data-viz a11y is also thin (SVG charts expose only an endpoint aria-label with no tabular fallback).
**How:** Add a compact confidence gauge/bar to the approval card and a mini factor bar/radar (reuse FactorSection idioms); add inline sparklines to macro tiles from `board.history`; add a small composite-score bar to scan rows; and for accessibility give each SVG chart an associated visually-hidden data table or focusable last-point summary and honor `prefers-reduced-motion`. Keep viz honest — no smoothing of missing points (match the "<2 points = a sentence" rule); render `—` when history is absent.
**[low / S]**

## G. Systems, evaluation, observability & everything else

**Current state.** This codebase's quant/MLOps discipline is a genuine strength, not a skin. The backtest harness implements walk-forward OOS with an always-on embargo plus opt-in purge, tie-corrected Spearman rank IC, composite IC/ICIR, a PAIRED per-date IC-difference t-test that correctly derives SE from the shared fold, IC-weight shrinkage, candidate/baseline OOS drawdown curves, per-regime IC, and an explicit survivorship/look-ahead certification with a HARD point-in-time invariant. The autonomous tuner gates weight changes behind stricter-than-manual thresholds, a fail-closed invariant guard, a shadow/forward-A-B ledger, a reproducibility-provenance audit, and a unified learning-mutation ledger with revert. LLM cost governance is a real per-user/day token+cost ceiling with an atomic CAS reservation closing the concurrent-run TOCTOU, wired into every generation; RAG spend counts toward it. Observability is solid-but-opt-in: Sentry with redaction, a Sentry-Crons dead-man's-switch, a persisted `lastTick` heartbeat, and Langfuse OTel tracing. Multi-account isolation has dedicated tests, and the congress signal has a real permutation/placebo test. The gaps are the next layer of rigor — headlined by the "Manager-model A/B" being documented and half-wired (`proposedByModel` persisted) while the per-model realized scoreboard and model rotation that would run the experiment do not exist in code.

**The Manager-model A/B is documented and half-wired, but the per-model realized-outcome scoreboard does not exist** — `proposedByModel` is persisted and shown on the approval card, but nothing aggregates realized win-rate/avg-return/IC/P&L BY model; `manager-model-options.md` §4 claims "the Results page's per-model breakdown ranks them on realized outcomes," which is not true today.
**How:** Add `getPerModelPerformance()` in `performance.ts` joining closed lots → originating proposal → `proposedByModel` (and `STRATEGY_PROMPT_VERSION`), reporting realized win-rate, avg-return, hit-rate, and a per-model composite IC; reuse `backtest.ts` `pairedICDiffStats` for a paired candidate-vs-baseline t-stat between two models over the same snapshot dates. Surface on `/console` Results. Apply the same min-N / closed-lot gating the weight tuner uses so a 3-lot model doesn't look like a winner. (Converges with A6/B22.)
**[high / M]**

**No automated model rotation/assignment — the A/B can only be run by manually flipping a policy setting** — model choice is a static per-policy field resolved in `proposeTrades`; there is no rotate/assign/bandit logic, so to A/B you hand-edit the setting per run and no controlled experiment ever accumulates.
**How:** Add deterministic per-run assignment — `hash(runId or userId+day) → bucket` over a configured `strategistModelSet` so each run is reproducibly stamped and `proposedByModel` becomes an unbiased experiment arm; as data accrues, upgrade to epsilon-greedy or Thompson-sampling contextual bandit over realized reward (net return per lot) with an explore floor. Keep it a policy setting (default: single fixed model). Gate to paper/opt-in first and log the arm on every proposal.
**[high / M]**

**The strategist prompts (Bull/Bear/Manager) have no model-in-the-loop behavioral eval — only fixed-fixture invariant scorers** — `strategy-score.ts` scores HARD money-path invariants against fixed correct-by-construction fixtures; the chat side has a real MockLLM golden eval and RAG faithfulness, but the strategist prompts are never run through even a MockLLM, so a prompt edit that degrades rationale quality, over-trades, or mis-calibrates conviction is invisible, and `STRATEGY_PROMPT_VERSION` is tied to no behavioral gate.
**How:** Build a strategist golden eval mirroring the atlas golden — market fixtures (scan + evidence + regime) run through the real `proposeTrades`/`debateProposal` with a deterministic MockLLM for CI invariants, plus an optional rubric LLM-judge (reuse `score.ts` `scoreLlmJudge`) scoring rationale groundedness, thesis-tag validity, and conviction calibration. Gate it in `verify` CI and fail on a `STRATEGY_PROMPT_VERSION` bump without a passing eval. Keep the LLM-judge advisory/off-in-CI; rely on deterministic scorers for the merge gate.
**[high / M]**

**Walk-forward is a single 70/30 split — no rolling/anchored multi-fold CV and no Combinatorial Purged CV** — `runWalkForwardOOS` does ONE chronological split, giving a point estimate of OOS IC with no distribution, so the tuner's gate can pass/fail on the luck of where the cut lands.
**How:** Add rolling-origin evaluation (anchored + sliding windows) producing K folds, and Combinatorial Purged Cross-Validation (López de Prado, AFML ch.7/12) reusing the existing purge+embargo machinery; report mean/CI of OOS IC and ICIR across folds and feed the distribution (not a single number) into the autonomous gate. Keep CPCV opt-in and fall back to the single split below a date threshold.
**[medium / L]**

**No overfitting / multiple-testing correction on a tuner that re-tests every cadence (data-dredging risk)** — the autonomous tuner runs on every cadence tick and each apply is a fresh hypothesis test with a paired-t gate but NO family-wise/FDR correction across the many repeated trials, and NO Deflated Sharpe Ratio or Probability of Backtest Overfitting despite computing a Sharpe; an autonomous loop that keeps testing WILL eventually find a spurious edge on noise and persist it to real-money scoring.
**How:** Compute the Deflated Sharpe Ratio (Bailey & López de Prado 2014) using a trials counter tracked in the learning-mutation ledger and a PBO estimate from the CPCV folds; require `DSR>0` and PBO below a threshold in `autonomousOosThresholds`; add Benjamini-Hochberg FDR over the rolling window of applies, optionally White's Reality Check / Hansen SPA over the candidate-weight set. Surface DSR/PBO in the shadow ledger so the owner sees what was withheld. (Converges with A4/A5.)
**[high / M]**

**Strategy runs are not replayable: no seed is sent, reasoning models reject temperature, and the full LLM input bundle isn't persisted** — `llm-request.ts` sends no `seed` and gpt-5/o reasoning models reject temperature, so outputs are non-reproducible; the deterministic scan evidence is stored but the ASSEMBLED prompt + RAG digest + raw model response are not, so a specific proposal can't be replayed or diffed after a prompt/model change.
**How:** Persist a redacted per-run "decision bundle" keyed by `runId` — prompt hash + version, compacted evidence/RAG digest, model, served-model-after-failover, token usage, and the raw structured response; send `seed` on providers that support it (OpenAI chat-completions, DeepSeek, xAI) and record it. Makes `proposeTrades` replayable the way the tuner dry-run already is. Reuse `redactForTelemetry`, store hashes/digests, cap retention.
**[medium / M]**

**Audit trail is an opaque JSON blob — not queryable by decision fields for forensics** — `audit_events` stores payload as TEXT JSON, so "all failovers by model," "all cap breaches by account this week," or "IC provenance over time" require a full-table scan + `JSON.parse` in app code; the rich append-only trail is effectively write-only for analytics.
**How:** Add SQLite generated columns (`json_extract`) + indexes on the hot fields (user/account/symbol/model) or introduce a typed `decision_log` table for money-path events (run, propose, block, place, breaker), and expose a `/api/admin` decision query. Pairs with the decision bundle. Do it as an additive versioned migration with a backfill, mindful of the baseline-DDL-vs-migration trap.
**[medium / M]**

**Cost governance is per-user only — no global operator-funded spend ceiling or spend-rate kill-switch** — `checkLlmDailyBudget`/`reserveLlmBudget` are strictly per-user, so on the operator-funded failover key N tenants can each sit under their own ceiling while the operator's aggregate bill runs away, and there is no anomaly detection on spend velocity.
**How:** Add a global operator daily $ ceiling (`OPERATOR_LLM_DAILY_COST_BUDGET_USD`) checked in the same reservation transaction against `getLlmUsageSummary({operatorFundedOnly:true})`, plus a spend-rate alert (>Nx the trailing-7-day hourly mean) routed via the existing usage-monitor-push path. Make the global cap generous and alert-first, cap-second, so it doesn't starve all tenants at once.
**[medium / S]**

**Model pricing table is hardcoded and drifts; unknown models silently cost $0 and evade the cost ceiling** — `MODEL_PRICE_PER_M` is hand-maintained and `estimateLlmCostUsd` returns undefined for any unpriced model, so a newly added fallback model records null cost and never counts toward the COST budget (only the token budget catches it), and prices drift vs the provider.
**How:** On an unpriced-model hit, emit a warn-once + Sentry breadcrumb and fall back to a conservative default price (e.g. the table max) so cost is over- not under-counted; add periodic reconciliation of ledger cost against provider usage/billing APIs where available; and unit-test that every model in the fallback lists has a price entry. Make the default price and warning visible so the owner adds the real entry.
**[medium / S]**

**SQLite single-writer is the scalability ceiling under multi-account fan-out + streaming** — a single better-sqlite3 file (WAL + `busy_timeout=5s` + `synchronous=NORMAL`) takes writes from up to MAX_CONCURRENCY=3 concurrent runs plus per-account synthetic-stop monitors, pending-fill reconciliation, the mobile-command worker, and the opt-in price/trade streams — all serializing on one file, which can exceed the 5s busy window during a protective-exit tick.
**How:** Near-term, raise `busy_timeout` and route all writes through a single serialized queue/actor to avoid lock thrash; medium-term, abstract `getDb()` behind a repository layer and offer a Postgres backend for multi-tenant deploys (better-sqlite3 stays the single-user/local default). Ship Litestream (already scoped) for continuous replication/DR now. The repository-abstraction + write-queue step is the low-risk first move that de-risks the port.
**[medium / L]**

**Langfuse traces individual generations but there's no run-level trace tree or online eval-in-prod** — `withLlmGeneration` wraps each generation and `recordDecisionObservation` logs discrete non-LLM events, but no single parent span per run stitches scan → Bull → Bear → Manager → placement, so the latency/cost of a full decision and where it stalled aren't visible as one trace, and no live proposals are sampled into the offline scorers.
**How:** Open a run-root span in `runStrategyOnce` (`propagateAttributes` with `runId`) and nest the existing generations/decision events under it, attaching token cost + outcome; add an online-eval sampler that runs a fraction of live proposals through the deterministic strategist scorers and posts scores to Langfuse. All gated behind `langfuseConfigured()` no-op.
**[medium / M]**

**Backtest IC is measured on the survivor set the live scanner surfaced, not a point-in-time universe** — `buildFactorObservations` reads `signal_snapshot` rows (only names the app already scanned and scored) and `certifyForwardResolution` explicitly labels its coverage a "SURVIVORSHIP PROXY" that does NOT certify absence of survivorship bias; delisted/removed names drop out, biasing IC upward.
**How:** Ingest a point-in-time universe (index constituents as-of each snapshot date) and delisting/total-return series, then compute IC over the as-of membership rather than the survivor snapshot; at minimum, log the certification's `forwardCoveragePct` alongside every auto-apply so a low-coverage fold is visibly discounted (the cheap immediate mitigation). Survivorship bias systematically overstates predictive power and biases the auto-apply gate toward over-applying.
**[medium / L]**

**Performance attribution is SPY-only — no factor/beta-adjusted alpha** — `benchmark.ts` compares the equity curve to SPY buy-and-hold with a nice TWR adjustment, but there is no CAPM/Fama-French regression to separate genuine alpha from beta/size/value/momentum exposure, and `famafrench.ts` isn't wired into realized-return attribution.
**How:** Run an OLS regression of realized daily strategy returns on Mkt/SMB/HML/UMD (reuse `famafrench.ts`) to report annualized alpha, factor betas, and the information ratio vs a factor model — not just excess return vs SPY — surfaced next to the SPY scoreboard. Gate the readout on a minimum sample and show CIs, since thin history makes the regression noisy early. ("Beating SPY" can be pure beta in a bull tape.)
**[medium / M]**

**No calibration measurement for the model's confidenceScore (Brier/reliability curve)** — the strategist emits `confidenceScore` and the red-team gate keys off it, but nothing measures whether stated confidence predicts realized win-rate; there is no reliability curve or Brier score over closed lots by confidence bucket.
**How:** Add a calibration report in `performance.ts` — bucket closed lots by stated confidence, compute empirical win-rate per bucket, the reliability curve, and a Brier score, optionally fitting an isotonic recalibration map feeding calibrated confidence into the red-team conviction gate so the threshold is evidence-based. Use shrinkage toward the base rate for small buckets. (Converges with A16/B12.)
**[medium / M]**

**Money-path tests are unit/isolation-strong but lack concurrency, property-based, and fault-injection coverage** — good unit + tenant-isolation coverage exists, but nothing exercises two concurrent same-user account runs interleaving through the real reservation+run-lock to prove no double-place/overshoot, there are no property-based tests on the sizing/policy math, and no end-to-end fault injection for broker uncertain-placement/partial fills or provider 429 storms in the run path.
**How:** Add (a) a concurrency harness that races `runStrategyOnce` for two accounts of one user and asserts caps/reservation invariants hold; (b) fast-check property tests asserting sizing never exceeds per-order/day/exposure caps and is monotonic in NAV; (c) a fault-injecting `TestBrokerGateway` variant returning uncertain/partial/timeout and asserting no orphaned orders and correct `pending_reconciliation`. Use deterministic fake timers and the temp-SQLite-per-run convention to avoid flakiness.
**[medium / M]**

**No model/prompt registry or promotion workflow linking (prompt version × model) to realized outcomes, and no input-drift monitor** — `STRATEGY_PROMPT_VERSION` and `proposedByModel` are persisted, but there is no registry mapping (promptVersion, model) → realized performance, no canary/promote gate, and no monitor for evidence-distribution drift (scan/factor inputs shifting under a fixed prompt).
**How:** Add a lightweight registry table keyed by (promptVersion, model) accumulating realized metrics (reusing the per-model scoreboard and calibration findings), and a promotion gate reusing the OOS/paired-t infra to require a challenger beat the incumbent before becoming default; add a simple input-drift monitor (PSI/KL of factor-score distributions vs a trailing baseline) that alerts when inputs move enough to invalidate a prompt's tuning. Land the registry+promotion first, drift monitor second.
**[medium / M]**

**Scheduler single-leader is default-off and the dead-man's-switch is opt-in — multi-process deploys can double-run** — `SCHEDULER_SINGLE_LEADER` defaults OFF, so on any multi-process deploy every process runs the tick body (duplicate scrapes and, worse, duplicate broker EXIT/stop orders); the Sentry-Crons heartbeat is also opt-in and the `lastTick` heartbeat isn't asserted against a hard threshold in `/api/health`.
**How:** Default single-leader ON in production (off for single-process local/dev) and have `/api/health` fail when `scheduler:lastTick` is older than ~2 ticks so an external supervisor restarts a hung scheduler even without Sentry; document the leader lease as required prod posture. The code already releases on SIGTERM/beforeExit; keep the lease TTL short to avoid a stuck lease.
**[medium / S]**

## Cross-cutting gaps & second-order risks

These are seams the individual experts under-covered because they span domains. As completeness critic, the panel adds them.

**Episodic trade memory is nobody's single owner — it falls between learning and RAG.** Section A wants k-NN recall of analog trades; Section C wants embedded per-(thesis,regime) lessons; both describe half of one system. Without a unified store of `{state vector, realized outcome}` serving BOTH nearest-neighbor precedent at decision time AND regime-conditioned lesson retrieval, each side ships a partial memory and the highest-leverage decision-quality lever stays unbuilt.
**How:** Make `experience-memory.ts` (A1) the substrate the lesson-embedding (C21) and regime-conditioned reflection (A2) both read from — one namespace, one write hook in the fill path, two read shapes (per-candidate analogs, per-regime lessons). Own it as a single deliverable, not two.
**[high / L]**

**Scout-then-analyst cost staging is specified per-domain but never wired end-to-end.** Prompting proposes a scout pre-pass (B8) and agentic evidence tools (B15); data-providers propose field-demand planning (D2); RAG proposes JIT ingest (C11) — but nothing ties the shortlist to *all three*, so the cheap shortlist could still trigger full enrichment and full retrieval for names it will discard.
**How:** Let the scout's shortlist be the single gate that drives deep enrichment (field-demand planner), deep retrieval (HyDE/multi-query + JIT ingest), and the expensive Bull — one shortlist, three downstream economies. Design the scout output as the shared demand signal.
**[high / L]**

**Point-in-time integrity is audited per-module but never certified end-to-end.** Prices are rigorously PIT in the backtest, but macro reads today's revised FRED print (C22), RAG as-of filtering is lossy (C8), horizons are calendar-day (A8), amended filings don't supersede (C24), and IC runs on a survivor set (G12). Each is a separate silent hindsight leak into the same real-money auto-apply gate; no single artifact asserts a backtest run is leak-free across ALL data classes.
**How:** Emit one "leakage certificate" per backtest/tuning run that asserts, per data class (prices, macro vintages, RAG as-of, universe membership, horizon arithmetic), that only as-of-known data was used, with coverage percentages; fail-closed the auto-apply gate when any class is uncertified. Extends the existing `isPointInTimeForwardExit` / survivorship certification to the whole stack.
**[high / M]**

**The evaluation → model/prompt selection loop is four disconnected pieces.** Per-model scoreboard (G1), randomized assignment (G2), strategist behavioral eval (G3), and the registry/promotion gate (G16) are each proposed in isolation; nothing wires realized outcomes back into which (promptVersion × model) is the running default, so measurement never becomes selection.
**How:** Sequence them as one MLOps loop — randomized assignment produces unbiased arms → the scoreboard + calibration rank them → the registry records (promptVersion × model) → the promotion gate (reusing OOS/paired-t) flips the default. The strategist golden eval guards prompt edits at the front. Build them as a chain, not four backlog items.
**[high / M]**

**The tuner optimizes an objective the book doesn't trade.** IC is measured at a fixed 5-day horizon (A7) while theses hold multi-week; sizing is on mean edge (E5) and blind to payoff dispersion (E19); so the weights the auto-apply gate actuates are tuned for a horizon and a loss-profile the account never realizes. The horizon mismatch, payoff-blind Kelly, and dispersion-blind sizing compound rather than cancel.
**How:** Align the learning objective to the trading objective — horizon-match IC to each thesis's median hold, size on fractional Kelly with realized avg-win/avg-loss, and penalize downside dispersion — as one coherent "size and learn on the same risk-adjusted, horizon-correct payoff" change.
**[high / M]**

**The whole eval stack is estimated on an endogenous, self-selected sample.** IC, the per-model scoreboard, and confidence calibration are all computed on names the strategy chose with the weights being tuned (A11); with no exploration budget or inverse-propensity correction, every downstream statistic inherits the selection bias, so a down-weighted factor that actually predicts is never sampled and can't be discovered.
**How:** A small owner-overridable exploration budget (floor-sized positions in lower-ranked candidates) + IPS/doubly-robust weighting in IC/scoreboard computation de-biases the entire measurement stack at once — treat it as infrastructure for honest evaluation, not just a learning tweak.
**[medium / L]**

**Groundedness has an offline test but no runtime gate on either money path.** A faithfulness eval exists (C15), but neither the strategy proposal nor the chat answer is checked at runtime that its load-bearing claims are entailed by retrieved chunks, so a confident Bull citing a chunk that doesn't support the claim flows unflagged into a real-money decision — the exact failure that separates RAG from hallucination.
**How:** One advisory NLI/LLM-judge groundedness pass shared by `strategy.ts` and `chat/orchestrator.ts`, surfacing an ungrounded-claim flag into the approval inbox (never a hard block, per the overridable philosophy). Build it once, wire both consumers.
**[medium / M]**

**Concurrency + single-writer SQLite is a systemic hazard the feature backlog ignores.** Streaming, per-account synthetic-stop monitors, pending-fill reconciliation, and the default-off single-leader (G17) all converge on one file lock (G11); a lock stall or a double-running scheduler during a protective-exit tick is a direct money-path risk, yet almost every feature above adds writers (experience memory, news embedding, coverage telemetry, decision bundles).
**How:** Treat the write-queue/repository-abstraction + single-leader-on-in-prod as a prerequisite that lands BEFORE the write-heavy features, not after — otherwise each new persisted stream tightens the lock contention on the highest-stakes path.
**[medium / L]**

**Regime string-coupling is a latent correctness bug blocking every graduated de-risk feature.** The crisis cap, bear filter, and escalation gates each substring-match the regime label independently (E14), so a relabel silently desyncs them — and the multi-signal severity score (E1), continuous taper (E4), and typed enum are all downstream of fixing it. It reads as a UI/labeling nit but is the foundation for the entire tail-risk upgrade.
**How:** Land the typed regime enum + numeric severity FIRST (it is S-effort), with the cross-module behavior-mapping unit test, then build vol-targeting / continuous taper / term-structure triggers on top. Sequence it as the enabler it is.
**[medium / S]**

**Safety affordances drift across the three UI surfaces, worst on the one used on the go.** The mobile PWA's LIVE-approve is enabled with an empty confirmation phrase while the console disables it until the typed phrase matches (F16); three design languages (F) mean every safety control (typed-match gating, reality banners, sign handling) must be re-implemented and can silently diverge — on the surface most likely to approve real money from a phone.
**How:** Bring mobile LIVE-approve to console parity immediately (client-side phrase gating + optional WebAuthn/biometric), then converge to one token system / one installable PWA so a safety affordance is written once and can't drift. Parity fix first (quick), consolidation second.
**[medium / M]**

## Quick wins

High-impact, S-effort items to land first.

| Item | Section | One-liner |
|------|---------|-----------|
| Bear-veto counterfactual + red-team efficacy | A | Feed Bear-rejected names to the counterfactual pipeline so the adversary's alpha is measurable, not faith-based. |
| Wire dormant relevance-floor + near-dup dedupe | C | Two-line change per call site turns on already-built, tested retrieval-quality stages. |
| Provenance headers on retrieved chunks | C | Prepend `[10-K · risk · AAPL · date · rel 0.82]` so the model can weight and cite instead of seeing a bare blob. |
| Per-data-class cache TTLs + `asOf` on Alpaca snapshot | D | Stop pinning "real-time" prices to a 6h-stale quote and let the staleness gate see true quote age. |
| Live `^VIX` overlay off the 24h FRED cache | D | The panic brake must not run on a day-lagged VIX. |
| Provider negative-caching + field coverage telemetry | D | Stop re-hammering no-data symbols; alert when a field goes dark. |
| Content-hash dedup default-on + widen hash to 128-bit | C | Stop re-embedding byte-identical summaries; remove a silent collision risk. |
| Embedding-model version tag on vectors | C | Prerequisite for any safe model swap / A/B / quantization. |
| Raise rerank candidate-pool cap | C | Feed the strong cross-encoder a wider recall pool for symbols with many chunks. |
| Typed regime enum + severity (kill string-coupling) | E | Enabler for every graduated de-risk feature; fixes a silent cross-module desync. |
| VIX term-structure soft de-risk trigger | E | Catch Feb-2018 / Mar-2020 onsets days before VIX prints 40. |
| Default-on account brakes (drawdown / daily-loss / crisis cap) | E | The strongest tail controls are dormant at null defaults. |
| Cross-provider Bear default + Bear temperature | B | End the same-family echo chamber and surface more failure modes. |
| Reward abstention in the Bull schema | B | Signal that zero proposals is a valid, common, correct outcome. |
| Global operator LLM spend ceiling + unpriced-model default price | G | Close the one budget dimension that can surprise the operator with a bill. |
| Scheduler single-leader ON in prod + hard health threshold | G | Prevent duplicate broker exits and silently-dead schedulers. |
| Accessible Sheet focus-trap + aria-labelledby | F | Keyboard/SR users can currently tab out of an open LIVE confirmation dialog. |
| R:R geometry bar on the approval card | F | A 10px scale reads risk:reward and entry-drift faster than three dollar figures. |
| Global symbol omnibox | F | Type any ticker to open its drilldown, not just click a table row. |
| Mobile LIVE-approve parity (client-side phrase gating) | F | Bring the on-the-go surface up to the console's confirmation safety. |

## Big bets

Transformative, L-effort items worth a dedicated push.

| Item | Section | One-liner |
|------|---------|-----------|
| Episodic experience-replay trade memory | A / C | k-NN recall of the most similar past setups and how they resolved, plus regime-conditioned lessons — the missing decision-quality lever. |
| Scout-then-analyst two-stage evidence + agentic tools | B / C / D | Cheap shortlist drives deep enrichment, retrieval, and the expensive Bull only for the 1–3 names actually weighed. |
| Corpus-wide sparse-dense hybrid retrieval | C | Native Pinecone sparse-dense or SQLite FTS5 so exact-term recall spans the whole corpus, not just the dense top-50. |
| Self-consistency k-sample ensembling on the money path | B | Recurrence across samples becomes an independent confidence signal into sizing. |
| Approval card full decision provenance | F | Sizing constraint, evidence citations, failover/truncation history, and per-model calibration on the one human-load-bearing surface. |
| Hierarchical partial pooling across accounts | A | Thin accounts borrow strength from a data-driven population prior instead of a fixed neutral constant. |
| Exploration budget + off-policy (IPS) correction | A | De-bias the entire evaluation stack estimated on a self-selected sample. |
| Joint portfolio construction over the batch | E | The true "Manager" step: cluster, diversify, and allocate the risk budget instead of first-come-first-served gating. |
| Factor-exposure aggregation & crowding caps | E | Surface the hidden momentum/value bet a book of "diversified" names actually is. |
| Active hedging / net-exposure reduction on brake | E | Turn the vol brake from passive (stop entries) to protective (reduce/hedge the book). |
| CPCV multi-fold + Deflated Sharpe / PBO gate | G | Make the autonomous auto-apply decision robust to split placement and honest about repeated testing. |
| Point-in-time universe (survivorship fix) | G | Compute IC over as-of index membership + delisted names, not the survivor set. |
| Repository layer + Postgres option + write-queue | G | Lift the single-writer SQLite ceiling before the write-heavy features pile onto it. |
| OPRO-style prompt self-optimization with pruning | A | Outcome-validated prompt edits that also retire stale AI-LEARNED directives. |
| Automatic model selection (bandit over realized edge) | A / B / G | Close the per-model loop from measurement into an ongoing optimizer, owner override intact. |
| Operator-density mode + multi-pane Desk layout | F | A dense, rearrangeable, persisted cockpit for the power-operator persona. |

## Phased roadmap

### Now (0–2 wk)
- Bear-veto counterfactual + red-team efficacy
- Wire dormant relevance-floor + near-dup dedupe (RAG)
- Provenance headers on retrieved chunks
- Per-data-class cache TTLs + `asOf` on Alpaca snapshot
- Live `^VIX` overlay off the 24h FRED cache
- Provider negative-caching + field-coverage telemetry
- Content-hash dedup default-on + widen content_hash to 128-bit
- Embedding-model version tag on vectors
- Raise rerank candidate-pool cap
- Typed regime enum + numeric severity (kill string-coupling)
- VIX term-structure soft de-risk trigger
- Default-on account brakes (drawdown / daily-loss / crisis cap)
- Cross-provider Bear default + Bear temperature; reward abstention in Bull schema
- Global operator LLM spend ceiling + unpriced-model conservative default price
- Scheduler single-leader ON in prod + hard `/api/health` heartbeat threshold
- Accessible Sheet focus-trap + aria-labelledby
- R:R geometry bar; global symbol omnibox; mobile LIVE-approve phrase-gating parity
- Trading-day (not calendar-day) horizon arithmetic
- Pass `asOf` explicitly + doc_type-stratified retrieval selection
- Bear sees non-proposed candidates; lazy fallback-body construction

### Next (1–2 mo)
- HyDE + evidence-derived multi-query retrieval; wire the scout output as the shared demand signal
- Earnings-transcript ingestion; embed news as durable PIT memory
- Post-mortem lessons as regime-conditioned retrievable vectors (+ demote the free-text blob)
- Coverage-driven ingestion prioritization + JIT ingest for new candidates
- `document_chunks` persist text/date/model/vector-id; corpus-wide hybrid ON by default
- As-of numeric epoch server-side filter; FRED ALFRED macro vintages; amended-filing supersede
- Runtime groundedness / faithfulness advisory gate (shared by strategy + chat)
- End-to-end point-in-time "leakage certificate"
- Multi-signal regime scorer; continuous exposure taper; volatility-targeting sizing; portfolio-heat budget
- Fractional Kelly on realized payoff; downside-dispersion-aware sizing; horizon-matched multi-horizon IC
- EWMA / downside correlation gate; earnings & macro-event blackout; pre-trade scenario stress test
- Cross-model disagreement as epistemic uncertainty; account-edge changepoint self-throttle
- Overlap-aware IC SE (HAC/block-bootstrap) + multiple-testing / Deflated-Sharpe correction
- Per-model realized scoreboard + randomized model assignment; strategist behavioral golden eval
- Decision-bundle persistence + seeds; run-level Langfuse trace tree + online eval sampler
- Queryable decision log; factor-adjusted alpha; confidence-calibration report (Brier/reliability)
- Model/prompt registry + promotion gate; input-drift monitor; concurrency/property/fault-injection tests
- Console SSE wiring + mark-to-market; adopt lightweight-charts; keyboard palette + hotkeys
- Accessible tooltip/popover primitive (retire native `title`); live risk-utilization board
- Approvals triage/bulk/sort; alert center (notifications/sound/push); intraday charts; live positions blotter
- Tradier options/IV enrichment + options-flow ingestion; finance-tuned news sentiment
- SQLite→repository write-queue + Litestream; per-provider quota token buckets; bulk endpoints; SQLite-backed enrichment cache

### Later (quarter+)
- Episodic experience-replay trade memory (unified analog + lesson store)
- Scout-then-analyst two-stage evidence + agentic on-demand tools
- Corpus-wide sparse-dense hybrid; MMR diversity; ingest-time near-dup gate; contextual-retrieval prefixes
- Embedding-model eval-gated comparison + int8/Matryoshka quantization; Pinecone namespaces; event-driven EDGAR ingestion; structured-output memory extractor
- Self-consistency k-sample ensembling; structured-output repair loop + runtime schema validation; prompt-cache restructuring; adaptive effort/tier routing
- Approval card full decision provenance; operator-density mode + multi-pane Desk; console-as-PWA consolidation
- Hierarchical partial pooling; exploration budget + off-policy IPS; drift/time-decay detection; OPRO prompt self-optimization; per-thesis multi-horizon weight targeting
- Joint portfolio construction; factor-crowding aggregation & caps; active hedging on brake; gap-risk sizing/stop-limit
- CPCV multi-fold + PBO; point-in-time universe (survivorship fix); Postgres backend for multi-tenant
- Automatic model selection (contextual bandit over realized edge)







