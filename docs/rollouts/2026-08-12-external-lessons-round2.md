# 2026-08-12 — External-repo lessons round 2: alpha grading, signal health, cancel-dust advisory

## Context & Objective

Round 2 of the owner's external-repo lessons request (broad GitHub sweep: TradingAgents, ai-hedge-fund, freqtrade, qlib, RD-Agent, FinMem — research record in `docs/reviews/2026-08-12-dsa-lessons-gap-analysis.md`).  Implements the three definitive wins selected from 8 candidate lessons (7 recommended, 1 rejected); the other four are Planned board rows.

## Changes Made

Slice 1 — opt-in benchmark-alpha outcome grading (`f7a9eac8`, from TradingAgents' reflection design):
- New `policy.outcomeGradingMode: 'raw' | 'alpha'` (default `raw`, byte-identical existing behavior; enum-validated in the policy PATCH route).
- In alpha mode, `measureCase` writes companion `alphaStatus`/`alphaPct` from the longest-resolved horizon carrying `spyExcessPct` (`pickHeadlineAlpha`), cites the alpha figures in the post-mortem prompt, and emits an `outcome_alpha_grading` divergence receipt whenever raw and alpha verdicts disagree (raw `won` but underperformed SPY = the beta-not-skill signal).  Unmeasurable SPY excess falls back to raw gating WITH a receipt — lesson generation is never blocked.
- Retrieval-usefulness join writes `:alpha`-suffixed stat rows unconditionally (history collects either way); weighting selects the flavor by mode, raw selection byte-identical.  `strategy-tuning` decision memory now cites the vs-SPY figure.

Slice 2 — live signal-health monitor (`efd49981`, from qlib/freqtrade's evaluation rigor):
- New `signal_health_snapshot` table (migration 74) + `db-signal-health.ts`; pure math in `signal-health.ts`: rank IC of the LLM's own confidenceScore vs matured outcomes (reusing backtest's now-exported `spearmanRankIC`), quantile buckets, consecutive-day top-K Jaccard churn, gross-vs-net (20 bps round-trip, surfaced via the API), and a simple drift detector (consecutive declines or negative slope).
- Daily `signal-health-refresh` scheduler lane; honest floor — below 20 matured observations no snapshot is written.  Observations pool over a 90-day trailing window (integration fix — all-history pooling would deaden the detector).
- Edge-triggered drift alarms: `signal_health` notification event + audit on fire AND clear.  `policy.tuning.signalHealthAutoThrottle` (default OFF): when on, an active alarm caps conviction upside at the uncorroborated level with a `confidence_capped_signal_drift` receipt.
- Compact Signal Health card on the Results page (con-*, honest empty states, CT-labeled stamp) fed by `GET /api/signal-health`.

Slice 3 — cancel-dust advisory (`2f8b7e58`, from freqtrade's order hygiene; advisory ONLY):
- `describeCancelDustRisk` in `broker-minimum-guard.ts`: canceling a partially-filled fractional/dollar entry that would strand a below-broker-minimum fragment produces a warning — surfaced in the cancel sheet, audited, throttled notification (24h per symbol).  The cancel ALWAYS executes.
- Integration fixes: the advisory pre-fetch is time-bounded (2.5s race) so a hung broker read can never delay the emergency cancel lever; dollar-based orders (quantity undefined) now compute remaining notionally — previously the advisory silently never fired for exactly the order type most likely to strand dust.

Integration pass (this PR's final commits) also fixed: kindStatsCache serving the stale grading-mode flavor for up to 60s after a knob flip; `raw_fallback` receipt attribution using the run filter instead of the case's own account; cost-constant desync between the API and the Results card copy; plus three missing tests (throttle-ON sizing branch, alpha no-divergence negative case, dollar-based dust).

## Decisions & Trade-offs

- Alpha grading is SPY-only (no sector benchmark map) and does not touch `performance.ts` scorecards — both deliberate deferrals per the gap analysis.
- The `signal_health` notification is force-included in enabled events (mirrors the `provider_degraded` precedent); the Settings toggle rendering-but-overridden mismatch is a pre-existing pattern shared with that precedent — deferred as its own cleanup.
- 1d observations enter signal health only once the decision case is terminal (matches the retrieval-usefulness precedent) — deferred.
- The shared `risk_advisory` notification template's "the agent is still in control" tail reads slightly off for a user-initiated cancel — shared-template wording, deferred.

## Verification State

- Per-slice: tsc clean + slice tests green + adversarial verify approved on all three (no blockers/majors; 6 minors / 5 nits — every actionable one fixed in the integration pass, the rest deferred with reasons above).
- Landing gates: `npm run lint` (errors gate), `npx tsc --noEmit`, full `npm test`, `npm run build` via `scripts/land.sh`; the required `verify` CI check re-runs all four before merge.
- This PR ships migration 74 — the first migration to deploy under the new BEGIN IMMEDIATE boot path (PR #2654), which is itself the fix for the race that failed #2652's deploy.

## Next Steps & Blockers

- Owner knobs to consider enabling: `outcomeGradingMode: 'alpha'`, `signalHealthAutoThrottle`, and the watchlist digest toggle from round 1.
- Remaining backlog (board + review doc): PIT fundamentals revision chain, lookahead-replay harness, scoped protection locks, vector-memory pruning, unified proposal scorecard, social/prediction-market sentiment, strategy overlay library, chat SSE stage events.
