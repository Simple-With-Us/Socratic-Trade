# MiniMax / Muse Reasoning Budget And Timeout Widening

**Date:** 2026-10-19
**Seat:** MM (MiniMax)
**Branch:** `minimax/green-team-reasoning-budget`
**Lane:** `~/apps/lanes/Socratic-Trade/minimax-green-team-reasoning-budget`

## 1. Context & Objective

The Sandbox account had a 5-run failure streak, `livenessDegraded=true`, with every failure in the
Green Team proposer. Two distinct messages appeared: `Green Team proposal timed out after 150s using
MiniMax MiniMax-M3` and `MiniMax error: Empty response returned from LLM API`. Alpaca Paper had one
failure on `muse-spark-1.3-contributor` ("Couldn't reach the LLM").

Owner ruling on the first hypothesis ("the model time limits need increasing") was **trace first**:
reproduce the behavior outside the app with the same prompts, or inside the app's own environment,
before changing timeouts or models. This note records that trace and the change it justified.

## 2. Changes Made

### Files touched

- `src/lib/llm-request.ts`
  - New `minimaxMuseReasoningHeadroom()` — a dedicated, env-tunable reasoning headroom for the
    `minimax-*` / `muse-*` families, default `16000`. Replaces the hardcoded
    `REASONING_TOKEN_BUDGET.medium` (4000) at the single consumption point in
    `resolveLlmWireOutputCap`, which `withLlmRequestBounds` already calls, so the audited resolver
    and the wire body cannot desync.
  - New `REASONING_LLM_TIMEOUT_DEFAULT_MS = 300_000`, replacing the inline `150_000` in
    `strategyLlmTimeoutMs`. Env override `STRATEGY_LLM_REASONING_TIMEOUT_MS` still wins.
- `test/llm-request.test.ts`
  - New test locking the widened default across every spelling of both families
    (`minimax-m3`, `minimax/minimax-m3`, `MiniMax-M3`, `muse-spark-1.3-contributor`,
    `meta/muse-spark-1.3-contributor`), asserting resolver/body agreement and that the visible
    budget survives above the reserved reasoning.
  - New test for the env override **and** for junk values (`0`, `-5`, `not-a-number`) falling back
    to the default rather than producing a zero/absent reasoning budget.
  - New test asserting the 300s default applies to both families and that non-thinking models are
    NOT dragged up to it.
  - Updated the pre-existing `reserves reasoning headroom for MiniMax and Muse through OpenRouter`
    test, which asserted the old `1500 + 4000 = 5500`. That assertion encoded the starvation
    directly; the new expectation is `1500 + 16000` with the reason recorded inline.
- `docs/EFFORT-LOG.md`
  - New row for this effort.
  - **Collateral correction:** the 2026-10-18 Previous Trades card row still read
    `In Progress (PR)` after PR #4873 merged to `main` as `295ab4dc7`. Corrected in place to
    `Completed (merged to main as 295ab4dc7 via PR #4873, 2026-10-19)`.

## 3. Decisions & Trade-offs

**The trace refuted the obvious fix, so the budget went UP rather than down.** The instinct was to
bound reasoning so the answer could not be starved. Measurement said the opposite.

Measured through the app's real request path (`scripts/benchmark-llm-models.ts`, Green role, which
drives `resolveLlmEndpoint` → `buildLlmRequestBody` → `withLlmRequestBounds` →
`llmFetchCapturing`, with `softTimeoutMs = strategyLlmTimeoutMs`):

| Run | Model | Effort | Latency | Completion tokens | Result |
|---|---|---|---|---|---|
| 1 | minimax-m3 | default | 57.2s | 4,339 | 2 proposals, `schemaValid=true` |
| 2 | minimax-m3 | default | 72.0s | 5,961 | 2 proposals, `schemaValid=true` |
| 3 | minimax-m3 | `--effort none` | 90.9s | — | **unparseable** |

Prompt was 6,745 tokens / 28,653 bytes; ~$0.007 per successful call.

`--effort none` was both **slower and unparseable**, confirming the existing code comment that the
OpenAI effort ladder must not be imposed on this family. Lowering reasoning effort is therefore not
merely insufficient, it is harmful.

**Both failures are one mechanism.** Reasoning length is unbounded and scales with prompt size,
against a fixed completion cap and a fixed wall clock. At roughly 13ms per completion token, a
completion that runs to the old 8,000 cap needs ~104s of generation, and production prompts are
larger than this fixture. So a call either crosses 150s first (`timed out after 150s`) or burns the
cap on reasoning before emitting visible JSON (`Empty response returned from LLM API`). Raising the
timeout alone would only move the wall and would not stop the empty response, which is why both
bounds moved together.

