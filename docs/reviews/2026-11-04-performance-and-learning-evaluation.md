# Performance And Learning-Loop Evaluation (2026-11-04)

Requested by the owner: how is the app performing overall, and what would most improve its chance of a slight, durable edge over the S&P 500, making good use of the learning saved in its RAG store.  Linear: ST-4589.

This is a code-and-records evaluation.  No production data was changed.  The live numbers below are from `docs/reviews/2026-09-25-trading-performance-report.md` (about six weeks old); they could not be refreshed in this session because `OPS_DIAGNOSTIC_TOKEN` was not available to it.  Treat every figure as "as of Sep 25" until `/api/ops/performance?days=120` is run again.

## Verdict

There is no evidence of an edge over the S&P 500, and until this change the app could not measure one: no closed lot carried an alpha figure.  The learning loop wrote a great deal and retrieved little of its best material.  The parts most likely to produce an edge are the systematic ones (factor ranking with the walk-forward autotune, insider accumulation, loss discipline); the model's free-form picks, its own sizing, single-trade hindsight lessons, model rotation and the Red Team are mostly noise as built.

## Evidence (as of Sep 25)

- Alpaca Paper is the only usable sample: 98 closed lots, -$185.93 realized, profit factor 0.78, 48% win rate per lot, t about -1.2.  That is indistinguishable from zero in either direction.
- The account sat more than 90% in cash.  In a rising market that alone loses to the index.
- 4 lots made up 70% of the loss, and the losers were the larger positions.
- Live money is negligible (Roth IRA -$0.62 over 44 lots).
- Red Team vetoes were a coin flip: 13 losses avoided against 15 winners missed.
- 36 of the last 50 Alpaca Paper runs in that report never completed.  The current completion rate was not checked.
- The one model gap that looked significant (grok-build ahead of gpt-5.5) is confounded with calendar time, because the rotation scheme changed twice.

## Pipeline, as the code runs it

1. Trigger: the scheduler runs an active account inside market hours once its cadence (default 60 minutes) has passed (`src/lib/scheduler.ts`).
2. Universe: S&P 500 filtered by price, market cap and dollar volume, ranked on 8 weighted factors; the top 30 go forward plus up to 8 outliers and all holdings (`defaults.ts`, `market.ts`, `scan-settings.ts`).
3. Proposer (Green): up to 3 proposals at temperature 0, with a 48k-character evidence budget of which up to 28k is learning content (`strategy.ts`, `strategy-prompts.ts`).
4. Sizing: `applyDeterministicSizing` (`strategy-risk.ts`) is mostly bypassed, because a size supplied by the model wins.
5. Red Team: reviews only risk-adding openings; can approve, halve or reject (`red-team.ts`).
6. Policy gates: per-order cap, 5% of average daily volume, 25% symbol exposure, 80% gross exposure, 20% of NAV in new openings per day, quote staleness (`policy.ts`).
7. Exits: rule-driven stops (ATR, then beta, then a flat 8%) and a 50% trim at +20%.  `maxHoldingUntil` is stored but never enforced, so there is no time stop.
8. Fills and P&L: FIFO per symbol (`performance.ts`).  Live commissions are not deducted and slippage is not measured.
9. Lessons written: closed-lot experience documents, decision cases, per-decision LLM lessons, thesis-by-regime reflection lessons, SQL learned-context facts, and counterfactuals for skipped and rejected ideas.
10. Embedding and storage: `baai/bge-m3` at 1024 dimensions, stored in Qdrant (`vector-db.ts`).  Docs that say Voyage are stale.
11. Retrieval: `retrieveDecisionExperiences` (`experience-memory.ts`), k=8, minimum score 0.30, a usefulness rerank, no recency weighting, a 15-second deadline.

## What Was Broken In The Learning Loop

Read in the code, and fixed in this change unless marked otherwise (rollout: `docs/rollouts/2026-11-04-learning-loop-wiring-fixes.md`):

- Pooled thesis-by-regime reflection lessons were written at user level, but the only retriever filtered on the exact account id, so they were never retrieved.
- Approved risk lessons are stored under a tier the prompt reader does not read (not fixed: approval can come from the owner or from the Learning Review model in its default mode, and the row does not record which, so reading them is an owner decision).
- Regime and thesis relevance scoring always scored zero, because neither field was written and the thesis tags were never passed to the retriever.
- The pure-statistics lessons were skipped whenever there was no LLM key or the account was over budget.
- `stampClosedLotAlpha` had no production caller, so no scorecard row carried excess return against SPY.
- The benchmark treated a deposit as arriving at the start of the day on the account side and at the end of the day on the SPY side.
- The console win rate counted every partial trim as a trade.
- Counterfactual start dates used the UTC date where the market date was needed.

