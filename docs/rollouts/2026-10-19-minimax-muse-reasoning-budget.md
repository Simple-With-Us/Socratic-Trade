# MiniMax / Muse Reasoning Budget And Timeout Widening

**Date:** 2026-10-19
**Seat:** MM (MiniMax)
**Branch:** `minimax/green-team-reasoning-budget`
**Lane:** `minimax-green-team-reasoning-budget` (agent lane)

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
    `minimax-*` / `muse-*` families, default `8000`. Replaces the hardcoded
    `REASONING_TOKEN_BUDGET.medium` (4000) at the single consumption point in
    `resolveLlmWireOutputCap`, which `withLlmRequestBounds` already calls, so the audited resolver
    and the wire body cannot desync. The Green proposer's base (4000) + 8000 gives a 12,000-token
    completion cap.
  - New `REASONING_LLM_TIMEOUT_DEFAULT_MS = 360_000`, replacing the inline `150_000` in
    `strategyLlmTimeoutMs`. Env override `STRATEGY_LLM_REASONING_TIMEOUT_MS` still wins.
- `src/lib/strategy.ts:6796`
  - The Green Team truncation retry ceiling was a hardcoded `Math.min(wireOutputCap*2, 16_000)`. It is
    now an env-tunable `STRATEGY_BULL_TRUNCATION_RETRY_MAX_CAP`, default **24000**, so the
    base-cap → retry-ceiling relationship is adjustable without a second edit.
- `test/llm-request.test.ts`
  - New test locking the widened default across every spelling of both families
    (`minimax-m3`, `minimax/minimax-m3`, `MiniMax-M3`, `muse-spark-1.3-contributor`,
    `meta/muse-spark-1.3-contributor`), asserting resolver/body agreement and that the visible
    budget survives above the reserved reasoning.
  - New test for the env override **and** for junk values (`0`, `-5`, `not-a-number`) falling back
    to the default rather than producing a zero/absent reasoning budget.
  - New test asserting the 360s default applies to both families and that non-thinking models are
    NOT dragged up to it.
  - New invariant test asserting the base cap stays **below** the truncation-retry ceiling — see §3.
  - Updated the pre-existing `reserves reasoning headroom for MiniMax and Muse through OpenRouter`
    test, which asserted the old `1500 + 4000 = 5500`. That assertion encoded the starvation
    directly; the new expectation is `1500 + 8000`.
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

**Why 8,000 of headroom.** Observed completions were 4,339–5,961 on a 6,745-token prompt. Production
prompts carry real RAG context and portfolio state, so completions scale up from there. The Green
proposer's base (4,000) + 8,000 gives a 12,000-token cap that clears observed reasoning while still
terminating rather than running unbounded. Measured Muse output peaked at 2,703 tokens, so 8,000
leaves ample room without being unbounded.

**Why 360s.** ~13ms/token × the largest cap a single attempt can reach. The retry ceiling (24,000)
is the widest cap any one attempt gets, so the worst case needs ~312s of generation. The wall has to
sit wider than the token budget implies or it severs calls that are still making progress — the
exact failure the original widening comment describes for DeepSeek. The documented trade-off is
unchanged and real: a longer bound holds the per-user run lock longer, starving the scheduler.

**The three bounds are ONE number, and the full suite caught them disagreeing.** An intermediate pass
set headroom 16,000 (a 20,000 base cap) while the truncation retry in `strategy.ts` was still capped
at a hardcoded 16,000. That silently disabled the retry safety net for exactly the calls it exists to
protect — a 20,000-token attempt had nowhere to go. Narrow test runs did not catch it; `land.sh`'s
full suite did. The shape is now derived from the same measurement and held by an invariant test:
base cap **12,000** < retry ceiling **24,000** < wall **360s** (24,000 × 13ms ≈ 312s < 360s). Keep all
three in step when retuning.

**Env-tunable rather than hardcoded.** Both values are operator-adjustable
(`MINIMAX_MUSE_REASONING_HEADROOM`, `STRATEGY_LLM_REASONING_TIMEOUT_MS`) so this does not need a
code change to retune. The headroom helper rejects non-positive and unparseable values by falling
back to the default — silently honoring `0` would recreate the exact starvation this fixes.

**No model change.** `minimax-m3` and `muse-spark-1.3-contributor` both work when given room;
neither was swapped.

## 4. Review Findings (PR #4882)

Kody Code Review raised five threads, resolving to three distinct defects.  Two were real bugs in my
own change, which is worth recording plainly.

