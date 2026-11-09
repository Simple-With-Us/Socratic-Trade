# 2026-07-09 — Model rotation: three codex-bot P2 fixes (PR #1117)

**Agent:** Claude Code (MONET lane, Opus), branch `monet/model-rotation` off `origin/main`.
Follows `docs/rollouts/2026-07-08-model-rotation.md` (the original rotation implementation).

## Summary

PR #1117 (the `"__rotate__"` model-rotation option) had all CI checks green and auto-merge armed;
the only blocker was three unresolved codex-bot review threads (the repo enforces
`required_conversation_resolution`). All three were confirmed real against the current code and
fixed in ONE batch to avoid the codex re-review loop.

## The three fixes

### Finding 1 — tuning reviewer ignored the rotation-sentinel fallthrough
`src/lib/strategy-tuning.ts`, `policyForTuningReviewer`. It did
`policy.redTeamLlmModel?.trim() || policy.llmModel?.trim()`, so when `redTeamLlmModel === "__rotate__"`
the reviewer model became the raw sentinel → `resolveLlmEndpoint`/`resolveOpenAiModel` maps it to `""`
→ the LLM tuning review silently degraded to `localRulesProposal`, even though the Strategy page's
`AiReviewPanel` computed `inheritedReviewerModel` by SKIPPING the sentinel and promised a Green-model
review. The same degradation hit `evaluateAutonomousWeightTuning`/apply/dryRun (they resolve through
the same helper with no override).

**Fix:** made `policyForTuningReviewer` sentinel-aware (imports `isModelRotationSentinel` from
`./llm-request`) — an explicit override is ignored if it is the sentinel, and the team-model
inheritance picks the first CONCRETE (non-sentinel) of `[redTeamLlmModel, llmModel]`. When BOTH seats
are `"__rotate__"`, no concrete model is found and the existing downstream `!llmModel` gate honestly
falls to local rules (correct under no-defaults). Centralizing here mirrors the panel's logic and
fixes every caller at once.

### Finding 2 — lesson pass could POST an empty model
`src/lib/outcome-engine.ts`, `callLessonLlm`. Guard was `if (!key) return undefined;`. This job runs
outside a strategy run and re-reads the persisted (sentinel-bearing) policy, so `resolveLlmEndpoint`
returns model `""` while the key is present → it built a request body with `model: ""` and every
post-mortem lesson call 400'd.

**Fix:** `if (!key || !model) return undefined;` with a comment that a blank model (no-defaults /
rotation-sentinel `""`) is treated as unconfigured and skipped cleanly — same contract as
strategy-tuning's local-rules gate. Also fixes the pre-existing un-migrated no-model case.

### Finding 3 — rotation pointer advanced on aborted/skipped runs
`src/lib/model-rotation.ts` (`resolveModelRotationForRun`) + `src/lib/strategy.ts` (call site).
It did `setInternalSetting(pointer)` + `audit("model_rotation_pick")` at RESOLUTION time — upstream of
account validation (`if (!selected) throw "Selected account is not available."`) and the usage-budget
SKIP gate. A run aborting there burned a rotation slot and logged a phantom pick with no
`proposedByModel` to match → uneven sampling + misleading audit. (This is exactly the caveat noted in
the original rollout note, lines 105-107 — now resolved.)

**Fix (resolve early, commit late):** `resolveModelRotationForRun` still reads counters and computes
the picks EARLY (so the budget preview/enforcement keep pricing the concrete models via
`rotationOverride`), but the per-seat `setInternalSetting(nextPointer)` writes AND the per-seat
`model_rotation_pick` audits are deferred into a returned `commit: () => void`. The empty-pool and
catch/error branches return a no-op `commit` (no pointer to advance; their diagnostic audits stay
inline). `strategy.ts` destructures `{ commit: commitRotation, ...rotationOverride }` (keeping
`rotationOverride` usable in the budget-preview spreads) and calls `commitRotation()` at the point the
run is committed to invoking the LLM — after account validation and every usage-budget skip gate,
immediately before the Green `proposeTrades` call. A run that throws/returns/skips before that point
never advances the pointer. Per-account run locks serialize same-account runs, so read-early /
commit-late has no TOCTOU.

## Files

- `src/lib/strategy-tuning.ts` — `isModelRotationSentinel` import; sentinel-aware `policyForTuningReviewer`.
- `src/lib/outcome-engine.ts` — `callLessonLlm` guard now skips on a blank model; exported for a focused test.
- `src/lib/model-rotation.ts` — `resolveModelRotationForRun` returns `{ llmModel?, redTeamLlmModel?, commit }`;
  pointer advance + pick audit deferred into `commit`; header + fn docs updated for commit-late.
- `src/lib/strategy.ts` — destructure `commitRotation`; call it immediately before `proposeTrades`.
- `test/strategy-tuning.test.ts` — NEW test: `redTeamLlmModel="__rotate__"` + concrete `llmModel` + no
  override → reviewer uses the concrete Green model (`generatedBy: "llm"`, fetch model `gpt-5.5`), not local rules.
- `test/outcome-engine.test.ts` — NEW test: `callLessonLlm` returns undefined and makes NO fetch when the
  model resolves empty but a key is present.
- `test/model-rotation.test.ts` — updated existing tests for the `commit` field + commit-late; NEW tests:
  resolve does NOT persist the pointer/audit until `commit()`; an aborted run (no commit) leaves the counter unchanged.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`, this note.

## Verification

```
npx tsc --noEmit          # clean
npm run lint              # 0 errors (367 pre-existing grandfathered warnings; none in touched files)
npm test                  # 306 files / 3168 tests, all green
npm run build             # clean
```

Then `bash scripts/land.sh` (merges origin/main, re-gates tsc/test/build, pushes the existing branch;
#1117 stays open with auto-merge armed).

## Follow-ups / caveats

- The original note's "run consumed a rotation slot on failure" caveat (lines 105-107) is resolved by
  Finding 3 — a run only advances the pointer once it reaches the Green LLM call.
- Revalidation of pending proposals (`revalidatePendingProposals`) still runs on `runPolicy` (rotation
  models merged in) but does NOT commit the pointer — intentional: it re-checks existing proposals and
  stamps no new `proposedByModel`, so it must not consume a rotation slot.
