// Hard gate for the two LLM-driven user actions. When a user has NO resolvable LLM credential
// (neither their own per-user key nor the operator-funded failover — see userHasAnyLlmCredential),
// the app must ERROR with a clear, actionable message instead of silently degrading to a rule-based
// stub. Everything else (dashboard, market scan, watchlist/policy/account config, Test-mode
// simulation) keeps working keyless. This module is PURE (no node/server imports) so the messages and
// type guard are safe to import from both client components and server libs/routes.

/** Clear, action-oriented copy shown when the gated action is the strategy session ("Run once" / decide). */
export const LLM_REQUIRED_STRATEGY_MESSAGE = "Connect an LLM provider in Settings to run a strategy session.";

/** Clear, action-oriented copy shown when the gated action is chat. */
export const LLM_REQUIRED_CHAT_MESSAGE = "Connect an LLM provider in Settings to chat.";

/**
 * Shown when a strategy session is attempted with either team model unchosen. NO MODEL DEFAULTS
 * (owner directive 2026-07-07): both the Green (strategist) and Red (reviewer) models must be
 * explicitly chosen on the Strategy page — the strategy never invents one, so it fails closed
 * with this actionable message instead of sending an empty-model request.
 */
export const LLM_MODEL_REQUIRED_STRATEGY_MESSAGE =
  "Choose both the Green Team (strategist) and Red Team (reviewer) models under Strategy → Models to run a strategy session.";

/**
 * Shown when the Strategist model is the rotation sentinel ("__rotate__") but no provider
 * credential resolves for ANY catalog model, so rotation has nothing concrete to serve
 * (eligibleRotationPool is empty). Distinct from LLM_MODEL_REQUIRED_STRATEGY_MESSAGE: the model
 * CHOICE is made (rotate); it's the provider KEYS that are missing.
 */
export const LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE =
  "Rotation is selected, but no provider key resolves for any catalog model, so rotation has nothing to serve.  Add a provider key under Connections → API keys (or choose a specific model) to run a strategy session.";

/** Shown only when rotation still has nothing to serve after fail-open — a /models/user
 *  timeout, empty list, or alias miss must not claim models are missing from the account. */
export const LLM_ROTATION_AVAILABILITY_UNAVAILABLE_STRATEGY_MESSAGE =
  "Rotation couldn't check which models are ready.  Try again shortly or choose a specific model under Strategy → Models.";

/**
 * Thrown deep in the strategy path (the old silent no-key fallback site) so the no-LLM-credential
 * state surfaces as a real failure rather than a fabricated rule-based proposal. The API/UI layers
 * also pre-check with userHasAnyLlmCredential and 4xx early; this is the defense-in-depth backstop.
 */
export class LlmCredentialRequiredError extends Error {
  readonly code = "llm_credential_required";
  constructor(message: string = LLM_REQUIRED_STRATEGY_MESSAGE) {
    super(message);
    this.name = "LlmCredentialRequiredError";
  }
}