**The retry ceiling accepted negative env values.** `Number(env) || 24_000` does not reject
negatives, because `Number("-1")` is `-1` and `-1` is truthy.  A negative override therefore dropped
`retryCeiling` below the base cap, made `retryCap > wireOutputCap` false, and **silently disabled
the truncation-retry safety net** — the exact failure this whole change exists to prevent, reintroduced
one layer up.  Fixed by extracting `positiveEnvNumber()` in `llm-request.ts` and routing **both** env
knobs through it, so the headroom and the ceiling can never disagree about how to parse operator input.

This was made worse by my own invariant test, which reimplemented the parse as
`Number(process.env...) || 24_000` instead of calling the production helper.  A test that copies the
logic it is meant to police cannot catch a bug in that logic.  It now calls `positiveEnvNumber()`
directly, and a new test asserts negatives and junk fall back to the documented default.

**Env stub leak.** Two `vi.stubEnv` blocks restored only via a trailing `vi.unstubAllEnvs()`, so a
thrown assertion would skip the restore and leak the stub into every later test in the file.  Both are
now wrapped in `try { ... } finally { vi.unstubAllEnvs(); }`.

**Exposed local path.** The Lane header leaked a local workspace path into a committed doc.  Replaced
with the bare lane name.

## 5. Verification State

All commands run **in the lane**, with the `cd` inline and `pwd` echoed, per the trap below.

- `npx tsc --noEmit` — **clean, exit 0**.
- `npm run lint` — **0 errors**, 870 warnings. The `verify` CI step fails on errors only; the warnings
  are the grandfathered `no-explicit-any` / `react-hooks` backlog, unchanged by this branch.
- `npx vitest run test/llm-request.test.ts test/persistence-notification.test.ts` — **55/55 passed**.
- `npx vitest run` over the 8 files touching these bounds — **169/169 passed** after the fix.
- Full `npm test` + `npm run build` — run by `scripts/land.sh`; see §5.
- Post-review re-run after the Kody fixes: `tsc --noEmit` exit 0, and the 5 bounds test files
  **119/119**.

**Two real defects were caught here, both by the full suite rather than narrow runs:**

1. The retry ceiling sat *below* the base cap (§3). Fixed, plus an invariant test.
2. `test/persistence-notification.test.ts` asserted the literal old string `timed out after 150s`. It
   is a behavioral test of the *message*, so it must track the bound; updated to 360s.

**A trap worth recording:** the Bash tool resets the working directory to the primary workspace on
every call, so `npx tsc --noEmit` without an inline `cd` type-checks the human's main integration
tree — and reports another seat's uncommitted congress-share errors
(`@Simple-With-Us/congress-trading-shared` scope mismatch) that have nothing to do with this branch.
Those errors are NOT present on `origin/main` and NOT present in this lane. The same mistake made a
test batch report **70 failures across `strategy-tuning`, `persistence-notification`, `post-mortem`
and `red-team`** (several files collecting 0 tests) — a signature of the missing workspace
dependency, not of a real break. Re-run in-lane, that same batch was **1 failure**. Always `cd`
inline and confirm with `pwd`; a confident wrong-directory result is worse than no result.

## 6. Next Steps & Blockers

- Run `npm run lint` and the full test suite, or let CI `verify` be the gate.
- Land via `scripts/land.sh`, open the PR, arm auto-merge.
- Post-merge, confirm the Sandbox account's `consecutiveFailedRuns` clears and a Green Team run
  completes on `minimax-m3`.
- Consider regenerating the Playwright visual baselines from PR #4873 (unrelated follow-up).

## 7. Zero-Code Findings

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
## 8. Muse Follow-Up — Muse Was Not The Token Problem

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

| cap tested | latency | completion tokens | content chars | parsed | proposals |
|---|---|---|---|---|---|
| 8,000 (the old headroom) | 17.0s | 1,900 | 1,032 | yes | 3 |
| 20,000 (an upper probe) | 23.8s | 2,703 | 722 | yes | 2 |
| 8,000 (the old headroom) | 20.0s | 1,752 | 816 | yes | 3 |
| 20,000 (an upper probe) | 22.0s | 2,380 | 955 | yes | 3 |

Every run returned valid JSON well under the 8,000 headroom, and the 20,000 probe never came close to
its own cap either — completion did not track the ceiling. Meta returned no reasoning content on
this shape and `finish_reason` was always `stop`. **Muse therefore had no token-budget problem**, and
the headroom change is a pure ceiling raise for it — it cannot regress a model that finishes at
~2,000 tokens.

The production muse failure was also a *different* error: `Couldn't reach the LLM`, not
`Empty response returned from LLM API`. On a Code-CLI broker route that is a transport/broker
reachability failure, not a starved completion. The token-budget diagnosis in this note is
established for **minimax-m3** and should not be claimed for muse.

Net effect on the change: still correct (the headroom branch is shared and only ever raises a
ceiling), but the evidence for it rests on the minimax measurements alone.
