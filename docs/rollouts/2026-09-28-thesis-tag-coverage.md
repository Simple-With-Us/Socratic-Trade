# Thesis-tag coverage: the three hold-out tags, ruled on (P0-2 follow-up)

Branch `minimax/thesis-tag-coverage` (worktree `~/apps/st-mm-thesis-tags`, based on `origin/main` @ `006bbb6cb`).
Seat: MINIMAX.  Started 2026-09-28.  Follows `docs/rollouts/2026-09-27-outcome-closure.md` §3.

## 1. Context & Objective

PR #3914 made `tradeThesisTag` deterministically assigned rather than model-chosen, because every
realized-performance mechanism keys on that label: the sizing multiplier, the negative-expectancy
skip, and the thesis scorecards.  The scorer shipped emitting six tags and **abstaining** on the
other three — `Mean-Reversion`, `Defensive-Rotation` and `Analyst-Revision` — because the first
implementer could not derive them from computed evidence and chose not to guess.  That leaves the
self-grading problem alive for exactly the theses most likely to be wrong, which is the worst place
to leave it.

The owner delegated the call: **make all three derivable from evidence the code already computes, or
rule them out — do not leave them model-assigned.**  This note records the per-tag ruling, the
evidence behind it, and what was found when the "no evidence exists" premise was checked.

## 2. Changes Made

- `src/lib/strategy-prompts.ts`
  - `Mean-Reversion` and `Defensive-Rotation` rules added to `assignDeterministicThesisTag`.
  - `Analyst-Revision` removed from `THESIS_PLAYBOOK`; `RETIRED_THESIS_TAGS` and
    `isSelectableThesisTag` added so the retirement is a documented, testable fact, and
    `filterRepairedProposals` now asks that one question instead of re-deriving it.
  - Evidence interface extended with `beta`, `technicalSignals`, `technicalDirection`,
    `pricePosition52w` — all already on the scan candidate, none newly collected.
  - Tunables `defensiveBeta` (0.8) and `meanReversion52wPct` (30) added, both env-overridable with
    the same fail-safe parsing as the existing four.
  - `STRATEGY_PROMPT_VERSION` → `agentic-strategy@2.20.0` (the playbook guide is interpolated into
    the Bull system prompt, so removing a tag IS a prompt change).
- `src/lib/indicators.ts` — `TECHNICAL_SIGNAL_RSI_RECLAIM_OVERSOLD` exported as the single
  definition of the name the scorer matches, and used at the push site.  A rename on either side now
  fails a test instead of silently no-op'ing.
- `src/lib/strategy.ts` — the four new fields threaded at the one scoring seam.
- `test/thesis-tag-deterministic.test.ts` — the "three tags that must NEVER be invented" block
  replaced with real coverage of both new rules, including a falling-knife case.
- `test/thesis-tag-retired-tags.test.ts` (new) — the retirement's consumer contract.
- `test/strategy-prompt-safety.test.ts` — prompt-version pin.

## 3. The ruling, tag by tag

| tag | ruling | rule | evidence |
| --- | --- | --- | --- |
| `Mean-Reversion` | **derivable** | gated on the `rsi_reclaim_oversold` event + a non-bearish read + `pricePosition52w ≤ 30`; score `60 + min(20, 30 − pos52w)` | `src/lib/indicators.ts:266-271` |
| `Defensive-Rotation` | **derivable** | gated on `0 < beta ≤ 0.8`; score = the `volatility` factor | `src/lib/market.ts:1941-1951` |
| `Analyst-Revision` | **retired** | — | `src/lib/types.ts:2161-2168` |

### 3.1 Mean-Reversion — the evidence was there; the first pass read the wrong field

The first implementer's note said this tag "needs 'price is extended from its reference', which no
computed field states", and pointed at `technicalSignals` as "a free-form string[] whose vocabulary
is open-ended, so substring-matching it would encode a guess as a rule".

Both halves of that are worth answering precisely, because the conclusion was right and the
reasoning was not quite.

**The reference exists.**  `pricePosition52w` (`src/lib/market.ts:1893`) is the price's position in
its trailing 52-week band, 0 at the low and 100 at the high.  It is exported, already imported into
`strategy.ts:50`, and is the same input `momentumScore` blends.  Re-deriving it at the seam costs
nothing and persists nothing.

