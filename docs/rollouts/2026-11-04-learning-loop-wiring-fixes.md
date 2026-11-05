# Learning-Loop Wiring Fixes (2026-11-04, ST-4589)

## 1. Context And Objective

The owner asked for an evaluation of how the app performs against the S&P 500 and how well it uses the learning saved in its RAG store, with small fixes landed on the way.  The evaluation (`docs/reviews/2026-11-04-performance-and-learning-evaluation.md`) found that several lesson types were written but never reached the decision prompt, and that benchmark-relative figures were never stamped.  This change fixes the small, clearly wrong parts.  It does not change order placement, sizing or risk gates.

## 2. Changes Made

Summary: the retriever can now see user-level reflection lessons; regime and thesis relevance can score; statistics-only lessons no longer depend on an LLM key; scorecards carry excess return against SPY; the benchmark treats cash flows the same way on both sides; the Results card shows a round-trip win rate.

- **Reflection lessons reach the prompt.**  The post-mortem pools thesis-by-regime lessons at user level (`memory_scope: "user"`).  The retriever filtered on the exact account id, so they were never returned.  Retrieval now accepts `accountScope: "exact-or-user"`: this account's rows or the same user's private user-level rows.  The user id, tenant scope and per-user namespace filters are unchanged.  Lessons already stored become reachable without a re-index.
- **Regime and thesis relevance can score.**  Post-mortem lessons carry the decision's regime and thesis tag; track-record facts carry the thesis tag; the retriever is passed the thesis tags of the top candidates so the affinity boost can fire.
- **Statistics-only lessons no longer need an LLM key.**  The thesis-by-regime lesson vectors are written even when the account has no key or is over budget.  The dedupe signature is recorded only when every bucket was written, so a failed or skipped write is retried on the next run.
- **Alpha is stamped.**  The thesis and regime scorecards built in the proposal step stamp per-lot excess return against SPY (`avgAlphaPct`), using the cached SPY series with a 5-second limit, matching entry and exit to the New York market day, and skipping the stamp when the series is stale.
- **Benchmark flow timing.**  The account side already treated a deposit or withdrawal as arriving at the start of the day (`equity / (previous equity + flow)`).  The SPY shadow added it at the end of the day.  The shadow now uses the same start-of-day convention (`shadow = (shadow + flow) * SPY factor`).  The web and iOS captions that described the shadow were updated to match.
- **Round-trip win rate.**  The Results card shows a win rate per completed round trip, with its own count and empty state; Avg Return stays per closed lot and is labelled as including partial trims.  The per-lot API fields are unchanged for iOS, the chat tool and the tuner.
- **Counterfactual start date** uses the market date.
- **Comments** on vol targeting now say it defaults on; comments on approved risk lessons now say they are stored but not read into the trading prompt.

Files touched:

- `src/lib/vector-db.ts`
- `src/lib/experience-memory.ts`
- `src/lib/learned-context/store.ts`
- `src/lib/outcome-engine.ts`
- `src/lib/post-mortem.ts`
- `src/lib/types.ts`
- `src/lib/strategy.ts` (the retrieval call and the scorecard call only)
- `src/lib/strategy-risk.ts` (comment only)
- `src/lib/benchmark.ts`
- `src/lib/performance.ts`
- `src/lib/ops-performance.ts`
- `src/lib/counterfactual-learning.ts`
- `app/console/page.tsx`, `app/console/results/page.tsx`
- `app/console/lessons/learned-context.tsx` (comment and one honesty line)
- `ios/SocraticTrade/ResultsView.swift`, `ios/SocraticTrade/HomeView.swift` (caption strings only)
- `test/benchmark.test.ts`, `test/counterfactual-learning.test.ts`, `test/experience-memory.test.ts`, `test/learned-context-pending.test.ts`, `test/lesson-vectors.test.ts`, `test/realized-pnl-ledger.test.ts`, `test/vector-db-retrieval.test.ts`
- `docs/reviews/2026-11-04-performance-and-learning-evaluation.md` (new), this note (new), `STATUS.md`, `PLAN.md`

## 3. Decisions And Trade-Offs

- **The reflection-lesson fix is on the read side.**  The post-mortem pools across a user's accounts on purpose, so stamping an account id on write would have been wrong, and a read-side clause also rescues rows already stored.  Consequence: lessons pooled from a user's paper accounts now reach that user's live-account prompts.  An independent review traced the filter end to end and found no path to another user's rows.
- **Approved risk lessons are NOT read into the trading prompt.**  A first version of this change read them.  It was reverted: approval can come from the owner or from the Learning Review model in its default "decide" mode, and neither the stored row nor the pending row records which, so reading them would let one model's risk suggestions steer the trading model.  Whether to read them is the owner's decision.
- **Benchmark.**  A first version changed the account formula to `(equity - flow) / previous equity`.  That over-credits a deposit invested the same day (a $10,000 deposit on a $1,000 balance on a +1% day read +11%), so the account formula was left as it was and the SPY shadow was aligned to it.  Figures shift only on the SPY side, on days with a deposit or withdrawal.
- **Skipped on purpose:** giving retried Red Team reviews the first review's context (it is built in memory and never stored), and ending the counterfactual SPY window at each row's exit date (the map is keyed by snapshot date only).
- **Not touched:** sizing (a parked thesis still trades when the model supplies a size), backtest math, exits, Red Team policy, memory decay.  Each is listed in the evaluation as an owner decision.

## 4. Verification State

```bash
npx vitest run test/benchmark.test.ts test/cash-flows.test.ts test/learned-context.test.ts test/learned-context-pending.test.ts test/realized-pnl-ledger.test.ts test/lesson-vectors.test.ts test/post-mortem.test.ts
npx vitest run test/vector-db-retrieval.test.ts test/experience-memory.test.ts test/counterfactual-learning.test.ts test/rejected-counterfactual.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Focused suites pass and `npx tsc --noEmit` is clean.  The full gate result on the final commit is recorded on the pull request.  The Swift caption edits compile only in the hosted `ios-build` job.  The Results card captions may change a Playwright visual baseline.

## 5. Next Steps And Blockers

- Refresh the Sep 25 performance numbers (`/api/ops/performance?days=120`); the diagnostic token was not available to this session.
- Owner decisions listed at the end of the evaluation, in particular sizing control, core-satellite, and whether model-approved risk lessons may reach the trading prompt.
- Follow-ups: record who approved a risk lesson; switch iOS to the round-trip win rate; add regime and thesis columns to pending risk lessons; end the counterfactual SPY window at the exit date; store the first Red Team review's context so a retry can reuse it.

## 6. Zero-Code Findings

See `docs/reviews/2026-11-04-performance-and-learning-evaluation.md`.  In short: no demonstrated edge as of Sep 25, more than 90% cash, losses concentrated in a few large lots, and a Red Team whose vetoes were a coin flip.
