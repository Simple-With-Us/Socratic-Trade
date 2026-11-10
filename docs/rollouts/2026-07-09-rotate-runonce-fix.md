# 2026-07-09 — Make "__rotate__" work for manual Run-once (+ same-model pairing fix)

Owner-directed (CLAUDE, branch `claude/rotate-runonce-fix`). Three fixes, one commit.

## Summary

1. **Run-once route precheck vs rotation (the owner-visible bug).**
   `POST /api/strategy/run` prechecks the PERSISTED policy through
   `resolveLlmEndpoint`, where `resolveOpenAiModel` deliberately treats the
   `"__rotate__"` sentinel as unset (the `llm-request.ts` safety net for non-run
   consumers) → model `""` → 412 `LLM_MODEL_REQUIRED_STRATEGY_MESSAGE`. So manual
   Run-once ALWAYS blocked under rotation, even though `runStrategyOnce`
   (`src/lib/strategy.ts:372`) resolves the sentinel to a concrete model at the top
   of every run — which is why scheduled runs worked. Fix: when
   `isModelRotationSentinel(policy.llmModel)`, the route now gates on
   `eligibleRotationPool(userId).pool.length > 0` instead — non-empty means some
   concrete, credential-resolvable model will serve the run, so it goes through;
   empty → 412 with a new actionable message naming rotation
   (`LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE` in `src/lib/llm-required.ts`). A
   RED `"__rotate__"` gets NO 412, same as a blank red model (red failures route
   per-opening to human approval — documented in the route).
   `resolveOpenAiModel` / `resolveLlmEndpoint` are unchanged.

2. **Client 412 title split (`classifyRunFailure`, chrome.tsx).** Every 412 was
   titled "No LLM key is configured" even when the server message was the
   model-CHOICE message — exactly what confused the owner (keys were fine).
   The mapping now matches the server's own strings (constants imported from
   `src/lib/llm-required.ts`, which is client-safe/pure per its header):
   `LLM_MODEL_REQUIRED_STRATEGY_MESSAGE` → title "Choose your team models",
   fixHref `/console/settings#models-green` (the model-picker anchor that exists in
   `app/console/settings/models.tsx`; the settings page's hash-scroll effect
   handles any element id). Key-missing messages keep the existing title/route;
   added `"provider key"` to the key-branch substring matches so the new rotation
   empty-pool message maps to the key title even if the HTTP status is lost.

3. **Same-model pairing under dual rotation (`advanceRotationPointers`).** When
   BOTH seats rotate, both counters start at 0, so proposer and reviewer served
   the SAME model every run for the entire first cycle (pairings only de-phased
   after the first green wrap). Now, when both seats rotate and the pool has >= 2
   models, if red's slot would equal green's pick, red consumes the NEXT slot
   (`pool[(pointer + 1) % n]`) and its counter continues past the consumed slot —
   a run never serves the same model to both seats. Monet's green-wrap extra
   advance (combination variation) stacks on top unchanged. Module doc comment +
   function JSDoc updated. Degenerate case: a 1-model pool still serves the same
   model to both by necessity (skip requires n >= 2).

## Why

Owner selected the rotation option and manual Run-once refused with a misleading
"No LLM key is configured" sheet. Root causes were (a) the precheck resolving the
persisted sentinel as "no model", (b) the client collapsing every 412 onto the
key title, and (c) — found while in the module — dual rotation degenerating to
self-debate (same model as both proposer and reviewer) for a full first cycle.

## Files

- `app/api/strategy/run/route.ts` — rotation-aware precheck branch.
- `src/lib/llm-required.ts` — new `LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE`.
- `app/console/components/chrome.tsx` — `classifyRunFailure` model-choice vs
  key-missing title split (+ constant import).
- `src/lib/model-rotation.ts` — same-model skip in `advanceRotationPointers`;
  doc comments.
- `test/model-rotation.test.ts` — same-model-skip tests (both-at-0 adjacent
  picks, skip+wrap stacking, 1-model degenerate, never-self-pair over cycles;
  pair-variety expectation updated to `n*(n-1)` since self-pairs no longer occur);
  end-to-end `resolveModelRotationForRun` both-seats test asserts red != green.
- `test/strategy-run-once-async-route.test.ts` — sentinel + non-empty pool → no
  412 (executor launched); sentinel + empty pool → 412 with the rotation message,
  executor never called; blank model still 412 with the model-choice message; red
  sentinel alone → no 412.
- `docs/EFFORT-LOG.md`, `STATUS.md`, this note.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/model-rotation.test.ts test/strategy-run-once-async-route.test.ts`
  — 26/26 passed (under Node 24: the worktree's prebuilt `better-sqlite3` binding
  is NODE_MODULE_VERSION 137; the Mac's default node is v26 → run tests with
  `PATH=/opt/homebrew/opt/node@24/bin:$PATH`, matching `.nvmrc`).
- `npx eslint <touched files>` — 0 errors (2 pre-existing unused-directive
  warnings in chrome.tsx, untouched lines).
- No chrome/classifyRunFailure test coverage exists (the function is
  module-private and no test imports chrome.tsx); per instruction, noted rather
  than building a new UI test harness.

## Follow-ups

- Reviewed; landing via `land.sh` (full gate: lint/tsc/test/build), PR opened
  with auto-merge armed.
- Optional later: a red-only rotation could still land on a FIXED green model
  (the skip only applies when both seats rotate) — left as-is per minimal scope.