**The reversion exists, and it is NAMED, not free-form.**  `computeTechnicals` already emits
`rsi_reclaim_oversold` when RSI-14 crosses back **up** out of oversold (`src/lib/indicators.ts:269-271`).
That is the reversion event itself, produced by the app's own indicator module.  The scorer matches
that exact name against the constant the producer pushes — an enum lookup, categorically different
from searching free text for the concept.

The "open-ended vocabulary" caveat is real but lands somewhere narrower than it first appears.  The
**computed** path emits a closed six-name set.  The **TradingView push** path does not:
`src/lib/web-sources/technical.ts:184` stores `String(payload.signal)` verbatim from the webhook
body.  So an exact-name match can in principle be fed a string that is not an oversold reclaim.  That
is a trust question about a secret-gated webhook that places no orders, and the blast radius is one
proposal's scorecard bucket — but it is why the rule does not rest on the name alone.

**The falling-knife separation, which the first pass said did not exist, does exist.**  The level
nudge at `indicators.ts:266` is guarded by `!downTrend`, but the *event push* at line 269 is not — so
`rsi_reclaim_oversold` fires on a dead-cat bounce inside a persistent downtrend too.  A second
condition is required to reject that, and the app already computes it: `technicalDirection`, which
`indicators.ts:294` derives from the composite score (bearish at ≤ 40).

**Why "no longer bearish" and not "bullish" — measured, not guessed.**  Driving real bar series
through `computeTechnicals` gives:

| shape | `technicalScore` | `direction` | reclaim event |
| --- | --- | --- | --- |
| 20 bars down, +2% bounce | 36 | bearish | yes |
| 20 bars down, +4% bounce (MACD turns) | 56 | neutral | yes |
| 25 bars down, +6% bounce | 67 | bullish | yes |

Requiring `bullish` would demand the +6% case only, and a bottoming name is not yet in an uptrend —
that is what the thesis *is*.  "No longer bearish" is the app's own neutral boundary and it sits in
the real gap between the knife population (36) and the turn population (56, 67).  A test drives all
three shapes through the real producer and pins the split.

### 3.2 Defensive-Rotation — no new definition was needed

"Defensive" needed a definition, and the app already had one it was not using as a label.
`volatilityScore` (`src/lib/market.ts:1941-1951`) is commented "Higher = steadier (less realized +
systematic volatility)", starts from `100 − |intradayChangePct| × 12`, and applies a beta ladder:
`> 1.5 → −15`, `> 1.1 → −6`, `< 0.8 → +6`.  That ladder *is* a defensiveness classification, already
computed, already 0–100.

So the rule is the app's own ladder used as a gate (`0 < beta ≤ 0.8`) with its own steadiness factor
as the score, which keeps the tag on the same scale — and therefore the same neutral floor and
margin — as the other seven.

**The beta gate is load-bearing, not decoration.**  `volatilityScore` is *maximum* on a quiet tape,
and a name with no fresh quote (pre-market scan, stalled feed, a symbol the provider did not return)
scores exactly that maximum.  Scoring the factor alone would hand `Defensive-Rotation` to every
unmeasured name.  `beta` is a real fundamentals field that is usually absent rather than zero, so
requiring it to be present keeps absence reading as absence.  `beta ≤ 0` is treated as absent for
the same reason.

### 3.3 Analyst-Revision — retired, not derived

A revision is a **delta** in an analyst's rating.  Every analyst field the scan computes is a level
or a point-in-time snapshot:

- `analystScore` / `analystRating` — a consensus level (`src/lib/data-providers.ts:1045`).
- `analystBySource` — `{ score, label, counts?, mean?, upstreamFamily? }`
  (`src/lib/types.ts:2161-2168`).  Cross-provider dispersion, with **no timestamp and no prior
  value**, so it cannot express "changed" either.
- `targetMean` / `targetHigh` / `targetLow` / `targetMedian` — price targets.  Target-vs-price is
  upside, which is a level.

