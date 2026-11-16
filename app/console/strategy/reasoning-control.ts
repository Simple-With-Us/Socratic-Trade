/** Pure helpers behind the Strategy page's shared "Reasoning / Thinking Effort" control —
 *  extracted from app/console/strategy/page.tsx so the sentinel-aware selection logic is
 *  unit-testable without rendering the page. No React, safe to import anywhere.
 *
 *  Rotation ("__rotate__") awareness: a rotating seat maps to the UI-only synthetic
 *  ROTATION_UI_REASONING_CAPABILITY (full generic ladder) instead of being filtered out, so the
 *  effort control stays visible and editable under rotation. That is honest because the stored
 *  effort is re-clamped PER SERVED MODEL at call time (`interactiveStrategyReasoningEffort`);
 *  server paths still fail closed on the raw sentinel (`reasoningCapabilityForModel` returns
 *  undefined for it). */

import type { LlmReasoningEffort } from "@/lib/types";
import {
  interactiveStrategyReasoningEffort,
  isModelRotationSentinel,
  normalizeReasoningEffortForModel,
  normalizeReasoningEffortForOptions,
  reasoningCapabilityForModel,
  ROTATION_UI_REASONING_CAPABILITY,
  type LlmReasoningCapability,
  type LlmReasoningOption
} from "@/lib/llm-reasoning";

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export interface ReasoningControl {
  label: string;
  hint: string;
  options: LlmReasoningOption[];
  capabilities: LlmReasoningCapability[];
}

export function reasoningControlForModels(models: string[]): ReasoningControl | null {
  const capabilities = uniq(models.map((model) => model.trim()).filter(Boolean))
    .map((model) => (isModelRotationSentinel(model) ? ROTATION_UI_REASONING_CAPABILITY : reasoningCapabilityForModel(model)))
    .filter((capability): capability is LlmReasoningCapability => Boolean(capability));
  const uniqueCapabilities = Array.from(new Map(capabilities.map((capability) => [capability.label, capability])).values());
  if (uniqueCapabilities.length === 0) return null;

  const sharedValues = uniqueCapabilities.reduce<LlmReasoningEffort[] | null>((shared, capability) => {
    const values = capability.options.map((option) => option.value);
    return shared ? shared.filter((value) => values.includes(value)) : values;
  }, null);
  if (!sharedValues || sharedValues.length === 0) return null;

  const firstOptions = uniqueCapabilities[0]?.options ?? [];
  const options = firstOptions
    .filter((option) => sharedValues.includes(option.value))
    .map((option) => {
      const providerOption = uniqueCapabilities.flatMap((capability) => capability.options).find((candidate) => candidate.value === option.value);
      return providerOption ?? option;
    });

  if (uniqueCapabilities.length === 1) {
    const capability = uniqueCapabilities[0]!;
    return { label: capability.settingLabel, hint: capability.description, options, capabilities: uniqueCapabilities };
  }

  const labels = uniqueCapabilities.map((capability) => capability.label).join(" + ");
  return {
    label: "Shared Reasoning / Thinking",
    hint: `${labels} are active.  Only values supported by every selected model are shown.`,
    options,
    capabilities: uniqueCapabilities
  };
}

export function reasoningSummary(control: ReasoningControl | null): string {
  if (!control) return "These selected models do not expose a provider-specific reasoning or thinking control here.";
  const labels = control.capabilities.map((capability) => capability.label).join(" + ");
  if (control.capabilities.some((capability) => capability.provider === "rotation")) {
    return `${labels} active — a rotating seat auto-sets each served model's curated recommended reasoning effort (unknown models run Medium).`;
  }
  return `${labels} active.`;
}

/** The per-team policy fields a seat's reasoning control writes (per-team split 2026-07-10). */
export type SeatReasoningField = "llmReasoningEffort" | "redTeamReasoningEffort";

/** Whenever a seat's MODEL changes, the previously-saved effort for that seat may no longer be a
 *  valid/offered value for the new model (e.g. a provider-specific "xhigh" the new model doesn't
 *  expose, or the disallowed interactive gpt-5.5+high combo). Recompute + include a renormalized
 *  value in the SAME save so a model-only write can never leave the stored (model, effort) combo
 *  in an invalid state. Three deliberate no-patch cases:
 *   - rotating seat: rotation auto-sets each served model's recommended effort server-side
 *     (src/lib/model-rotation.ts) — never clamp the stored effort against the synthetic ladder;
 *   - `effort === undefined` (the reviewer's "inherit the proposer's" state): a model change must
 *     never MATERIALIZE an explicit per-team value the owner didn't set;
 *   - a model with no reasoning capability: the stored effort is simply ignored at call time.
 *  Clamping goes through `interactiveStrategyReasoningEffort`, so picking gpt-5.5 while "high" is
 *  stored saves the run-time-honest "medium" instead of a doomed 400. */
export function seatReasoningPatch(
  field: SeatReasoningField,
  model: string | undefined,
  effort: LlmReasoningEffort | undefined
): Partial<Record<SeatReasoningField, LlmReasoningEffort>> {
  const concrete = (model ?? "").trim();
  if (!concrete || isModelRotationSentinel(concrete)) return {};
  if (effort === undefined) return {};
  const value = interactiveStrategyReasoningEffort(concrete, effort);
  return value ? { [field]: value } : {};
}

/** high/xhigh/max are the EXPENSIVE, slow-latency reasoning tier every opt-in provider branch in
 *  `normalizeReasoningEffortForModel` (Mistral, DeepSeek) guards behind an explicit user request. */
export const HIGH_TIER_REASONING_EFFORTS: ReadonlySet<LlmReasoningEffort> = new Set(["high", "xhigh", "max"]);

export function normalizeReasoningValueForControl(
  models: string[],
  control: ReasoningControl | null,
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort | undefined {
  if (!control) return undefined;
  if (control.capabilities.length === 1) {
    const provider = control.capabilities[0]!.provider;
    const model = models.find((candidate) => reasoningCapabilityForModel(candidate)?.provider === provider);
    return normalizeReasoningEffortForModel(model, effort) ?? normalizeReasoningEffortForOptions(control.options, effort);
  }
  // Mixed-provider pairing (e.g. Mistral Medium 3.5's {none, high} alongside an OpenAI-reasoning
  // model's {low, medium, high}): the intersected shared option set can collapse to HIGH-TIER
  // ONLY. The generic rank-distance fallback below has no notion of any provider's opt-in floor,
  // so unguarded it would map a non-explicit request (e.g. the app's "medium" default, or the
  // request left unspecified) onto "high" -- silently enabling the slow/expensive tier on a mere
  // model-selection change, defeating the exact opt-in guarantee every single-provider branch of
  // `normalizeReasoningEffortForModel` exists to give. Only let a high-tier value through here
  // when the caller's OWN requested effort was already explicitly high-tier; otherwise leave the
  // value unset (the previously-saved effort is re-normalized independently, per model, at call
  // time by `interactiveStrategyReasoningEffort`, so no request ever silently escalates).
  const sharedValue = normalizeReasoningEffortForOptions(control.options, effort);
  if (HIGH_TIER_REASONING_EFFORTS.has(sharedValue) && !HIGH_TIER_REASONING_EFFORTS.has(effort ?? "medium")) {
    return undefined;
  }
  return sharedValue;
}
