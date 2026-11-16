# 2026-08-06 — Representation-weighted model rotation ("__rotate__")

## Context & Objective

Owner request (verbatim): "make it twice as likely to pick a model that is
underrepresented in our statistics as the chance it picks a model that is
overrepresented (which can still happen)." The `__rotate__` sentinel previously
resolved via a per-seat round-robin pointer (persisted internal-settings
counters), which serves models uniformly regardless of how much attributed
history each model has actually accrued (aborted runs, models added to the pool
late, and seat asymmetries all skew real representation). This change makes the
rotation pick itself representation-aware.

## Changes Made

**Design**: the pick in `resolveModelRotationForRun` is now a proportional
(weighted) random sample over the eligible pool instead of a round-robin
pointer walk:

- **Representation source**: the rotation's own dedicated history — committed
  `model_rotation_pick` audit events for the same (user, account, seat) over a
  trailing 30-day window (`ROTATION_REPRESENTATION_WINDOW_DAYS`; safely inside
  the 90-day audit retention in `src/lib/audit-prune.ts`). Reads are ADVISORY:
  any read error degrades that seat to uniform sampling rather than failing
  the rotation.
- **Weighting rule** (`rotationRepresentationWeights`, pure): candidates with a
  representation count BELOW the median of the candidate set get weight 2;
  at-or-above-median get weight 1; zero-usage candidates are maximally
  underrepresented and ALWAYS get weight 2 (even when the median is 0, e.g.
  counts [0, 0, 5]). Empty stats degrade to uniform. Sampling is proportional
  to weights (`weightedRotationPick`, pure) — so an underrepresented model is
  twice as likely as an overrepresented one, which can still be picked
  (weight 1, never 0).
- **Determinism for tests**: `resolveModelRotationForRun` accepts an injectable
  `random?: () => number` (defaults to `Math.random`); out-of-range RNG output
  is clamped defensively.
- **Preserved invariants**: eligible-pool filtering (credential resolution +
  OpenRouter `/models/user` availability) is untouched; commit-late semantics
  are unchanged — and now the committed pick audit IS the representation
  ledger, so an aborted run writes nothing and never skews the weights
  (Finding 3 analog); the same-model guarantee across seats is kept (red
  samples from the pool minus green's pick, pool >= 2); fail-closed empty-pool
  / storage-error behavior (`""`, never the sentinel) is unchanged; rotated
  seats still auto-carry the served model's recommended reasoning effort.
- **Removed**: `advanceRotationPointers`, `RotationSeatPick`,
  `RotationAdvance`, and the `model_rotation:<user>:<account>:<seat>`
  internal-settings pointer reads/writes (legacy rows are inert; the
  account-deletion cleanup in `src/lib/db.ts` still recognizes the prefix).
  Audit payload now carries `weight` + `representation` instead of
  `pointer`/`nextPointer`/`wrapped`.

Touched files:

- `src/lib/model-rotation.ts` — the change itself.
- `test/model-rotation.test.ts` — pure weight/sampling tests (incl. seeded-RNG
  ~2:1 distribution sanity and the empty-stats case), commit-late/abort tests
  rewritten on the uniform-vs-weighted boundary trick, per-account/per-seat
  scoping test.
- `src/lib/strategy.ts` — call-site comments only (no behavior change).
- `src/lib/types.ts`, `app/ui/llm-model-catalog.ts` — doc comments.
- `app/console/strategy/page.tsx` — the two user-facing copy strings that
  described round-robin now describe the 2x weighting.
- `docs/trading-framework.md` — rotation paragraph updated.

## Decisions & Trade-offs

- **Rotation-pick audits over `llm_usage`** as the representation source: they
  are the dedicated rotation history, already scoped per seat/user/account and
  written commit-late (only for runs that actually served the LLM), so aborted
  runs cannot skew weights. `llm_usage` mixes chat/coach/tuning contexts and
  counts calls, not runs.
- **Median split, not continuous weighting** — exactly what the owner asked
  for (2x vs 1x), simple to audit, no tunables.
- Models outside the current eligible pool are ignored when counting, so a
  model that left the pool cannot shift the median for the survivors.
- The strict "one full cycle serves every model exactly once, in pool order"
  property is deliberately gone — that is the point of the change. Long-run
  coverage is now statistical (every model keeps nonzero weight).
- No DB migration; no new table. Stale pointer settings rows are left in place
  (harmless; still covered by account-deletion cleanup).

## Verification State

```
npx tsc --noEmit                                  # clean
npx vitest run test/model-rotation.test.ts        # 20/20 passed
npx vitest run test/account-deletion.test.ts test/console-red-team-labels.test.ts \
  test/llm-request.test.ts test/outcome-engine.test.ts \
  test/strategy-run-once-async-route.test.ts test/strategy-tuning.test.ts   # 85/85 passed
npm run lint                                      # 0 errors (728 grandfathered warnings)
```

Full `npm test` / `npm run build` deliberately left to the landing operator
(per the orchestrating workflow's instruction).

## Next Steps & Blockers

- Landing operator: run the full gate (`npm run lint` + `npx tsc --noEmit` +
  `npm test` + `npm run build`) and land via `scripts/land.sh`.
- Optional follow-up: surface `weight`/`representation` from the pick audit in
  the model-stats drawer so the owner can see the weighting working.