There is no upgrade/downgrade/revision field anywhere in the schema, and no rating history to
difference.  A rule that emitted this tag would have to map one of the levels onto "revision", which
redefines the tag rather than labelling it — and the performance report already has a row for
`Analyst-Revision` (-$51.74 over one lot, `docs/reviews/2026-09-25-trading-performance-report.md:52`),
so silently changing what the bucket means is not a theoretical risk.

Retiring it is the honest outcome.  **No tag remains in the playbook that the model alone can choose
on an opening**; `Risk-Exit` is the only other non-rule tag and it is assigned on the exit path,
which the openings-only rule never scores.

## 4. What retirement does and does not do — and why the blast radius is bounded

Retiring a tag is only safe if a CLOSED LOT that already carries it keeps its whole feedback
mechanism.  The blast radius was enumerated before the change, not after:

| consumer | mechanism | retired tag | pinned by |
| --- | --- | --- | --- |
| schema enum (`strategy.ts:6229`) | built from `THESIS_PLAYBOOK` | can no longer be emitted | retirement test §1 |
| `filterRepairedProposals` (`strategy.ts:7287`) | `isSelectableThesisTag(tag)` | a repaired reply carrying it is DROPPED | retirement test §2 |
| `getThesisScorecard` (`performance.ts:780`) | buckets by the tag string **actually stored** | keeps its own bucket | retirement test §3 |
| `shouldSkipNegativeExpectancy` (`strategy-risk.ts:231`) | `scorecard.find(s => s.thesisTag === tag)` | keeps its skip gate | retirement test §3 (via `selectThesisStat`) |
| `applyDeterministicSizing` (`strategy-risk.ts:502`) | same `selectThesisStat` join | keeps its size multiplier | retirement test §3 (via `selectThesisStat`) |
| `thesisTagLabel` (`app/console/lib/labels.ts:32`) | Title-Case over any string | renders unchanged | — |
| `report-renderer` (`report-renderer.ts:105`) | interpolates any string | renders unchanged | — |

`selectThesisStat` is exported and takes a hand-built scorecard, so one test covers both feedback
consumers.  Nothing anywhere enumerates the playbook to build a report or a rollup, so there was no
enum-driven list to update.

Nothing is backfilled.  A stored `tradeThesisTag` keeps whatever it had.

## 5. Decisions & Trade-offs

- **`Analyst-Revision` retired rather than re-derived.**  The alternative — renaming the concept to
  "high analyst consensus" and keeping the old name — would have preserved the row count and quietly
  invalidated every number ever reported under it.
- **The mean-reversion floor (52-week position ≤ 30) is a stated choice, not a mirrored threshold.**
  It is the one new constant in this change that does not copy an existing one.  It is env-tunable
  for the same reason the other five are.
- **`Defensive-Rotation` scores the raw `volatility` factor, whose baseline runs higher than the
  other factors'** (it is `100 − |move|`, so a quiet name sits near 100 where momentum sits near 50).
  It therefore wins more often than a typical factor rule.  That is deliberate and not a
  back-door size path: the sizing multiplier and the expectancy skip read the tag's *realized*
  performance, so an over-assigned tag is measured sooner, not rewarded.  If the distribution turns
  out to be lopsided, the fix is the env-tunable beta gate, not a change to the feedback loop.
- **A TradingView push could in principle forge the reclaim signal name** (§3.1).  Accepted: the
  webhook is secret-gated, places no orders, and the worst case is one proposal's scorecard bucket.
  Recorded rather than silently ignored.

## 6. Verification State

- `npx tsc --noEmit` — clean, exit 0.
- `npx vitest run test/thesis-tag-deterministic.test.ts test/thesis-tag-retired-tags.test.ts` —
  2 files, **52 passed**.
- `npm test` — full suite, recorded in §7.
- `npm run lint` — 0 errors.
- **FAILING-FIRST PROVEN:** with the three source files reverted to `origin/main` and the new tests
  kept, the pair fails; restored, it passes.

## 7. Item status

| Item | Status |
| --- | --- |
| `Mean-Reversion` derivation | **landed** |
| `Defensive-Rotation` derivation | **landed** |
| `Analyst-Revision` retirement + consumer contract | **landed** |
| Full-gate result | see PR |
