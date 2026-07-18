// model-rotation.ts — the "__rotate__" comparative-measurement option: rotate the Proposer (green) and/or
// Reviewer (red) model through every eligible curated model, a different one each strategy run.
//
// PURPOSE (owner request 2026-07-08): accrue attributed comparative history across models on the
// selected broker account. Proposals already persist `proposedByModel` (the CONCRETE serving model),
// so attribution is automatic — rotation only has to vary which model serves each run.
//
// REASONING EFFORT (per-team split 2026-07-10): a rotating seat has NO manual effort control —
// each rotated model is served at its curated recommended reasoning effort (unknown -> "medium";
// src/lib/model-reasoning-recommendations.ts), carried on the same run-scoped override as the
// model pick (green -> llmReasoningEffort, red -> redTeamReasoningEffort) and recorded on the
// `model_rotation_pick` audit. The persisted per-team efforts are untouched.
//
// HOW IT RESOLVES: `runStrategyOnce` calls `resolveModelRotationForRun` at the TOP of every run,
// BEFORE any budget preview or `resolveLlmEndpoint` call, and merges the result onto its
// RUN-SCOPED policy clone (`runPolicy`) — the same pattern as the usage-budget downgrade. The
// PERSISTED policy keeps the sentinel so the NEXT run rotates again; nothing downstream (endpoint
// resolution, timeouts, `proposedByModel` stamping) ever sees "__rotate__". A safety net in
// `resolveOpenAiModel` (llm-request.ts) covers consumers that read the persisted policy outside a
// run (chat, lesson pass, tuning): they fail closed, never serving the literal sentinel.
//
// POINTER STATE: independent per-seat round-robin counters persisted via internal settings, keyed
// `model_rotation:<userId>:<accountId>:<seat>`. To vary green/red COMBINATIONS rather than locking
// phase (both counters advancing by 1 per run = a fixed pairing), the red counter advances one
// EXTRA step whenever the green counter wraps a full cycle. Additionally, when BOTH seats rotate,
// a run never serves the SAME model to both: if red's slot would equal green's pick, red skips one
// slot forward (pool >= 2 only — a 1-model pool degenerates to same-model by necessity). Without
// the skip, both counters start at 0, so proposer and reviewer served identical models for the
// entire first cycle (pairings only de-phased after the first green wrap). The pointer advance +
// pick audit are
// COMMITTED LATE: `resolveModelRotationForRun` computes the picks early (so the budget preview can
// price the concrete models) but returns a `commit()` the caller only invokes once the run is
// actually committed to serving the LLM — after account validation and the usage-budget skip gate.
// A run that aborts earlier holds the pointer, so a rotation slot is never burned on a run that
// generated no proposal (no `proposedByModel` to match). Per-account run locks serialize same-account
// runs, so the read-early / commit-late window has no TOCTOU.
import { audit, getInternalSetting, resolveLlmCredential, setInternalSetting } from "./db";
import { modelCredentialService } from "./llm-provider";
import { isModelRotationSentinel, LLM_MODEL_ROTATION_SENTINEL } from "./llm-request";
import { recommendedReasoningEffortForModel } from "./model-reasoning-recommendations";
import type { LlmReasoningEffort } from "./types";

export { isModelRotationSentinel, LLM_MODEL_ROTATION_SENTINEL };

/**
 * The rotation pool: the curated model catalog (keep in sync with
 * app/ui/llm-model-catalog.ts CURATED_LLM_MODEL_GROUPS — src/lib must not import from app/)
 * MINUS deliberate exclusions:
 *   - mistral-small-2603 / mistral-medium-3-5 — RE-ADDED 2026-07-10 (owner directive: keep
 *     both in for now, pull out later if warranted). The capability map that 400'd every call
 *     (benchmark 2026-07-08, 0/12) was fixed 2026-07-09, and the 2026-07-10 keyed re-benchmark
 *     confirmed both complete real calls: small-2603 proposes cleanly (100% schema-valid,
 *     bracket-covered, cheap/fast); medium-3-5 at the pool's default effort (reasoning off)
 *     answers with an empty proposal list every round (model judgment, not a request-shape
 *     bug — see docs/rollouts/2026-07-10-mistral-rebench.md) but its reasoning tier does
 *     propose when explicitly requested at higher cost/latency.
 *   - grok-build-0.1 — coding specialist, soft-timeouts as a Green strategist.
 * Order interleaves providers so consecutive runs hit different providers even before the
 * credential filter, and so green/red (offset by the wrap-advance) pair across providers.
 */
export const MODEL_ROTATION_POOL: readonly string[] = [
  "gpt-5.6-terra",
  "claude-haiku-4-5",
  "gemini-3.5-flash",
  "deepseek-v4-flash",
  "mistral-small-2603",
  "gpt-5.6-luna",
  "claude-sonnet-5",
  "gemini-3.1-flash-lite",
  "grok-4.3",
  "gpt-5.4-mini",
  "claude-opus-4-8",
  "gemini-3.1-pro-preview",
  "deepseek-v4-pro",
  "mistral-medium-3-5",
  "gpt-5.6-sol",
  "gpt-5.4-nano",
  "claude-fable-5",
  "openrouter/openai/gpt-4o",
  "openrouter/openai/gpt-4o-mini",
  "openrouter/anthropic/claude-3.5-sonnet",
  "openrouter/anthropic/claude-3-5-haiku",
  "openrouter/google/gemini-2.5-pro",
  "openrouter/google/gemini-2.5-flash",
  "openrouter/meta-llama/llama-3.3-70b-instruct",
  "openrouter/deepseek/deepseek-r1"
];

