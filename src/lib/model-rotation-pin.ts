// model-rotation-pin.ts — the CONTROLLED-EXPERIMENT lever on model rotation.
//
// WHY (review "rank 6", 2026-09-25): the per-model realized-performance review concluded its own
// comparison was not clean.  Verbatim: "Model rotation changed from fixed to round-robin on Jul 8,
// then to weighted random on Aug 6, so each model's results are tied to a calendar period."
// "16 models are being compared at once."  And the ask: "Run a controlled model test: fix the
// rotation weights for a set period, or split models by account.  A reversible down-weight of
// gpt-5.5 and gpt-5.4-nano is cheap now, but not proven."  It "answers whether gpt-5.5 and
// gpt-5.4-nano are worse, or just unlucky in their calendar period."
//
// The alternative half of that sentence ("split models by account") is NOT this file's job — it
// depends on the per-(user, account, seat) scoping of the representation ledger, which the pin must
// leave exactly as it is.  The pin is scoped by construction: it is read from the CALLER'S policy
// (per user, per account) and validated against THAT seat's own eligible pool, so a pin on one
// account can never move another account's picks, and there is no module-level pin state anywhere
// in this file that a second account could inherit.
//
// WHAT A PIN IS: two independent halves, each usable alone.
//   - `green` / `red`  — force one concrete model onto a seat for the experiment window.
//   - `weights`        — override the LEARNED representation weights per model.  0 EXCLUDES a
//     model from that seat for the window (the review's cheap down-weight); any positive number
//     biases sampling toward it.  Models absent from the map keep their learned weight, so
//     "fix the weights" = list every model, "down-weight two" = list two.
//
// LOUD BY CONSTRUCTION (this repo's recurring failure mode is a silent behaviour change on a money
// path distorting every report built on it): the caller writes a `model_rotation_pin` audit for
// EVERY run a pin touches — applied, partially refused, or fully refused — and stamps
// `pinned`/`pinLabel`/`forced` on the `model_rotation_pick` audit so any per-model performance
// report can separate experiment runs from ordinary rotation.  A pin is never inferred from
// behaviour; it is always declared in an audit row and in the logs.
//
// REVERSIBLE BY CONSTRUCTION: nothing here mutates the ledger or the pool.  A pin only overrides
// the weights for the run in which it is present, and picks made under a pin are excluded from the
// representation counts the next run reads (see `rotationSeatRepresentation`), so removing the pin
// restores the learned behavior exactly rather than approximately.  `expiresAt` is the second half
// of "reversible-obviously": a forgotten experiment window self-expires instead of distorting
// reports forever.
//
// TRUSTED, NOT BELIEVED: every field is validated here.  An unknown model id, a non-numeric or
// out-of-range weight, a malformed pin, an elapsed expiry, a force naming a model this seat cannot
// serve, or a weight set that would leave the pool with zero total weight are all REFUSED WITH A
// RECEIPT (`rejected[]` / `ignored`), never thrown and never silently swallowed — and a refusal
// degrades to the learned behavior, never to an empty rotation that starves the pool.
import { isModelRotationSentinel } from "./llm-request";
// Canonical line identity, NOT string equality: a pin written with a wire-spelled id
// (`openai/gpt-5.5`) must be recognized as the same model line as the catalog slug the pool holds,
// or the same-model guarantee check would pass on a collision.
import { isSameModelLine } from "./model-identity";

/** Owner-set experiment lever, carried on the policy next to the "__rotate__" sentinel. */
export interface ModelRotationPin {
  /** Force this concrete catalog model onto the Green (proposer) seat for the window. */
  green?: string | null;
  /** Same, for the Red (reviewer) seat. */
  red?: string | null;
  /**
   * Weight overrides layered over the learned representation weights, keyed by catalog model id.
   * 0 excludes the model from the seat for the window; positive values bias sampling toward it.
   * Models not listed keep their learned weight (2 underrepresented / 1 at-or-above-median).
   */
  weights?: Record<string, number> | null;
  /** Operator label for the experiment — echoed verbatim into every audit row and log line, so a
   *  later per-model report can be sliced by experiment name without guessing from dates. */
  label?: string | null;
  /** ISO-8601 instant after which the pin stops applying. Self-expiry is the backstop against a
   *  forgotten experiment window quietly reshaping every later performance report. */
  expiresAt?: string | null;
}

/**
 * Upper bound on a pin weight.  The learned weights are 1 and 2, so anything past this is a typo or
 * a mis-scaled experiment constant, not an intent worth honoring: a weight of 1e9 would silently
 * collapse the pool onto one model while looking configured.
 */
export const ROTATION_PIN_MAX_WEIGHT = 100;