**Why 16,000.** Observed completions were 4,339–5,961 on a 6,745-token prompt. Production prompts
carry real RAG context and portfolio state, so completions scale up from there. 4,000 (the Green
proposer's base) + 16,000 gives a 20,000-token cap that clears observed reasoning while still
terminating rather than running unbounded.

**Why 300s.** ~13ms/token × 20,000 ≈ 260s of generation. The wall has to sit wider than the token
budget implies or it severs calls that are still making progress — the exact failure the original
widening comment describes for DeepSeek. The documented trade-off is unchanged and real: a longer
bound holds the per-user run lock longer, starving the scheduler.

**Env-tunable rather than hardcoded.** Both values are operator-adjustable
(`MINIMAX_MUSE_REASONING_HEADROOM`, `STRATEGY_LLM_REASONING_TIMEOUT_MS`) so this does not need a
code change to retune. The headroom helper rejects non-positive and unparseable values by falling
back to the default — silently honoring `0` would recreate the exact starvation this fixes.

**No model change.** `minimax-m3` and `muse-spark-1.3-contributor` both work when given room;
neither was swapped.

## 4. Verification State

- `npx tsc --noEmit` — **clean, exit 0**, in the lane.
- `npx vitest run test/llm-request.test.ts` — **35/35 passed**, including the 3 new tests and the
  corrected existing one.
- `npm run lint` — NOT yet run in this lane.
- Full `npm test` / `npm run build` — NOT run locally; the host has been heavily loaded all session.
  CI `verify` is the gate of record.

**A trap worth recording:** the Bash tool resets the working directory to the primary workspace on
every call, so `npx tsc --noEmit` without an inline `cd` type-checks `/Users/jay/Code/Socratic-Trade`
— the human's integration tree — and reports another seat's uncommitted congress-share errors
(`@Simple-With-Us/congress-trading-shared` scope mismatch) that have nothing to do with this branch.
Those errors are NOT present on `origin/main` and NOT present in this lane. Always `cd` inline and
confirm with `pwd`.

## 5. Next Steps & Blockers

- Run `npm run lint` and the full test suite, or let CI `verify` be the gate.
- Land via `scripts/land.sh`, open the PR, arm auto-merge.
- Post-merge, confirm the Sandbox account's `consecutiveFailedRuns` clears and a Green Team run
  completes on `minimax-m3`.
- Consider regenerating the Playwright visual baselines from PR #4873 (unrelated follow-up).

## 6. Zero-Code Findings

**APNs push, same session.** Production push was failing with `403 InvalidProviderToken` on all
three device tokens. Owner observed that "some app is using those credentials, more than 1
probably", which was the key: the Apple keys are shared across HogHunter, Clutch, Congress.Trade,
BotFleet and Socratic-Trade, and six `.p8` files exist locally. Matching the stored key by SHA-256
proved `APNS_P8` was Socratic-Trade's OLD key (`ST_AuthKey_SYV2VT3PQ6.p8`), which pairs with a
different Key ID. Only `A3R6Z489GA` + `AuthKey_A3R6Z489GA.p8` authenticated — verified against both
APNs endpoints with a fake device token and fake topic, so nothing was ever delivered. `APNS_TEAM_ID`
(`CC8UTF7ATG`) was already correct, verified by digest against the fleet's `APPLE_TEAM_ID`.

Two of my own errors are recorded so they are not repeated: (1) I first changed `APNS_KEY_ID`
believing the key ID was the fault — the key ID was right, the private key was wrong, and both must
change together; (2) my first credential matrix passed an empty Team ID through a shell quoting bug
(`VAR="$(...)" cmd "$VAR"` expands `$VAR` before the assignment), so every pair returned 403 and
briefly looked like "all keys are dead". That run was invalid.

Also ruled out: the OpenRouter RAG-capability warning is unrelated to the failure streak, and neither
Sandbox nor Alpaca Paper is in `close_only`/exit-only.
## 7. Muse Follow-Up — Muse Was Not The Token Problem

Owner asked specifically about `muse-spark-1.3-contributor` on the Meta API (authenticated with the
Muse Code key). Two findings, both of which narrow the change rather than enlarge it.

**Muse routing is a per-user setting, not a model property.** `resolveLlmEndpoint` consults
`llmRouteFor("meta", userId)`, which reads the `llm_route_meta` user setting and defaults to
`openrouter` (`src/lib/llm-route.ts:20-23`). Values are `openrouter` | `native` | `code-cli`.
`muse-spark-1.3-contributor` is the production user's **Code-CLI** route, which goes through
`CODE_CLI_BROKER_URL` / `CODE_CLI_BROKER_TOKEN` / `CODE_CLI_OWNER_EMAIL`, not directly to
`api.meta.ai`. That is why `scripts/benchmark-llm-models.ts` reported
`status: "no-credential"` against OpenRouter in a lane that cannot read the owner's settings DB — it
is a harness/environment gap, not a broken credential. Exercising the Code-CLI route needs those
three env values plus the owner's settings row.

**Muse does not approach the cap at all.** Direct calls to `api.meta.ai` with a ~7k-token
trading-desk-shaped prompt, identical apart from the cap:

| cap | latency | completion tokens | content chars | parsed | proposals |
|---|---|---|---|---|---|
| 8,000 (old) | 17.0s | 1,900 | 1,032 | yes | 3 |
| 20,000 (new) | 23.8s | 2,703 | 722 | yes | 2 |
| 8,000 (old) | 20.0s | 1,752 | 816 | yes | 3 |
| 20,000 (new) | 22.0s | 2,380 | 955 | yes | 3 |

Every run returned valid JSON well under the old 8,000 cap. Meta returned no reasoning content on
this shape and `finish_reason` was always `stop`. **Muse therefore had no token-budget problem**, and
the headroom change is a pure ceiling raise for it — it cannot regress a model that finishes at
~2,000 tokens.

The production muse failure was also a *different* error: `Couldn't reach the LLM`, not
`Empty response returned from LLM API`. On a Code-CLI broker route that is a transport/broker
reachability failure, not a starved completion. The token-budget diagnosis in this note is
established for **minimax-m3** and should not be claimed for muse.

Net effect on the change: still correct (the headroom branch is shared and only ever raises a
ceiling), but the evidence for it rests on the minimax measurements alone.
