/**
 * Thin re-export of the CANONICAL strategy prompt version, which lives in ./strategy-prompts
 * next to the prompt builders it versions (bumped whenever prompt wording changes; stamped onto
 * trade_proposals.prompt_version and Langfuse `metadata.promptVersion`).
 *
 * This module is kept so consumers that only need the stamping constant — red-team.ts, which
 * cannot import strategy.ts without a cycle and doesn't need the prompt builders — keep a tiny
 * dependency-light import path. (Two lanes briefly defined competing constants here and in
 * strategy-prompts.ts; unified 2026-07-01 to the single canonical export below.)
 */
export { STRATEGY_PROMPT_VERSION } from "./strategy-prompts";
