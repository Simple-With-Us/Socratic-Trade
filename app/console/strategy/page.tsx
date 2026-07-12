"use client";

/** Strategy — how this account trades: the strategist's written instructions
 *  (prompt), the models, the eight scoring-factor weights, and the preset
 *  library. Always account-scoped; the header repeats the scope. Presets are
 *  copy-not-link and can never arm or disarm anything (server-enforced). */

import { useMemo, useState } from "react";
import { Lock, Unlock } from "lucide-react";
import type { LlmReasoningEffort, ScoringWeights, StrategyTuningPatch, TradingPolicy } from "@/lib/types";
import {
  reasoningCapabilityForModel,
  normalizeReasoningEffortForModel,
  normalizeReasoningEffortForOptions,
  type LlmReasoningCapability,
  type LlmReasoningOption
} from "@/lib/llm-request";
// Pure curated-model DATA (no legacy UI components) — the same catalog the rest
// of the app offers, so the console review picker stays consistent with it.
import { CURATED_LLM_MODEL_GROUPS, CURATED_LLM_MODEL_IDS, CUSTOM_MODEL_ID_SEED } from "../../ui/llm-model-catalog";
import {
  activateProfile,
  copyProfileToAccount,
  savePolicy,
  tuneStrategy,
  ConsoleApiError,
  type StrategyTuneResult
} from "../lib/api";
import { activeConnectedAccount, deriveReality, type RealityInfo } from "../lib/derive";
import { EM_DASH } from "../lib/format";
import { classify, getAtPath, type FieldDef } from "../lib/policy-diff";
import { useConsoleData } from "../lib/useConsoleData";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { ALL_DEFS } from "../guardrails/field-defs";
import { TypedConfirm } from "../components/chrome";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Empty, Field, LiveTag, RawNumInput, Select, TextArea, TextInput } from "../ui/primitives";

/** Shipped default weights (src/lib/defaults.ts) — shown as ghost reference. */
const DEFAULT_WEIGHTS: ScoringWeights = {
  liquidity: 1.4,
  momentum: 1.2,
  value: 0.8,
  quality: 0.8,
  volatility: 0.8,
  sentiment: 0.6,
  positioning: 0.8,
  diversification: 1
};

const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoringWeights>;
const CUSTOM_MODEL_OPTION = CUSTOM_MODEL_ID_SEED;

function isCuratedModel(model: string | undefined): boolean {
  return !!model && CURATED_LLM_MODEL_IDS.includes(model);
}

function modelSelectValue(model: string | undefined): string {
  if (!model) return "";
  return model;
}

function modelProviderLabel(model: string | undefined): string {
  if (!model) return "Not Set";
  const group = CURATED_LLM_MODEL_GROUPS.find((g) => g.options.some((option) => option.value === model));
  return group?.label ?? "Custom Provider";
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function reasoningControlForModels(models: string[]): { label: string; hint: string; options: LlmReasoningOption[]; capabilities: LlmReasoningCapability[] } | null {
  const capabilities = uniq(models.map((model) => model.trim()).filter(Boolean))
    .map((model) => reasoningCapabilityForModel(model))
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
    hint: `${labels} are active. Only values supported by every selected model are shown.`,
    options,
    capabilities: uniqueCapabilities
  };
}

function reasoningSummary(control: ReturnType<typeof reasoningControlForModels>): string {
  if (!control) return "These selected models do not expose a provider-specific reasoning or thinking control here.";
  return `${control.capabilities.map((capability) => capability.label).join(" + ")} active.`;
}

