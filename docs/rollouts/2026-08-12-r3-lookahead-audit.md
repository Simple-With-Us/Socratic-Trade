# 2026-08-12 — r3 slice: truncated-replay lookahead audit (freqtrade lookahead-analysis port)

## Context & Objective

Round-3 slice of the external-repo lessons program.  freqtrade's lookahead-analysis re-runs a
strategy on data truncated at each decision point and flags any indicator whose value changes
when the future is removed.  The gap analysis scoped this app's port to the two subsystems that
are genuinely reconstructable point-in-time — bar-derived factor sub-scores (momentum/liquidity)
and RAG evidence retrieval — with everything else HONESTLY labeled unverifiable rather than
silently implied clean.

## Changes Made

Architecture (pure/IO split mirroring `backtest.ts`):

- **`src/lib/lookahead-audit.ts`** (new) — the audit lane.
  - `sampleDecisionsForLookaheadAudit(userId, options)`: samples up to N (default 25, knob)
    matured decisions from `signal_snapshot` audit rows via `listSignalSnapshotAuditAfter`,
    walking oldest-first from a durable per-user watermark (`internal setting
    lookahead_audit:watermark:<userId>`).  A snapshot still inside the outcome horizon
    (`addTradingDays(decisionDate, horizonDays) > today`, default 5 trading days) stops the scan
    without advancing the watermark past it.
  - Factor replay (`replayFactorFindings`, PURE): truncate the fetched daily OHLC series to
    `bar.date <= decisionDate` (`truncateBarsToDecision`), recompute the bar-derived inputs
    (technicalScore via the existing `computeTechnicals`; trailing-252-bar 52w high/low;
    decision-day bar volume), clone the persisted quote with just those replaced — mirroring the
    decision-time quote's field AVAILABILITY via per-field `sources` provenance and the persisted
    `technicalScore` — and run the existing pure `scoreFactors` (src/lib/market.ts:924).  Diff
    `momentum` and `liquidity` against the persisted subScores: `clean` within the tolerance
    knob (default 15 sub-score points), `mismatch` beyond it, `unverifiable` whenever a
    point-in-time input cannot be honestly reconstructed (no decision-day bar, no volume
    provenance, insufficient bars, missing refPrice/intraday/breakdown — each with a reason).
  - RAG evidence replay: rebuild the deterministic filings query from the persisted decision
    (`deterministicFilingsRetrievalQuery`, now SHARED with strategy.ts — see below), verify it
    against the persisted candidate pool's `queryHash` (mismatch → honest
    `query_builder_drift` unverifiable, and no budget is spent), then re-invoke
    `retrieveContextDetailed` with `asOf` pinned to the pool's stamp and `strictAsOf: true`,
    with the same floors the strategy pass uses.  Diff returned chunk ids against the persisted
    pool's `used:true` rows: Jaccard similarity ≥ knob (default 0.5) is `clean` (benign reranker
    drift); ANY used candidate or replay chunk stamped after the pin is a HARD `mismatch`
    (`post_asof_chunk_in_decision_context` / `post_asof_chunk_in_strict_replay`); a decision
    whose pool was never persisted (RAG_PERSIST_CANDIDATE_POOL off) is `unverifiable` — the knob
    is the owner's and is never forced on.
  - `value`/`quality`/`volatility`/`sentiment`/`positioning`/`diversification`: ALWAYS
    `unverifiable` with a stored `backtestSafety: "not_point_in_time_replayable"` label and a
    per-factor honest reason (volatility is recomputable only from the same persisted fields — a
    self-copy can never expose a leak, so it is not counted as verified).
  - `computeLookaheadVerdict` (PURE): the verdict floor (default 20, knob) gates ONLY the
    all-clear — any mismatch is evidence at any sample size; below the floor with no mismatch
    the aggregate is `insufficient_sample`, never an under-sampled all-clear.
  - Scheduling: durable per-user due-jobs (`db-jobs.ts`, job type `lookahead_audit`,
    cadence-grid slot ~04:47 UTC, dedupe key `<userId>-<dueDate>`), drained like
    outcome-horizons' intraday sampler (`ensureLookaheadAuditJobsScheduled` +
    `drainLookaheadAuditJobs` on the scheduler tick).  Default ON;
    `LOOKAHEAD_AUDIT_ENABLED=0/off/false/no` is the documented kill switch (one audit row per
    distinct disabled reason, r2-cold-snapshot's contract).
  - `notify()`: new `lookahead_leak` event, fired ONLY when a pass produces `mismatch`
    classifications (never on `unverifiable`), force-included in enabledEvents (signal-health
    precedent), ASCII ntfy title, advisory only.
- **`src/lib/db-lookahead-audit.ts`** (new db-* module) — CRUD for `lookahead_audit_findings`
  (migration 75 in `db.ts migrate()`): PRIMARY KEY (user_id, decision_id, factor_or_field) with
  upsert so re-runs overwrite, never duplicate; list + classification counts for the verdict.
- **`src/lib/db-learning.ts`** — `listRagCandidatePoolAudit(userId, runId, symbol)`:
  json_extract-targeted read of `rag_candidate_pool` audit rows (the audit-event helpers module
  owns audit_events reads).
- **`src/lib/rag/information-routing.ts`** — `deterministicFilingsRetrievalQuery(symbol)`
  extracted as the single source of truth for the strategy's per-symbol filings query;
  `src/lib/strategy.ts` now calls it (string unchanged byte-for-byte, so existing persisted
  queryHashes remain valid).
- **`src/lib/types.ts` / `dashboard-ui.ts` / `app/console/settings/page.tsx`** — `lookahead_leak`
  notification event type + labels/descriptions.
- **`src/lib/account-deletion.ts`** — `lookahead_audit_findings` added to
  DELETE_TABLES_BY_USER_ID.
- **`src/lib/scheduler.ts`** — ensure+drain wiring on the tick (journalLane `lookahead-audit`).
- **`app/api/lookahead-audit/route.ts`** (new) — read-only findings + full-table verdict.
- **`app/console/lib/api.ts` / `app/console/results/page.tsx`** — `fetchLookaheadAudit` +
  compact `LookaheadAuditCard` (con-* Card/Chip/con-table) under the Signal health card:
  per-decision persisted vs replayed values, delta, and the three-way classification with
  unverifiable reasons rendered plainly (sentence-length coverage-gap reasons in tooltips).
- **`.env.example`** — `LOOKAHEAD_AUDIT_*` knob documentation (enable/sample/floor/tolerance/
  jaccard/cadence/horizon).
- **`test/lookahead-audit.test.ts`** (new, 17 tests) + `test/persistence-hardening.test.ts`
  schema-version assertions bumped 74 → 75.

Exact files touched:
`src/lib/lookahead-audit.ts`, `src/lib/db-lookahead-audit.ts`, `src/lib/db.ts`,
`src/lib/db-learning.ts`, `src/lib/rag/information-routing.ts`, `src/lib/strategy.ts`,
`src/lib/types.ts`, `src/lib/dashboard-ui.ts`, `src/lib/account-deletion.ts`,
`src/lib/scheduler.ts`, `app/api/lookahead-audit/route.ts`, `app/console/lib/api.ts`,
`app/console/results/page.tsx`, `app/console/settings/page.tsx`, `.env.example`,
`test/lookahead-audit.test.ts`, `test/persistence-hardening.test.ts`, `STATUS.md`,
`docs/EFFORT-LOG.md`, this note.

## Decisions & Trade-offs

- **Inclusive truncation boundary** (`bar.date <= decisionDate`, per spec, matching the
  outcome-horizon convention): an intraday decision replayed against the decision day's FINAL
  bar carries benign same-day drift — the tolerance knob absorbs it, and sub-daily leaks are
  documented as below this audit's resolution (not claimed either way).
- **Availability mirroring over invention**: the replay clone only carries 52w/volume/technical
  inputs the decision-time quote provably had (per-field `sources` provenance +
  persisted `technicalScore`).  Anything unprovable classifies `unverifiable` — a fabricated
  clean/mismatch would be worse than an honest gap.
- **queryHash guard instead of trusting the rebuilt query**: a future wording change to the
  filings query degrades old decisions to `unverifiable` (query_builder_drift), never a silent
  false mismatch.  Multi-query/HyDE variants are not replayed (flag-gated off by default and
  LLM-dependent); the Jaccard threshold absorbs modest drift when they ran.
- **Retrieval spend discipline**: the replay retrieval only runs for a hash-matched, pinned pool
  (≤ 8 chunks, per-decision), and a budget-skipped/lookup-failed replay classifies
  `unverifiable` — the audit never forces spend and never fabricates from a failed read.
- **Verdict floor gates only the all-clear** — a mismatch is evidence at any n.
- **`signal_snapshot` rows prune at 14 days** (audit-prune observability class): the watermark
  sampler simply advances over pruned rowids; with the default weekly cadence and 5-trading-day
  maturity gate, decisions are sampled in the 7–14-day-old window before pruning.
- **Env knobs, not policy fields**: this is operator-level observability (one lane per user,
  scheduled centrally), matching the r2-cold-snapshot precedent; all knobs documented in
  .env.example with a kill switch, defaults changing no existing behavior (the lane is new and
  read-only).

## Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # node v24.19.0
npx tsc --noEmit                                     # clean
npx vitest run test/lookahead-audit.test.ts          # 17/17
npx vitest run test/persistence-hardening.test.ts test/account-deletion-coverage.test.ts  # 25/25
npx vitest run test/account-deletion.test.ts test/policy-notification-events.test.ts \
  test/backtest.test.ts test/signal-health.test.ts test/outcome-engine-due-jobs.test.ts   # 92/92
npx vitest run test/rag-information-routing.test.ts test/scheduler-cadence.test.ts        # 7/7
```

Per the slice contract, `npm run build` and the full suite were NOT run here — they run at the
round-3 integration land via `scripts/land.sh`.

## Next Steps & Blockers

- Round-3 integration lane merges the slice commits and runs the full land gate.
- Follow-ups (not this slice): persist decision-time 52w/volume raw values in CandidateEvidence
  so the liquidity/momentum replay can compare inputs (not just sub-scores); a v2 RAG replay over
  the RAG_PERSIST_CANDIDATE_POOL_FULL disposition records; surfacing the verdict on the admin
  health panel.
- Blockers: none.