/** One seat's pick: the model served this run plus the pointer bookkeeping that produced it. */
export interface RotationSeatPick {
  model: string;
  /** Counter value CONSUMED by this pick (pool index = pointer % pool length). */
  pointer: number;
  /** Counter value to persist for the next run. */
  nextPointer: number;
  /** True when this pick consumed the last slot of a full cycle through the pool. */
  wrapped: boolean;
}

export interface RotationAdvance {
  green?: RotationSeatPick;
  red?: RotationSeatPick;
}

/**
 * Pure round-robin pointer logic (unit-testable without a DB). Each rotating seat consumes
 * `pool[counter % pool.length]` and advances its counter by 1; when the GREEN counter wraps
 * (finishes a full cycle), the RED counter advances one extra step so the green/red pairing
 * shifts phase instead of repeating the same combinations forever.
 *
 * SAME-MODEL SKIP: when BOTH seats rotate and the pool has >= 2 models, red never serves the
 * model green picked this run — if red's slot lands on it, red consumes the NEXT slot instead
 * (and its counter continues from there). Both counters start at 0, so without this skip the
 * two seats served the SAME model every run for the whole first cycle. The green-wrap extra
 * advance stacks on top unchanged.
 */
export function advanceRotationPointers(input: {
  pool: readonly string[];
  rotateGreen: boolean;
  rotateRed: boolean;
  greenCounter: number;
  redCounter: number;
}): RotationAdvance {
  const n = input.pool.length;
  if (n === 0) return {};
  const normalize = (counter: number): number => {
    const safe = Number.isFinite(counter) ? Math.trunc(counter) : 0;
    return ((safe % n) + n) % n;
  };
  const out: RotationAdvance = {};
  let greenWrapped = false;
  if (input.rotateGreen) {
    const pointer = normalize(input.greenCounter);
    greenWrapped = pointer === n - 1;
    out.green = { model: input.pool[pointer]!, pointer, nextPointer: pointer + 1, wrapped: greenWrapped };
  }
  if (input.rotateRed) {
    let pointer = normalize(input.redCounter);
    // Same-model skip: when both seats rotate, never serve green's pick to red too — skip to the
    // next slot (possible only with >= 2 models). `pointer` stays the slot actually CONSUMED, so
    // the `model === pool[pointer % n]` audit invariant holds and the counter continues past it.
    if (out.green && n >= 2 && input.pool[pointer] === out.green.model) {
      pointer = (pointer + 1) % n;
    }
    out.red = {
      model: input.pool[pointer]!,
      pointer,
      // The extra +1 on green wrap is what varies the green/red COMBINATION over cycles.
      nextPointer: pointer + 1 + (greenWrapped ? 1 : 0),
      wrapped: pointer === n - 1
    };
  }
  return out;
}

/**
 * The rotation pool restricted to models whose provider credential actually RESOLVES for this
 * user (their own key or the operator failover) — rotation must never inject a guaranteed-failure
 * run by picking a model nobody holds a key for.
 */
export function eligibleRotationPool(userId: string): { pool: string[]; skipped: string[] } {
  const pool: string[] = [];
  const skipped: string[] = [];
  for (const model of MODEL_ROTATION_POOL) {
    // Gate on the SAME credential resolveLlmEndpoint uses to serve each model — the OpenRouter key
    // in production (an OpenRouter-only account must get the full curated pool, not an empty one),
    // the native family under NODE_ENV=test (keeps native-key fixtures working). #1703 follow-up.
    if (resolveLlmCredential(modelCredentialService(model), userId).key) pool.push(model);
    else skipped.push(model);
  }
  return { pool, skipped };
}

function rotationPointerKey(userId: string, accountId: string | undefined, seat: "green" | "red"): string {
  return `model_rotation:${userId}:${accountId ?? "none"}:${seat}`;
}

/**
 * Resolve the rotation sentinel(s) on a policy into CONCRETE models for one strategy run, and return
 * a `commit()` that PERSISTS the side effects (per-seat pointer advance + `model_rotation_pick`
 * audit). The picks are computed EARLY so the caller's budget preview can reason about the concrete
 * models this run would serve, but the pointer only advances when `commit()` is called — the caller
 * invokes it once the run is actually committed to serving the LLM (AFTER account validation + the
 * usage-budget skip gate, immediately before the Green proposeTrades call). A run that aborts before
 * that leaves the pointer untouched, so an aborted run never burns a rotation slot nor logs a phantom
 * pick with no `proposedByModel` to match (Finding 3). `commit` is ALWAYS present (a no-op when
 * neither seat rotates, on an empty eligible pool, or on any storage error). Never throws: an empty
 * pool or storage error resolves the rotating seats to "" (the normal unconfigured/fail-closed state
 * under no-defaults) rather than letting the raw sentinel reach a provider.
 */