Still open (not fixed here, each is a design or money-path decision):

- Deterministic sizing is bypassed: a parked thesis (multiplier 0) or a thesis with negative average return still trades whenever the model supplies a size (`strategy-risk.ts` about lines 614, 674, 763).
- Memory decay is dead code (`memory-decay.ts` is imported only by its test).
- Nothing measures whether retrieved lessons improve decisions.
- `backtest.ts` compounds overlapping 5-day forward returns on every snapshot date and annualizes Sharpe as if they were independent.
- Retried Red Team reviews are sent with no evidence and empty positions (`retry-red-team.ts`); the first review's context is built in memory and never stored.
- The SPY window for counterfactuals ends at "now" where it should end at each row's exit date.

## Most Impactful Improvements, Ranked

Ranked by expected effect on beating SPY per unit of effort.

| # | What | Why | Size | How to measure |
|---|---|---|---|---|
| 1 | Core-satellite: hold SPY by default; let the model trade a capped sleeve funded from SPY instead of cash | 90%+ cash guarantees losing to the index in up markets | M | Tracking error against SPY; active return of the sleeve |
| 2 | Honest measurement: per-lot alpha (now wired), a scorecard per prompt version and per model against SPY over the same window, with bootstrap confidence intervals | No change can be judged without it | S-M | Every scorecard row shows excess return, n and a 95% interval |
| 3 | Sizing under deterministic control: target = min(model size, cap x multiplier); honour a parked thesis | 4 lots were 70% of the loss | S | Dollar loss spread across lots |
| 4 | Shadow A/B harness: run candidate prompts and models without placing orders, score them forward against SPY, with models on fixed arms instead of rotating | The only reliable way to improve prompts and models without paying for it in live P&L | M-L | Shadow against live excess return at a pre-registered sample size |
| 5 | Fix the RAG wiring | The best lessons never reached the prompt | S | Done in this change; watch the share of prompts carrying reflection lessons |
| 6 | Remember statistics, not anecdotes: prefer aggregate lessons gated by sample size and a confidence interval over single-trade hindsight lessons; wire up decay; give lesson vectors stable ids | One-trade lessons with the outcome known are mostly noise | M | The ablation in item 7 |
| 7 | Memory ablation: randomly withhold the learning blocks on a share of runs, logged | The only way to know whether the RAG adds value | S-M | Excess return and hit rate, memory arm against no-memory arm |
| 8 | Red Team: re-score at the matched holding horizon, then cut to halve-only or remove it if it still shows no value | 17.5% of proposals are vetoed with no proven benefit | S | Vetoed against approved returns at the same horizon, n >= 50 |
| 9 | Exits: enforce `maxHoldingUntil`; use the model's stop when it set one | A thesis held without a time limit drifts into index risk without the index's return | M | Return per day held |
| 10 | Run reliability: check how many runs complete now | 36 of 50 failed in September | ? | Completed over started runs |
| 11 | Turn on factor autotune on paper | It is the most rigorous learning path in the code and is off by default | S (owner flag) | Out-of-sample information coefficient |
| 12 | Record fees and slippage against decision and arrival price | Edge net of costs cannot be judged without it | S-M | Average cost in basis points per round trip |

## Questions For The Owner

1. Is a SPY core with a model-driven satellite sleeve acceptable, or must the app pick all of the holdings?
2. Should the deterministic sizer override the model's dollar amount, or only cap it?
3. Which account is the evaluation account, and does a paper result count as evidence for adding live capital?
4. Is a fixed model per account for a set period acceptable, so models can be compared cleanly?  (The Rotation Models checklist from ST-4589 can narrow the rotation, but any rotation still confounds comparisons.)
5. Should the Red Team keep its veto, be cut to halve-only, or be removed until it shows value?
6. Should factor autotune and a time stop be on by default?
7. What horizon and minimum sample count as a durable edge?
8. Should risk lessons approved by the Learning Review model reach the trading prompt, or only ones the owner approved?