/** Why a pin (or a pin's force) was refused. Absent when the pin applied. */
export type RotationPinIgnoreReason =
  | "no_pin"
  | "malformed_pin"
  | "expired"
  | "sentinel_not_pinnable"
  | "model_not_eligible"
  | "would_starve_pool";

/** One seat's resolved pin. Pure: no DB, no clock beyond the injectable `now`, no module state. */
export interface RotationSeatPinResolution {
  /** True when this seat's model for this run is governed by the pin (a force, or a weight override). */
  applied: boolean;
  /** The concrete model forced onto the seat, or undefined to keep learned sampling. */
  forcedModel?: string;
  /** Weight overrides to layer over the learned weights. Undefined when none survived validation. */
  weightOverrides?: ReadonlyMap<string, number>;
  /** Why part or all of the pin was refused — present even when the weight half still applied. */
  ignored?: RotationPinIgnoreReason;
  /** One receipt per refused entry. Never swallowed: these strings reach the audit row and the log. */
  rejected: string[];
  label?: string;
  expiresAt?: string;
}

/**
 * Resolve the pin for ONE seat against that seat's own eligible pool.  `knownModels` is the curated
 * rotation catalog (MODEL_ROTATION_POOL), passed in rather than imported so this module stays a pure
 * leaf — model-rotation.ts owns the catalog and the eligibility filter, and a pin can only ever
 * speak about models that pool already contains.
 */