function normalizeReasoningValueForControl(
  models: string[],
  control: ReturnType<typeof reasoningControlForModels>,
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort | undefined {
  if (!control) return undefined;
  if (control.capabilities.length === 1) {
    const provider = control.capabilities[0]!.provider;
    const model = models.find((candidate) => reasoningCapabilityForModel(candidate)?.provider === provider);
    return normalizeReasoningEffortForModel(model, effort) ?? normalizeReasoningEffortForOptions(control.options, effort);
  }
  return normalizeReasoningEffortForOptions(control.options, effort);
}

function ModelSelect({
  id,
  value,
  onChange,
  allowBlank,
  blankLabel,
  role
}: {
  id: string;
  value: string | undefined;
  onChange: (model: string) => void;
  allowBlank?: boolean;
  blankLabel?: string;
  role: "proposer" | "red-team";
}) {
  const selectValue = modelSelectValue(value);
  const custom = selectValue === CUSTOM_MODEL_OPTION;
  const customCurrent = value && !isCuratedModel(value) && value !== CUSTOM_MODEL_OPTION ? value : null;
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        value={selectValue}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === CUSTOM_MODEL_OPTION ? (custom ? (value ?? CUSTOM_MODEL_OPTION) : CUSTOM_MODEL_OPTION) : next);
        }}
      >
        {allowBlank && <option value="">{blankLabel ?? "Not Set"}</option>}
        {customCurrent && (
          <option value={customCurrent} title="A model id outside the curated list, kept exactly as stored.">
            {customCurrent} - custom id
          </option>
        )}
        {CURATED_LLM_MODEL_GROUPS.map((group) => (
          <optgroup key={group.provider} label={group.label}>
            {group.options.map((option) => {
              const label = role === "proposer" && option.recommendedGreen
                ? `${option.label} (Rec Proposer)`
                : role === "red-team" && option.recommendedRed
                ? `${option.label} (Rec Reviewer)`
                : option.label;
              return (
                <option key={option.value} value={option.value}>
                  {label}
                </option>
              );
            })}
          </optgroup>
        ))}
        <option value={CUSTOM_MODEL_OPTION}>Custom Model ID...</option>
      </Select>
      {custom && (
        <TextInput
          value={value && value !== CUSTOM_MODEL_OPTION ? value : ""}
          placeholder="provider-model-id"
          onChange={(event) => onChange(event.target.value)}
          title="Type an exact provider model ID if it is not in the curated list."
        />
      )}
    </div>
  );
}

