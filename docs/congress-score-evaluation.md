# Congress.Trade composite scoring and evaluation

Status: implemented in App B as a flag-gated, additive research signal layer. When
`CONGRESS_ANALYTICS_ENABLED` is on, the score can affect Market Scan candidate context and the strategy
prompt; it does not place orders by itself and must not drive sizing or live-trading trust until the
historical and forward gates below pass.

## Scoring system

`src/lib/congress-score.ts` computes a direction-aware composite:

- `conviction` (25%): App A `convictionScore` when present; otherwise a modest inferred directional
  value from net flow/sentiment.
- `consensus` (20%): member breadth and cluster-buy breadth.
- `memberSkill` (20%): App A per-member realized alpha rank (`topMemberScore`) when available,
  **preferring filing-date (copy-trade) excess vs S&P**, falling back to trade-date timing skill,
  then activity prominence. Raw `avgExcess` / `winRate` / `scoredCount` are also stored on quotes
  and `signal_snapshot` evidence (not only the rank).
- `flow` (15%): estimated net dollar flow, then net sentiment, then raw congressional net signal.
- `freshness` (10%): disclosure-recency decay from `lastDisclosedAt`; missing disclosure dates do not
  receive trade-date credit.
- `coverageQuality` (10%, code field `confidence`): coverage score from conviction availability, trade
  count, member count, member score, cluster flag, and disclosure date. This also gates the final score:
  thin signals can still be retained as evidence, but they cannot receive a high actionable score from
  one strong-looking input.
- `committeeOverlapContext` (0%, code field `conflictContext`): committee/sector overlap count is
  preserved as context, not scored as alpha until validated separately. It is not an accusation, legal
  conclusion, or standalone trade reason.

Outputs:

- `score`: 0-100 strength.
- `direction`: `BUY`, `SELL`, or `NEUTRAL`.
- `signedScore`: positive for BUY, negative for SELL.
- `confidence`: 0-1 coverage confidence used to cap the final score.
- `components` and `provenance`: compact explainability for audits.
- `version` and `weights`: a score-version marker and the hand-set research weights.

`market.ts` uses only BUY scores as long-side outlier candidates. SELL scores are preserved as signed
evidence for learning and future bearish/short research, but they do not create long candidates.

The score is heuristic signal strength, not probability, expected return, investment advice, or evidence
of wrongdoing.

## Forward measurement

Every market-scan candidate can now carry:

- `congressCompositeScore`
- `congressCompositeSignedScore`
- `congressCompositeDirection`
- `congressCompositeConfidence`
- `congressCompositeComponents`
- `congressCompositeProvenance`
- `congressCompositeVersion`
- `congressCompositeWeights`
- `preCongressScore`

`buildCandidateEvidence()` stores the score/direction/components/provenance in `signal_snapshot`, so future closed lots and
skipped-name counterfactuals can be evaluated point-in-time. `getSignalEfficacy()` now adds a
`Congress.Trade BUY signal at entry` bucket for chosen long trades with BUY score >= 60.

Run forward evaluation from matured snapshots:

```bash
npm run eval:congress-score
```

Useful options:

```bash
npm run eval:congress-score -- --horizon-days 63 --audit-limit 2000 --quantiles 5 --placebo-seed 17
```

The command exits `2` when the go/no-go gate fails, so it can be used in manual release checks without
being part of normal CI yet.

## Historical evaluation

The signal should be evaluated before any portfolio P&L claims. Use `src/lib/congress-score-eval.ts`
metrics:

- rank IC: per-date Spearman correlation of signed Congress score vs forward excess return.
- marginal IC: same idea after residualizing both score and return against `preCongressScore`, not the
  post-overlay score. Rows without an explicit `preCongressScore` or
  `baselines.appBPreCongressScanScore` are excluded from marginal IC rather than falling back to a
  possibly contaminated final score.
- quantile spread: top score bucket minus bottom score bucket forward return.
- top-bucket hit rate: share of top-bucket rows with positive forward excess return.
- placebo: deterministic within-date score rotation. Real IC should beat placebo IC.
- minimum sample gates: default at least 500 observations, 60 dates, 50 tickers, 10 names/date, and
  100 top-bucket rows.

Go/no-go gate:

- sample-size gates above must pass.
- benchmark/excess-return coverage must be present unless explicitly running an exploratory raw-return
  check with `--allow-raw-returns`.
- rank IC must be positive.
- rank IC t-stat must be at least 2.
- top-minus-bottom quantile spread must be positive.
- placebo IC must be lower than real IC.

## Whole-pipeline evaluation

Congress should remain a small advisory feature inside the broader app. Passing the score-level IC gate
is not enough to promote it into sizing or trust. After the PIT export works, run separate ablations for:

- candidate inclusion: normal scan vs Congress overlay disabled;
- deterministic rank: final rank before/after Congress context, with `preCongressScore` preserved;
- LLM choice: whether Congress-only outlier candidates are selected more often and whether those selected
  names outperform skipped Congress candidates;
- policy/risk pass-through: whether Congress context changes blocks, dollar amount, or confidence;
- realized/forward P&L: net of slippage, turnover, drawdown, and sector/liquidity/market-cap exposure;
- bearish avoidance: SELL scores as avoided-long or future short-research evidence, measured separately
  from BUY top-bucket lift.