export function resolveRotationSeatPin(input: {
  pin: unknown;
  seat: "green" | "red";
  /** The seat's eligible pool: catalog models this user actually has a working credential for. */
  pool: readonly string[];
  /** The curated rotation catalog — an id outside it is a typo, not an experiment. */
  knownModels: readonly string[];
  /** The other seat's model for this run; a force that collides with it is refused (same-model guarantee). */
  excludeModel?: string | null;
  now?: number;
}): RotationSeatPinResolution {
  const { pin, seat, pool, knownModels } = input;
  const none: RotationSeatPinResolution = { applied: false, ignored: "no_pin", rejected: [] };
  if (pin === null || pin === undefined) return none;
  // A pin arrives from a policy that can be hand-edited, API-patched, or migrated from an older
  // shape, so a non-object is expected input, not a programming error: refuse it with a receipt.
  if (typeof pin !== "object" || Array.isArray(pin)) {
    return { applied: false, ignored: "malformed_pin", rejected: [`pin: expected an object, got ${typeof pin}`] };
  }
  const raw = pin as Record<string, unknown>;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
  const rejected: string[] = [];
  const resolved: RotationSeatPinResolution = { applied: false, rejected, ...(label ? { label } : {}) };

  const expiresAt = typeof raw.expiresAt === "string" && raw.expiresAt.trim() ? raw.expiresAt.trim() : undefined;
  if (raw.expiresAt !== null && raw.expiresAt !== undefined && !expiresAt) {
    rejected.push("expiresAt: not an ISO-8601 string");
  }
  if (expiresAt) {
    resolved.expiresAt = expiresAt;
    const until = Date.parse(expiresAt);
    if (!Number.isFinite(until)) rejected.push(`expiresAt: unparseable (${expiresAt})`);
    else if ((input.now ?? Date.now()) >= until) {
      // Self-expiry: the operator's window closed, so the learned weights resume on their own and
      // the refusal is audited — nobody has to remember to turn the experiment off.
      return { ...resolved, applied: false, ignored: "expired", rejected };
    }
  }

  // ── Force half ──────────────────────────────────────────────────────────────────────────────
  const forced = seat === "green" ? raw.green : raw.red;
  const otherSeatFieldEmpty = seat === "green" ? isBlank(raw.red) : isBlank(raw.green);
  if (!isBlank(forced)) {
    const model = typeof forced === "string" ? forced.trim() : "";
    if (!model) {
      // Non-string (object/number) — record which seat, since a stringified id is unusable.
      rejected.push(`${seat}: forced model must be a string, got ${typeof forced}`);
      resolved.ignored ??= "malformed_pin";
    } else if (isModelRotationSentinel(model)) {
      // Pinning the sentinel would resolve "__rotate__" to "__rotate__" — a self-referential loop,
      // not a model choice.  Refused, and the receipt says exactly that.
      rejected.push(`${seat}: ${model} is the rotation sentinel, not a pinnable model`);
      resolved.ignored ??= "sentinel_not_pinnable";
    } else if (!knownModels.includes(model)) {
      rejected.push(`${seat}: unknown model id "${model}" is not in the rotation catalog`);
      resolved.ignored ??= "malformed_pin";
    } else if (!pool.includes(model)) {
      // The model exists but this user has no working credential for it right now, so serving it
      // would inject a guaranteed-failure run.  Refuse the FORCE (not the run): learned rotation
      // continues, so a stale pin can never stop a seat from turning over.
      rejected.push(`${seat}: pinned model "${model}" is not in this seat's eligible pool`);
      resolved.ignored ??= "model_not_eligible";
    } else if (input.excludeModel && isSameModelLine(model, input.excludeModel)) {
      // Same-model guarantee (the proposer must not review itself, and under Autopilot it would
      // auto-execute its own opening): a force that collides with the other seat's model is dropped
      // and this seat keeps sampling.  Compared by model LINE (see the import note) so no wire
      // spelling of the other seat's model can slip past the check.
      rejected.push(`${seat}: pinned model "${model}" collides_with_other_seat (${input.excludeModel})`);
    } else {
      resolved.forcedModel = model;
    }
  } else if (!otherSeatFieldEmpty) {
    rejected.push(`${seat}: no pin configured for this seat (only the other seat is pinned)`);
  }

  // ── Weight half ─────────────────────────────────────────────────────────────────────────────
  const weights = raw.weights;
  if (weights !== null && weights !== undefined) {
    if (typeof weights !== "object" || Array.isArray(weights)) {
      rejected.push("weights: expected an object of modelId -> number");
      resolved.ignored ??= "malformed_pin";
    } else {
      const overrides = new Map<string, number>();
      for (const [model, weight] of Object.entries(weights as Record<string, unknown>)) {
        const key = model.trim();
        if (!key) continue;
        if (typeof weight !== "number" || !Number.isFinite(weight)) {
          rejected.push(`weights["${key}"]: not a finite number (${JSON.stringify(weight) ?? typeof weight})`);
          continue;
        }
        if (weight < 0 || weight > ROTATION_PIN_MAX_WEIGHT) {
          rejected.push(`weights["${key}"]: ${weight} outside [0, ${ROTATION_PIN_MAX_WEIGHT}]`);
          continue;
        }
        if (!knownModels.includes(key)) {
          // A typo'd id must not read as a configured down-weight of nothing; say so and move on.
          rejected.push(`weights["${key}"]: unknown model id is not in the rotation catalog`);
          continue;
        }
        if (!pool.includes(key)) {
          // Known model, wrong pool for THIS seat (no credential here, or the other seat is
          // serving it this run).  Informational, not fatal — the other seat may still honor it.
          rejected.push(`weights["${key}"]: not in this seat's eligible pool; not applied here`);
          continue;
        }
        if (resolved.forcedModel && key === resolved.forcedModel) {
          // The force and the weight contradict each other; the explicit force wins (it is the
          // stronger statement) and the contradiction is on the record rather than silent.
          rejected.push(`weights["${key}"]: dropped — this model is force-pinned for ${seat}`);
          continue;
        }
        overrides.set(key, weight);
      }
      if (overrides.size > 0) {
        // A pin that would zero out every sampled weight leaves the sampler with no distribution at
        // all.  Refuse the WHOLE weight set (not the run): the learned weights keep rotating, and
        // the receipt names the starvation the operator was one edit away from shipping.
        const remaining = pool.filter((model) => model !== resolved.forcedModel);
        const totalAfter = remaining.reduce(
          (sum, model) => sum + (overrides.has(model) ? overrides.get(model)! : 1),
          0
        );
        if (totalAfter <= 0) {
          rejected.push(
            `weights: every eligible model would carry weight 0 (${remaining.join(", ")}); refusing to starve rotation`
          );
          resolved.ignored ??= "would_starve_pool";
        } else {
          resolved.weightOverrides = overrides;
        }
      }
    }
  }

  resolved.applied = resolved.forcedModel !== undefined || resolved.weightOverrides !== undefined;
  return resolved;
}

/**
 * The run-level view of a pin: what the caller can log or surface, and what the `model_rotation_pin`
 * audit payload carries.  Merged from the two per-seat resolutions by the caller.
 */
export interface RotationPinReport {
  /** True when either seat's model for this run is governed by the pin. */
  applied: boolean;
  label?: string;
  /** Forced Green model for this run (only when the force survived validation). */
  green?: string;
  /** Forced Red model for this run. */
  red?: string;
  /** Weight overrides actually applied, keyed by model id. */
  weights?: Record<string, number>;
  /** The first refusal reason seen, for a one-line log. */
  ignored?: RotationPinIgnoreReason;
  /** Every receipt, from both seats. */
  rejected: string[];
  expiresAt?: string;
  /** Size of the eligible pool the pin was validated against, so a receipt like "not in this seat's
   *  eligible pool" can be read months later without re-deriving which catalog was live that day. */
  poolSize?: number;
  /** Mirrors the audit column in the payload: a per-model report slices on the payload alone, and a
   *  scoped experiment has to be separable from another account's without a second query. */
  connectedAccountId?: string | null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}
