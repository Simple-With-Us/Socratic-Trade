# 2026-07-08 — Model rotation option: "Rotate all models (testing)"

**Agent:** Claude Code (MONET lane), branch `monet/model-rotation` off `origin/main`.

## Summary

Owner request: *"an option that rotates through all combinations of green/red team models so it
is different every time — I will choose that option for the paper account and test account."*
Purpose: accrue live comparative history across models. Attribution is automatic — proposals
already persist `proposedByModel` (the concrete serving model).

Implemented as a `"__rotate__"` sentinel model id, selectable as **"Rotate all models (testing)"**
in both Proposer/Reviewer pickers (Settings → Models and the Strategy page). At the top of every
strategy run the sentinel is replaced — on a **run-scoped** policy clone only — with the next model
from a per-(user, account, seat) round-robin over the curated catalog, restricted to models whose
provider credential actually resolves.

## How a pick works

1. `runStrategyOnce` (src/lib/strategy.ts) calls `resolveModelRotationForRun` right after the
   market-closed early-return (a skipped run doesn't consume a rotation slot) and **before** any
   budget preview or `resolveLlmEndpoint` call.
2. Eligible pool = `MODEL_ROTATION_POOL` (curated catalog in provider-interleaved order, minus
   exclusions below) filtered by `resolveLlmCredential(llmModelFamily(model), userId).key` — a
   model with no resolvable key is skipped, so rotation never injects a guaranteed-failure run.
3. Per-seat pointers persist as internal settings `model_rotation:<userId>:<accountId>:<green|red>`
   (`getInternalSetting`/`setInternalSetting`). Each rotating seat serves
   `pool[counter % pool.length]` and advances by 1; when the **green** counter wraps a full cycle,
   the **red** counter advances one **extra** step, so green/red combinations shift phase instead
   of locking into a fixed pairing (verified by test: 3-model pool produces all 9 pairs).
4. Every pick is audited: `model_rotation_pick` with `{ runId, seat, model, pointer, nextPointer,
   wrapped, poolSize, skippedNoCredential }`, account-attributed.
5. The result merges onto the run-scoped clone: `runPolicy = { ...policy, ...rotationOverride,
   ...runLlmOverride }` — the same pattern as the usage-budget downgrade. The **persisted** policy
   keeps the sentinel (so the next run rotates again), and the breaker `setPolicy` calls (drawdown
   / vol-panic) persist the pristine `policy`, so they can never overwrite the sentinel with a
   concrete model. Usage-budget preview + enforcement both evaluate the rotation-resolved view
   (the sentinel has no price entry); an enforcement downgrade intentionally WINS over the
   rotation pick.
6. Everything downstream (endpoint/transport resolution, timeouts, request building,
   `proposedByModel` stamping) sees only the concrete model.

**Exclusions from the pool** (documented in `MODEL_ROTATION_POOL`):
- `mistral-small-2603`, `mistral-medium-3-5` — broken capability map (benchmark 2026-07-08, 0/12 calls).
- `grok-build-0.1` — coding specialist; soft-timeouts as a Green strategist.

**Fallbacks:** empty eligible pool (no credential at all) or a pointer-store error → the rotating
seats substitute `DEFAULT_OPENAI_MODEL` (a normal run/normal failure, never the literal sentinel),
audited/logged.

**Safety net for non-run consumers:** `resolveOpenAiModel` (src/lib/llm-request.ts) now treats the
sentinel as unset, so anything that reads the persisted policy outside a strategy run (chat, the
outcome-engine lesson pass, strategy tuning, the run route's key precheck, ops snapshot) falls back
to the default model instead of sending `"__rotate__"` to a provider. The red seat never leaks
outside a run (`debateProposal` is only called with `runPolicy`). The AI-review panel skips the
sentinel when inheriting a reviewer model.

## Why

- Sentinel-on-policy + run-scoped substitution keeps the whole downstream stack (attribution,
  budget, timeouts) on concrete models with zero schema changes, and reuses the exact override
  pattern the usage-budget downgrade established (documented at that choke point).
- Pointer state in internal settings = durable, per-account, no new table.
- `llm-provider.ts` deliberately NOT modified (per design): rotation is resolved before endpoint
  resolution, not inside it.

## Files

- `src/lib/model-rotation.ts` — NEW: pool, pure `advanceRotationPointers`, `eligibleRotationPool`,
  `resolveModelRotationForRun`.
- `src/lib/llm-request.ts` — `LLM_MODEL_ROTATION_SENTINEL` + `isModelRotationSentinel` (leaf-module
  home, avoids import cycle); `resolveOpenAiModel` sentinel safety net.
- `src/lib/strategy.ts` — rotation resolve at run top; rotation-resolved policy into
  `previewBudgetDecision`/`evaluateBudgetForRun`; downgrade-audit `before` shows the concrete
  would-have-served models; `runPolicy` merge.
- `src/lib/types.ts` — `llmModel`/`redTeamLlmModel` doc comments mention the sentinel.
- `app/ui/llm-model-catalog.ts` — `ROTATE_ALL_MODELS_ID`/`ROTATE_ALL_MODELS_LABEL` (additive).
- `app/console/strategy/page.tsx` — rotate option in both pickers; sentinel excluded from
  custom-id handling/warning and reasoning-control derivation; rotation info note; provider label
  "Rotating (a different model each run)"; AI-review inherit skips sentinel.
- `app/console/settings/models.tsx` — additive (lane-claimed file): local sentinel const, rotate
  option on Proposer/Reviewer only (never Coach), custom-warning exclusion, rotation info note.
- `app/api/policy/route.ts` — comment only: sentinel is deliberately valid; do not add a catalog
  whitelist.
- `test/model-rotation.test.ts` — NEW: 13 tests (round-robin + wrap extra-step + phase-shift
  coverage, pool exclusions + catalog sync, credential skip, pointer persistence + audit rows +
  per-account scoping, empty-pool fallback, `resolveOpenAiModel` safety net, sentinel passes
  `PUT /api/policy`).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

```
npx tsc --noEmit          # clean
npm run lint              # 0 errors (339 pre-existing grandfathered warnings)
npx vitest run            # 295 files / 2997 tests, all green
npm run build             # run by land.sh gate (and CI verify)
```

## Follow-ups / caveats

- **Owner setup:** pick "Rotate all models (testing)" for Proposer and/or Reviewer on the paper +
  test accounts (Settings → Models or Strategy page). Each seat rotates independently; both set =
  combination coverage with the wrap phase-shift.
- A run that starts but fails before its LLM call (broker error, budget skip) still consumed a
  rotation slot — visible in the `model_rotation_pick` audit vs the run outcome; harmless for
  fairness over time.
- Pool order interleaves providers; if credentials change between runs the modulo re-maps — picks
  stay valid, the cycle just re-shapes (best-effort variety, not a strict Latin square).
- The `usage_budget_status` advisory audit and enforcement now see the rotated (concrete) models —
  intentional; the enforcement downgrade overrides the rotation pick for that run.
- **Heads-up for the stalled single-adversary lane:** `strategy.ts` changed at the usage-budget
  choke point (rotation block + `runPolicy` merge line) — rebase required.