Additional fields to add to future `signal_snapshot` evidence:

- `includedByCongress`
- `rankBeforeCongress`
- `rankAfterCongress`
- `scoreBeforeCongress`
- `finalDecisionInfluence`
- `congressOnlyOutlier`

Historical export mode:

```bash
npm run eval:congress-score -- --input congress-score-export.jsonl
```

The input can be either flat rows or Congress.Trade PIT rows from
`/api/export/congress-pit-scores`; App B reads nested `labels.horizons[]` for the selected
`--horizon-days` value and maps only `baselines.appBPreCongressScanScore` / `preCongressScore` into
marginal-IC baselines. If a Congress.Trade response envelope includes
`validationReadiness.historicalValidationReady=false`, App B refuses to evaluate it and exits `2`.
This is deliberate: `scoreInputsPitSafe=true` can be useful for research plumbing while
`historicalValidationReady=false` still means the export cannot support validation claims. PIT rows are
intentionally stricter than flat rows:

- `asOf`, `disclosureAvailableAt`, or `marketAvailableAt` is the observation date; trade-date `date`
  fields are ignored for PIT rows.
- row-level `pitValidity.scoreInputsPitSafe=false` or
  `pitValidity.historicalValidationReady=false` causes the row to be dropped.
- `dataCutoffAt` must not be after `asOf`.
- the selected horizon label must exist, and its `entryDate` must be on or after the availability date.
- when `labels.horizons[]` exists, top-level `forwardReturn` / `return` values are ignored so the
  selected horizon cannot be bypassed.
- each row must provide `signedScore` or `direction`; App B will not assume a positive direction.
- if `memberSkill.skillScore > 0`, `memberSkill.skillAsOf` and `memberSkill.skillScoredThrough` must
  be present and not after `asOf`.
- explicit `excessReturn` / `forwardExcessReturn` counts as benchmark-covered even when no separate
  `benchmarkReturn` is present.

Accepted row fields:

```json
{
  "date": "2024-05-10",
  "symbol": "NVDA",
  "congressScore": 83,
  "congressSignedScore": 83,
  "congressDirection": "BUY",
  "forwardReturn": 0.18,
  "benchmarkReturn": 0.04,
  "preCongressScore": 71
}
```

Aliases are accepted: `ticker`, `compositeScore`, `signedScore`, `direction`, and `spxReturn`/
`marketReturn`. `scanScore`, `marketScore`, and generic `score` are deliberately not accepted as
marginal baselines because they are too easy to confuse with post-Congress App B scores.

## App A data contract to request

Ask Congress.Trade for a point-in-time export, not a current-state leaderboard. Required:

- One row per ticker/date decision point, using disclosure availability date, not trade date.
- `ticker`, stable security id/CUSIP when available, ticker-map version, asset type, and
  delisting/ticker-change handling.
- `asOf`/`date` as the market-available disclosure timestamp, plus `computedAt` and `dataCutoffAt`.
- `direction`, `congressScore`, `signedScore`, score components, weights, provenance, fallback flags,
  and raw component inputs.
- Forward returns for 1/3/6/12 months, excess vs S&P, using split/dividend-adjusted total-return closes.
- Existing App B baseline/context score if App A has it; otherwise App B can add baseline from its
  own `signal_snapshot` only for forward runs.
- A stable `scoreVersion` and parameter manifest.
- Placebo-friendly fields: raw member/filer ids may be hashed, but stable identity must be present so
  App A can produce shuffled-member null exports.
- Member skill fields split by filing-date basis vs trade-date basis, buy vs sell direction, and 1/3/6/12m
  horizon: `filingAlpha`, `tradeAlpha`, `decayRatio`, `skillAsOf`, `skillScoredThrough`, training
  window, horizon weights, `scoredCount`, shrinkage prior, dispersion/winsorization method, and whether
  the member component is true skill or activity prominence fallback.
- Included disclosure ids with disclosure URL/source, `filed/disclosedAt`, `txDate`, side, amount range,
  owner, chamber, amendment/cancel flags.
- Disclosure latency fields, including trade-to-file lag and each member's filing-latency distribution.
- Cluster fields for both 21d/1m and 63d/3m windows, including directional distinct-member counts,
  quality-weighted cluster score, agreement ratio, party/chamber breadth when available, and per-member
  caps/diminishing-return assumptions.
- Committee-sector overlap fields must include committee, sector, mapping version, confidence, and
  `legalConclusion:false`.

Nice to have:

- per-member skill inputs used at that date, with shrinkage and `scoredCount`;
- owner type, new-position/add/trim status, asset/leverage type, and amount bucket normalization metadata;
- committee-sector overlap count and mapping;
- `dataCutoffAt`/`computedAt` timestamps.

Null/placebo tests to request from App A:

- within-date score permutation;
- member/filer shuffle preserving date, ticker, side, and amount;
- disclosure-date jitter/lag placebo;
- BUY/SELL direction flip;
- component ablations: no member skill, no freshness, no flow, activity-only member proxy;
- future-shift leakage detector;
- split/dividend-event stress subset.

Do not accept whole-history member skill recomputed with future outcomes as a backtest input. Member
skill must be computed point-in-time, using only disclosures whose evaluation horizon had matured before
the scoring date.