export default function StrategyPage() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();

  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<{ llmModel?: string; redTeamLlmModel?: string; llmReasoningEffort?: LlmReasoningEffort } | null>(null);
  const [weightsDraft, setWeightsDraft] = useState<Partial<Record<keyof ScoringWeights, number>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  // Unsaved-draft registration must run unconditionally (before the null return).
  useUnsavedChanges(
    (promptDraft !== null && promptDraft !== snapshot?.strategyPrompt) || modelDraft !== null || weightsDraft !== null
  );
  if (!snapshot || !reality) return null;

  const policy = snapshot.policy;
  const activeAccount = activeConnectedAccount(snapshot);
  const prompt = promptDraft ?? snapshot.strategyPrompt;
  const promptDirty = promptDraft !== null && promptDraft !== snapshot.strategyPrompt;
  const proposerModel = modelDraft?.llmModel ?? policy.llmModel ?? "";
  const redTeamModel = modelDraft?.redTeamLlmModel ?? policy.redTeamLlmModel ?? "";
  const effectiveRedTeamModel = redTeamModel || proposerModel;
  const showCustomModelWarning = (proposerModel && !isCuratedModel(proposerModel)) || (effectiveRedTeamModel && !isCuratedModel(effectiveRedTeamModel));
  const reasoningModels = [proposerModel, effectiveRedTeamModel];
  const reasoningControl = reasoningControlForModels(reasoningModels);
  const reasoningValue = reasoningControl
    ? normalizeReasoningValueForControl(reasoningModels, reasoningControl, modelDraft?.llmReasoningEffort ?? policy.llmReasoningEffort)
    : undefined;

  const save = async (label: string, body: Record<string, unknown>, after?: () => void) => {
    setBusy(label);
    try {
      await savePolicy(body);
      await refresh();
      after?.();
      toast.push("pos", `${label} saved`, "Takes effect on the next run.");
    } catch (error) {
      toast.push("neg", `${label} not saved`, error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Strategy</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "no connected account"} — each account has its own strategy
        </span>
      </div>

      {/* Prompt */}
      <Card
        title="The strategist's written instructions"
        action={
          promptDirty ? (
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setPromptDraft(null)}>
                Discard
              </Btn>
              <Btn variant="primary" size="sm" disabled={busy !== null} onClick={() => void save("Prompt", { strategyPrompt: promptDraft }, () => setPromptDraft(null))}>
                {busy === "Prompt" ? "Saving…" : "Save prompt"}
              </Btn>
            </div>
          ) : undefined
        }
      >
        <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Free-text brief the proposer LLM runs under: objective, selection logic, sell rules, sizing guidance, output
          contract. The deterministic policy gate still constrains everything it proposes.
        </p>
        <TextArea rows={16} value={prompt} onChange={(e) => setPromptDraft(e.target.value)} spellCheck={false} />
      </Card>

      {/* Models */}
      <Card
        title="Models"
        action={
          modelDraft ? (
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setModelDraft(null)}>
                Discard
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  if (!modelDraft) return;
                  const body = reasoningControl && reasoningValue ? { ...modelDraft, llmReasoningEffort: reasoningValue } : modelDraft;
                  void save("Models", body, () => setModelDraft(null));
                }}
              >
                {busy === "Models" ? "Saving…" : "Save models"}
              </Btn>
            </div>
          ) : undefined
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Proposer model" hint="The bull-side strategist." htmlFor="llm-model">
            <ModelSelect
              id="llm-model"
              value={proposerModel}
              role="proposer"
              onChange={(model) => setModelDraft((d) => ({ ...(d ?? {}), llmModel: model }))}
            />
          </Field>
          <Field
            label="Red-team model"
            hint="The bear-side reviewer that tries to kill high-conviction ideas. Blank = same as proposer."
            htmlFor="rt-model"
          >
            <ModelSelect
              id="rt-model"
              value={redTeamModel}
              allowBlank
              blankLabel="Same As Proposer"
              role="red-team"
              onChange={(model) => setModelDraft((d) => ({ ...(d ?? {}), redTeamLlmModel: model }))}
            />
          </Field>
        </div>
        {showCustomModelWarning && (
          <div className="mt-3 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50 rounded-md p-2.5 flex items-start gap-1.5">
            <svg className="h-4 w-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div>
              Custom model selected. Cost tracking will use a conservative fallback rate to prevent budget bypass.
            </div>
          </div>
        )}
        <div className="mt-3 rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Proposer: {modelProviderLabel(proposerModel)}. Red Team: {modelProviderLabel(effectiveRedTeamModel)}.
          {" "}
          {reasoningSummary(reasoningControl)}
        </div>
        {reasoningControl && reasoningValue && (
          <div className="mt-3 max-w-xs">
            <Field
              label={reasoningControl.label}
              hint={reasoningControl.hint}
              htmlFor="effort"
            >
              <Select
                id="effort"
                value={reasoningValue}
                onChange={(e) => setModelDraft((d) => ({ ...(d ?? {}), llmReasoningEffort: e.target.value as LlmReasoningEffort }))}
              >
                {reasoningControl.options.map((option) => (
                  <option key={option.value} value={option.value} title={option.hint}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Card>

      {/* Scoring weights */}
      <Card
        title="Scoring-factor weights"
        action={
          weightsDraft ? (
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setWeightsDraft(null)}>
                Discard
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={() => void save("Weights", { scoringWeights: weightsDraft }, () => setWeightsDraft(null))}
              >
                {busy === "Weights" ? "Saving…" : "Save weights"}
              </Btn>
            </div>
          ) : undefined
        }
      >
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          The market scan ranks candidates by these eight factors before the strategist ever sees them. Defaults shown
          under each field.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {WEIGHT_KEYS.map((key) => {
            const current = weightsDraft?.[key] ?? policy.scoringWeights?.[key] ?? DEFAULT_WEIGHTS[key];
            return (
              <Field key={key} label={key} hint={`default ${DEFAULT_WEIGHTS[key]}`} htmlFor={`w-${key}`}>
                <RawNumInput
                  id={`w-${key}`}
                  step="0.1"
                  min="0"
                  value={String(current)}
                  emptyValue={DEFAULT_WEIGHTS[key]}
                  onValueChange={(parsed) => setWeightsDraft((d) => ({ ...(d ?? {}), [key]: parsed }))}
                />
              </Field>
            );
          })}
        </div>
      </Card>

      {/* AI review */}
      <AiReviewPanel policy={policy} strategyPrompt={snapshot.strategyPrompt} reality={reality} />

      {/* Presets */}
      <Card title="Preset library">
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Applying a preset copies its policy, prompt, and weights onto the active account — copy, not link: later edits
          to the preset never follow. A preset can never start or stop the strategy; your run state is always preserved.
        </p>
        {snapshot.profiles.length === 0 ? (
          <Empty>No presets saved yet.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.profiles.map((profile) => {
              // "applied" = what THIS account is running (policy.activeProfileId,
              // stamped by the copy/apply path). Fall back to the library active
              // flag only when the account has never had a preset applied.
              const applied = policy.activeProfileId ? policy.activeProfileId === profile.id : profile.active;
              return (
                <div key={profile.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--con-line)] p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{profile.name || EM_DASH}</span>
                      {applied && <Chip tone="accent">applied here</Chip>}
                    </div>
                    <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                      updated <Ago iso={profile.updatedAt} />
                    </div>
                  </div>
                  {!applied && (
                    <Btn
                      size="sm"
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy(`profile-${profile.id}`);
                        try {
                          if (activeAccount) {
                            // Preferred path: POST /api/profiles/[id]/copy — writes ONLY this
                            // account's live strategy state and preserves its run-state and the
                            // library active flag (applyProfileToAccount, server-enforced).
                            await copyProfileToAccount(profile.id, activeAccount.id);
                            toast.push("pos", `Applied “${profile.name}”`, "Copied onto this account. Run state unchanged.");
                          } else {
                            // No connected account (fresh local install): the copy route has no
                            // target, so fall back to library activation of the base policy.
                            await activateProfile(profile.id);
                            toast.push("pos", `Activated “${profile.name}”`, "Applied as the base strategy for new account scope.");
                          }
                          await refresh();
                        } catch (error) {
                          toast.push("neg", "Preset not applied", error instanceof ConsoleApiError ? error.message : String(error));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === `profile-${profile.id}` ? "Applying…" : "Apply to this account"}
                    </Btn>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── AI review (#12) ──────────────────────────────────────────────────────────

interface ReviewChange {
  key: string;
  label: string;
  from: string;
  to: string;
  direction: "looser" | "tighter" | "changed";
}

const DEFS_BY_PATH = new Map<string, FieldDef>(ALL_DEFS.map((def) => [def.path, def]));

function fmtRaw(def: FieldDef | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return "unset";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    if (def?.kind === "money") return `$${value}`;
    if (def?.kind === "pct") return `${value}%`;
    if (def?.kind === "minutes") return `${value} min`;
    if (def?.kind === "seconds") return `${value} s`;
    return String(value);
  }
  return String(value);
}

function ReviewDirectionTag({ direction }: { direction: ReviewChange["direction"] }) {
  if (direction === "changed") return null;
  const unlocks = direction === "looser";
  const Icon = unlocks ? Unlock : Lock;
  const label = unlocks ? "Unlocks" : "Locks Down";
  const title = unlocks
    ? "Raises a cap, removes a protection, broadens the universe, or otherwise expands trading authority."
    : "Adds a protection, lowers a cap, narrows the universe, or otherwise restricts trading authority.";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-current px-1.5 py-0.5 text-[length:var(--con-fs-xs)] font-bold"
      style={{ color: unlocks ? "var(--con-warn)" : "var(--con-pos)" }}
      title={title}
    >
      <Icon size={12} aria-hidden />
      {label}
    </span>
  );
}

/** Flatten the tune proposal's policy/weights patch into labeled from→to rows,
 *  classified LOOSER/TIGHTER via the same guardrail metadata the Guardrails
 *  editor uses — so brokerage loosening costs the same typed word here too. */
function reviewChanges(patch: StrategyTuningPatch, policy: TradingPolicy): ReviewChange[] {
  const rows: ReviewChange[] = [];

  const push = (path: string, label: string, from: unknown, to: unknown, direction?: ReviewChange["direction"]) => {
    const same = (from === undefined && to === undefined) || from === to;
    if (same) return;
    const def = DEFS_BY_PATH.get(path);
    rows.push({
      key: path,
      label,
      from: fmtRaw(def, from),
      to: fmtRaw(def, to),
      direction: direction ?? (def ? classify(def, from, to) : "changed")
    });
  };

  for (const [k, v] of Object.entries(patch.scoringWeights ?? {})) {
    push(`scoringWeights.${k}`, `Weight: ${k}`, policy.scoringWeights?.[k as keyof ScoringWeights], v);
  }

  const p = patch.policy ?? {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "riskRules" || k === "sectorCaps") continue;
    if (k === "strategyAuthority") {
      const from = policy.strategyAuthority;
      if (v !== from) {
        // propose→decide arms Autopilot — the loosest possible move.
        push(k, "Autonomy", from === "decide" ? "Autopilot" : "Ask-first", v === "decide" ? "Autopilot" : "Ask-first", v === "decide" ? "looser" : "tighter");
      }
      continue;
    }
    push(k, DEFS_BY_PATH.get(k)?.label ?? k, getAtPath(policy, k), v);
  }
  for (const [k, v] of Object.entries(p.riskRules ?? {})) {
    push(`riskRules.${k}`, DEFS_BY_PATH.get(`riskRules.${k}`)?.label ?? `riskRules.${k}`, getAtPath(policy, `riskRules.${k}`), v);
  }
  for (const [k, v] of Object.entries(p.sectorCaps ?? {})) {
    const from = policy.sectorCaps?.[k];
    if (from === v) continue;
    rows.push({
      key: `sectorCaps.${k}`,
      label: `Sector cap: ${k}`,
      from: from === undefined ? "unset" : `${from}%`,
      to: `${v}%`,
      // Raising a sector cap allows more concentration — looser.
      direction: typeof from === "number" ? (v > from ? "looser" : "tighter") : "changed"
    });
  }
  return rows;
}

function AiReviewPanel({
  policy,
  strategyPrompt,
  reality
}: {
  policy: TradingPolicy;
  strategyPrompt: string;
  reality: RealityInfo;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [model, setModel] = useState<string>("");
  const [reviewReasoning, setReviewReasoning] = useState<LlmReasoningEffort | undefined>(undefined);
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [review, setReview] = useState<StrategyTuneResult | null>(null);
  const [typed, setTyped] = useState("");
  useUnsavedChanges(review !== null);

  const inheritedReviewerModel = policy.redTeamLlmModel || policy.llmModel || "";
  const inheritedReviewerLabel = policy.redTeamLlmModel ? "Red Team" : "Green Team";
  const reviewerModel = model || inheritedReviewerModel;
  const reviewerReasoningControl = reasoningControlForModels([reviewerModel]);
  const reviewerReasoningValue = reviewerReasoningControl
    ? normalizeReasoningValueForControl([reviewerModel], reviewerReasoningControl, reviewReasoning ?? policy.llmReasoningEffort)
    : undefined;
  const changes = useMemo(() => (review ? reviewChanges(review.proposedPatch, policy) : []), [review, policy]);
  const promptChanged = Boolean(review?.proposedPatch.prompt && review.proposedPatch.prompt !== strategyPrompt);
  const hasAnyChange = changes.length > 0 || promptChanged;
  const hasLooser = changes.some((c) => c.direction === "looser");
  const needsTyped = reality.tone === "live" && hasLooser;

  const generate = async () => {
    setBusy("review");
    try {
      const result = await tuneStrategy(model || undefined, reviewerReasoningValue);
      setReview(result);
      setTyped("");
    } catch (error) {
      toast.push("neg", "Review failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!review) return;
    const patch = review.proposedPatch;
    setBusy("apply");
    try {
      const { riskRules, sectorCaps, ...policyRest } = patch.policy ?? {};
      // Same write path as every other strategy edit: PUT /api/policy. The server
      // deep-merges scoringWeights/riskRules; sectorCaps is whole-replace, so merge
      // over the current caps here to keep untouched sectors intact.
      await savePolicy({
        ...policyRest,
        ...(riskRules ? { riskRules } : {}),
        ...(sectorCaps ? { sectorCaps: { ...policy.sectorCaps, ...sectorCaps } } : {}),
        ...(patch.scoringWeights ? { scoringWeights: patch.scoringWeights } : {}),
        ...(patch.prompt ? { strategyPrompt: patch.prompt } : {})
      });
      await refresh();
      setReview(null);
      setTyped("");
      toast.push("pos", "Review changes applied", "Takes effect on the next run.");
    } catch (error) {
      toast.push("neg", "Not applied", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="AI review"
      action={
        review ? (
          <Btn variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setReview(null); setTyped(""); }}>
            Discard
          </Btn>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        A reviewer model reads this account&apos;s recent performance, missed opportunities, factor evidence, and the
        market backdrop, then proposes prompt/weight/guardrail changes. Nothing is applied until you review the exact
        diff and commit it — the same rules as editing by hand, including a typed word for LIVE authority expansion.
      </p>

      {!review ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Field
              label="Reviewer model"
              hint={`Blank = same as ${inheritedReviewerLabel}. AI Review has no separate account-level model.`}
              htmlFor="ai-review-model"
            >
              <Select id="ai-review-model" value={model} onChange={(e) => { setModel(e.target.value); setReviewReasoning(undefined); }}>
                <option value="">Same As {inheritedReviewerLabel}</option>
                {CURATED_LLM_MODEL_GROUPS.map((group) => (
                  <optgroup key={group.provider} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
          </div>
          {reviewerReasoningControl && reviewerReasoningValue && (
            <div className="w-56">
              <Field label={reviewerReasoningControl.label} hint={reviewerReasoningControl.hint} htmlFor="ai-review-effort">
                <Select
                  id="ai-review-effort"
                  value={reviewerReasoningValue}
                  onChange={(e) => setReviewReasoning(e.target.value as LlmReasoningEffort)}
                >
                  {reviewerReasoningControl.options.map((option) => (
                    <option key={option.value} value={option.value} title={option.hint}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <Btn variant="primary" disabled={busy !== null} onClick={() => void generate()}>
            {busy === "review" ? "Reviewing…" : "Generate review"}
          </Btn>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={review.generatedBy === "llm" ? "accent" : "muted"}>
              {review.generatedBy === "llm" ? "LLM review" : "local rules (no LLM)"}
            </Chip>
            <span className="con-num text-[color:var(--con-muted)]">Confidence {review.confidenceScore}/100</span>
          </div>
          <p className="leading-relaxed">{review.summary}</p>
          {review.rationale && <p className="leading-relaxed text-[color:var(--con-muted)]">{review.rationale}</p>}
          {(review.marketContext || review.performanceReadout) && (
            <details className="con-disclosure">
              <summary>Evidence the reviewer saw</summary>
              <div className="flex flex-col gap-2 pb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {review.performanceReadout && <p>{review.performanceReadout}</p>}
                {review.marketContext && <p>{review.marketContext}</p>}
              </div>
            </details>
          )}
          {review.cautions.length > 0 && (
            <ul className="list-disc pl-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
              {review.cautions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}

          {/* The diff — exactly what Apply would write. */}
          <div className="rounded-lg border border-[color:var(--con-line)] p-3">
            <div className="con-card-title mb-1">Proposed changes</div>
            {!hasAnyChange ? (
              <p className="text-[color:var(--con-muted)]">No changes proposed — the reviewer left everything as is.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
                {promptChanged && (
                  <details className="con-disclosure">
                    <summary>Prompt rewrite proposed</summary>
                    <div className="grid gap-2 pb-2 sm:grid-cols-2">
                      <div>
                        <div className="con-card-title mb-1">Current</div>
                        <pre className="con-mono max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[color:var(--con-surface-2)] p-2 text-[10px] leading-relaxed">{strategyPrompt}</pre>
                      </div>
                      <div>
                        <div className="con-card-title mb-1">Proposed</div>
                        <pre className="con-mono max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[color:var(--con-surface-2)] p-2 text-[10px] leading-relaxed">{review.proposedPatch.prompt}</pre>
                      </div>
                    </div>
                  </details>
                )}
                {changes.map((c) => (
                  <div key={c.key} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="font-semibold">{c.label}</span>
                    <span className="con-num flex items-center gap-2">
                      <span className="text-[color:var(--con-faint)]">{c.from}</span>
                      <span className="text-[color:var(--con-faint)]">→</span>
                      <span>{c.to}</span>
                      <ReviewDirectionTag direction={c.direction} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {hasAnyChange &&
            (needsTyped ? (
              <TypedConfirm
                phrase="CONFIRM"
                value={typed}
                onChange={setTyped}
                busy={busy === "apply"}
                variant="primary"
                confirmLabel={
                  <>
                    Apply review changes <LiveTag />
                  </>
                }
                note="At least one proposed change expands authority on a brokerage account. Unlocking authority costs a typed word here exactly like it does in Guardrails."
                onConfirm={() => void apply()}
              />
            ) : (
              <div className="flex justify-end gap-2">
                <Btn variant="ghost" disabled={busy !== null} onClick={() => { setReview(null); setTyped(""); }}>
                  Discard
                </Btn>
                <Btn variant="primary" disabled={busy !== null} onClick={() => void apply()}>
                  {busy === "apply" ? "Applying…" : "Apply changes"}
                </Btn>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
