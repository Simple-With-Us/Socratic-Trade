# 2026-07-09 — Mistral capability-map fix (MONET)

## Summary

Both catalog Mistral models failed 100% of calls (benchmark 2026-07-08: 0/12) because the
request shaper claimed a family-wide reasoning capability Mistral doesn't have. Fixed
against the provider's own 400 responses (captured in
`docs/benchmarks/2026-07-08-llm-model-benchmark.json`):

- `mistral-medium-3-5` → `"reasoning_effort medium is not supported for this model,
  supported values: [<ReasoningEffort.high: 'high'>, <ReasoningEffort.none: 'none'>]"`
- `mistral-small-2603` → `"Reasoning prompt mode is not enabled for this model"`

Changes (`src/lib/llm-request.ts`):

1. The Mistral capability entry now matches ONLY `mistral-medium-3-5*`, with options
   `["none", "high"]` (was: every mistral/magistral/codestral/… id with six tiers).
2. `normalizeReasoningEffortForModel` gets a Mistral branch mirroring the DeepSeek
   opt-in rule: explicit high/xhigh/max → `"high"`, everything else (including the app's
   `"medium"` default and `undefined`) → `"none"`. Without this, the generic rank-distance
   normalization would silently upgrade the default to the expensive high-reasoning tier.
3. Body shaping is unchanged in code but now only reachable for medium-3-5:
   `reasoning_effort:"high"` + `prompt_mode:"reasoning"` on the reasoning tier (both passed
   medium-3-5's validation in the benchmark — only the effort value 400'd),
   `reasoning_effort:"none"` with no prompt_mode when off.
4. `mistral-small-2603` and every other Mistral-family id now have NO reasoning
   capability → plain `temperature` + `max_completion_tokens` chat body, the only shape
   known valid across the family. The settings UI consequently shows no effort selector
   for them (it derives from the same capability map).

`src/lib/model-rotation.ts`: the two models stay EXCLUDED from `MODEL_ROTATION_POOL`;
the exclusion comment now records that the map is fixed but neither model has ever
completed a benchmarked call — re-add only after a keyed re-benchmark shows schema-valid
completions.

## Why

Handoff-queue item 2 from `/Users/jay/apps/monet-handoff-2026-07-09.md` (the post-#1191
unblocked queue), owner-flagged for pickup on session resume. Anyone selecting either
Mistral model as Proposer/Reviewer today gets a guaranteed 400 on every run.

## Decisions

- **Evidence-only capability entries.** No credentials are reachable from this machine
  (`~/.secrets` has no Mistral/Infisical material), so no live probe was possible. The
  fix therefore encodes exactly what Mistral's error messages enumerate and nothing
  more: medium-3-5 = {high, none}; small-2603 and unknowns = no reasoning params. A
  plain chat body cannot hit either observed 400.
- **Opt-in high, not nearest-match.** Deliberately reuses the DeepSeek precedent
  (llm-request.ts already documents it): a sub-high request must not silently become a
  slow, expensive high-reasoning call. Default effort on medium-3-5 = reasoning off.
- **Rotation-pool re-add deferred.** "Fixed request shape" ≠ "proven working model" —
  0/12 means we have never seen either model return a completion, let alone
  schema-valid JSON. One keyed `scripts/benchmark-llm-models.ts` run is the cheap,
  honest gate for re-adding them.

## Files

- `src/lib/llm-request.ts` — capability map, normalization branch, shaping comment.
- `src/lib/model-rotation.ts` — exclusion comment updated (no pool change).
- `test/llm-request.test.ts` — capability/normalization/body assertions rewritten to the
  evidence-based behavior (medium-3-5 none|high incl. no-silent-upgrade cases;
  small-2603/large/magistral → undefined capability, plain body with no reasoning keys).
- `test/llm-call.test.ts` — provider wire-shape test moved off the fictional
  `mistral-large-2512` reasoning shape; adds the plain-body case.
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note — protocol.

## Verification

- `npm run lint` — 0 errors.
- `npx tsc --noEmit` — clean.
- `npm test` — 310 files / 3246 tests passed.
- `npm run build` — clean.
- Focused: `npx vitest run test/llm-request.test.ts test/llm-call.test.ts
  test/model-rotation.test.ts test/llm-provider.test.ts test/chat-llm.test.ts
  test/model-stats.test.ts` — 120 tests green.

## Follow-ups

- **Keyed re-benchmark** (needs MISTRAL_API_KEY, e.g. prod Infisical env):
  `scripts/benchmark-llm-models.ts` limited to the two Mistral models; if completions are
  schema-valid, re-add both to `MODEL_ROTATION_POOL` and refresh the cost/latency columns
  in the model catalog labels.
- Remaining handoff-queue items: `reviewedByModel` per-proposal stamp (start after the
  intro-anim session's bump-to-floor lands — both touch `strategy.ts`), and the
  `strategy.ts` split (needs an announced freeze window; repo too active tonight).

## Close-out (2026-07-10, MONET — outcome + handoff-queue verification)

- **Merged** as PR #1279 (squash `d6b7dee3`, 05:41Z) after clearing GitHub's fake-CONFLICTING
  wedge (known multi-agent push-burst failure): mergeability stuck DIRTY while a local
  `git merge --no-commit` vs main was clean and Actions never dispatched — a fresh main-merge
  head SHA (`ab805b2a`) recomputed mergeability and dispatched CI; auto-merge landed it green.
- **Deployed** in the 06:20Z env-activation release; production = `main@420c6747`, health
  verified by the deploying lane.
- The PR additionally carries two verified review fixes (claude/fable subagent, adopted by
  this lane): chunked Mistral reasoning-text extraction in `llm-call.ts` (the reasoning-tier
  response shape this fix makes reachable), and a strategy-page intersection guard so pairing
  medium-3-5 with another reasoning model can't silently persist a high-tier effort the user
  never chose.
- **Handoff-queue verification (no code change, recorded per protocol):** the
  `reviewedByModel` per-proposal stamp — queue item 1 — was found ALREADY DONE, landed by AG
  as PR #1282 (`15c2560e`) after the handoff file and the usage-cap close-out were written:
  types stamp + `strategy.ts` review-site stamping + model-stats reviewer attribution (with
  the documented legacy "unattributed" fallback) + tests. Verified against the queue item's
  intent; my announced claim was withdrawn and the board rows corrected. Queue state:
  item 1 done (#1282), item 2 done (this PR), item 3 (`strategy.ts` split) remains in the
  board's unassigned owner-decision bucket — it needs an announced freeze window and should
  start only after the open `strategy.ts` PRs (#1297, #1295) land.
- Fleet note (environment, hit during this landing): Homebrew's default `node` on the shared
  Mac moved to v26.5.0 on 2026-07-09 evening; `better-sqlite3` builds in existing worktrees
  are Node 24 (`.nvmrc`), so `npm test`/`land.sh` fail with NODE_MODULE_VERSION 137-vs-147
  errors unless run with `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
