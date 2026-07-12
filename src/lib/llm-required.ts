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