export function resolveModelRotationForRun(input: {
  userId: string;
  accountId?: string;
  runId: string;
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null };
}): {
  llmModel?: string;
  redTeamLlmModel?: string;
  /** A rotating GREEN seat also auto-sets the served model's curated recommended reasoning effort
   *  (unknown model -> "medium"; src/lib/model-reasoning-recommendations.ts) onto the run-scoped
   *  policy — there is no manual effort control under rotation. Clamped per model at call time. */
  llmReasoningEffort?: LlmReasoningEffort;
  /** Same auto-set for a rotating RED seat (the reviewer's own per-team effort field). */
  redTeamReasoningEffort?: LlmReasoningEffort;
  commit: () => void;
} {
  const rotateGreen = isModelRotationSentinel(input.policy.llmModel);
  const rotateRed = isModelRotationSentinel(input.policy.redTeamLlmModel);
  if (!rotateGreen && !rotateRed) return { commit: () => {} };
  try {
    const { pool, skipped } = eligibleRotationPool(input.userId);
    if (pool.length === 0) {
      // No provider credential resolves at all — no eligible model to rotate to. Under no-defaults
      // (owner 2026-07-07: DEFAULT_OPENAI_MODEL removed) there is nothing to substitute, so resolve
      // the rotating seat(s) to "" — the SAME unconfigured/fail-closed state any model-less policy
      // reaches — instead of serving the raw "__rotate__" sentinel. The run then fails closed the
      // NORMAL way (key/model precheck → actionable Settings message / route-to-human), never a
      // provider call with a bogus model id.
      audit(
        "model_rotation_pick",
        { runId: input.runId, outcome: "empty_pool", fallback: "", skipped },
        input.userId,
        input.accountId
      );
      return {
        ...(rotateGreen ? { llmModel: "" } : {}),
        ...(rotateRed ? { redTeamLlmModel: "" } : {}),
        commit: () => {}
      };
    }
    const greenKey = rotationPointerKey(input.userId, input.accountId, "green");
    const redKey = rotationPointerKey(input.userId, input.accountId, "red");
    const advance = advanceRotationPointers({
      pool,
      rotateGreen,
      rotateRed,
      greenCounter: getInternalSetting<number>(greenKey) ?? 0,
      redCounter: getInternalSetting<number>(redKey) ?? 0
    });
    const out: {
      llmModel?: string;
      redTeamLlmModel?: string;
      llmReasoningEffort?: LlmReasoningEffort;
      redTeamReasoningEffort?: LlmReasoningEffort;
    } = {};
    // Per-seat side effects (pointer advance + pick audit) are DEFERRED into `commit`: the models are
    // known now (so the budget preview can price them) but the pointer must only advance once the run
    // is committed to serving the LLM. If the caller returns/throws/skips before calling commit(), the
    // pointer holds and nothing is audited — no rotation slot burned on an aborted run (Finding 3).
    const commits: Array<() => void> = [];
    for (const [seat, pick, key] of [
      ["green", advance.green, greenKey],
      ["red", advance.red, redKey]
    ] as const) {
      if (!pick) continue;
      // Rotation owns the rotated seat's reasoning effort too: each served model runs at its
      // curated recommended level (unknown -> "medium"), overriding the stored per-team effort on
      // the RUN-SCOPED policy only. The persisted policy keeps the owner's stored effort for
      // whenever rotation is switched off; call time still re-clamps per model.
      const reasoningEffort = recommendedReasoningEffortForModel(pick.model, seat);
      commits.push(() => {
        setInternalSetting(key, pick.nextPointer);
        audit(
          "model_rotation_pick",
          {
            runId: input.runId,
            seat,
            model: pick.model,
            reasoningEffort,
            pointer: pick.pointer,
            nextPointer: pick.nextPointer,
            wrapped: pick.wrapped,
            poolSize: pool.length,
            skippedNoCredential: skipped
          },
          input.userId,
          input.accountId
        );
      });
      if (seat === "green") {
        out.llmModel = pick.model;
        out.llmReasoningEffort = reasoningEffort;
      } else {
        out.redTeamLlmModel = pick.model;
        out.redTeamReasoningEffort = reasoningEffort;
      }
    }
    return {
      ...out,
      commit: () => {
        for (const runCommit of commits) runCommit();
      }
    };
  } catch (error) {
    // Fail safe, not silent: a broken pointer store must not kill the run or leak the sentinel.
    // No-defaults (owner 2026-07-07): resolve the rotating seat(s) to "" — the normal
    // unconfigured/fail-closed state — rather than serving the raw "__rotate__" sentinel.
    console.error("[model-rotation] pick failed; failing the seat closed (no default model):", error);
    return {
      ...(rotateGreen ? { llmModel: "" } : {}),
      ...(rotateRed ? { redTeamLlmModel: "" } : {}),
      commit: () => {}
    };
  }
}
