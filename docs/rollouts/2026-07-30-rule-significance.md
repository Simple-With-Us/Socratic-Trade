# 2026-07-30 — Rule Significance Testing (Jesse label-permutation baseline) — KIMI

## Context & Objective

Owner-directed OSS-lessons program (`docs/oss-lessons.md`). This is **§6 slice 1 of 3**
(Jesse rule significance; slices 2–3 — TraderHarness PIT masking, qlib walk-forward — remain
planned/unassigned). The Phase 7 learning loop ingests per-thesis "track record" facts
("the X thesis is working across N lots") into learned context. Jesse's lesson: before a rule
is credited with predictive power, test whether the same trades would have done as well under a
random grouping. Without that test, a lucky streak is indistinguishable from an edge and the
LLM weighs both equally.

## Changes Made

- The track-record fact now carries one honest sentence about a **label-permutation baseline**:
  the observed bucket's mean realized `returnPct` vs the means of random same-size buckets drawn
  without replacement from the pooled tagged closed-lot history (1000 permutations, +1 p-value
  correction). Confidence scales with the result: **0.7** when the edge is unlikely to be luck,
  **0.45** when luck is not ruled out, 0.6 fallback for neutral verdicts / too-small pools.
- Touched files:
  - `src/lib/significance.ts` (NEW, pure) — `permutationSignificance` + `significancePValue` /
    `significanceSentence` / `significanceConfidence`. Injectable rng for deterministic tests;
    permutations clamped to [100, 10000]; `meaningful=false` when pool < bucket + 5 (every random
    draw would be ~the bucket, so the baseline says nothing).
  - `src/lib/post-mortem.ts` — new `poolClosedLotReturnsByThesis` (raw per-lot `returnPct` by
    thesis tag, pooled across all connected accounts, mirrors `poolThesisStats`' iteration and
    Untagged exclusion); `generateReflectionSummary` computes it and passes it to
    `writeThesisTrackRecordFacts`, which annotates the fact `value` and sets `confidence`.
  - `test/significance.test.ts` (NEW) — 15 tests.
  - Docs: this note, `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/oss-lessons.md` §6/§9.

## Decisions & Trade-offs

- **Annotation, not hard-gate**: the fact is still written when luck is not ruled out — the
  caveat is information, matching the breakers' "agent decides, logs everything" philosophy. A
  gate would silently drop real-but-unproven track records; a discounted-confidence fact lets
  the LLM weigh it.
- **Honest framing**: the sentence says "random-bucket label-permutation baseline", not Jesse's
  exact random-entry-times construction — our unit of learning is the tagged lot, not the entry
  timestamp, so the label shuffle is the faithful analog.
- **Classifier safety**: the appended sentence carries digits ONLY as the bare p-value and
  permutation count (no `%`, `$`, shares/lots/sizing cues) — test-verified that
  `classifyRiskTier` still returns "fact", so the fail-closed numeric gate can't reclassify the
  annotated fact as risk-adjacent and drop it.
- Regime lesson vectors (`writeThesisRegimeLessonVectors`) deliberately untouched in v1 — the
  per-regime buckets are thinner, and a second baseline there can ride the same module later.
- No new audit event: the annotation text inside the ingested fact is itself the receipt.
- `getClosedLotsDetailed` runs per account in the reflection path — same call pattern
  `persistExcursionsBackground` already uses; acceptable cost inside a best-effort try/catch.

## Verification State

```
npx tsc --noEmit                                   # clean
npx eslint src/lib/significance.ts src/lib/post-mortem.ts test/significance.test.ts
                                                   # 0 errors, 3 warnings (all pre-existing; HEAD had 4 — this change REDUCED warnings)
npx vitest run test/significance.test.ts test/post-mortem.test.ts --maxWorkers=4
                                                   # 22/22 passed (15 new + 7 regression)
npx vitest run --shard=1/3 --maxWorkers=8          # 1856/1856 passed
npx vitest run --shard=2/3 --maxWorkers=8          # 1760/1760 passed
npx vitest run --shard=3/3 --maxWorkers=8          # 1830/1830 passed
npm run build                                      # clean
```

Build passes; full suite 5446/5446 across 471 test files (3 shards).

## Next Steps & Blockers

- PR #2294 — auto-merge armed; merge == auto-deploy (2026-07-10 protocol).
- §6 slice 2 (TraderHarness point-in-time masking / entity anonymization for any LLM-in-the-loop
  historical evaluation) and slice 3 (qlib walk-forward discipline for auto-tune windows) remain
  PLANNED / UNASSIGNED on the effort board.
- Optional follow-up: extend the same baseline to `writeThesisRegimeLessonVectors` once per-regime
  buckets thicken; consider surfacing the significance sentence on the dashboard learning view.

## Zero-Code Findings

None — this slice shipped code.
