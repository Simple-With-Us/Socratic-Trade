"use client";

/** LLM models — pick the strategist (green team, `llmModel`) and the reviewer
 *  (red team, `redTeamLlmModel`) for THIS account's policy, saved through the
 *  same PUT /api/policy path every other settings card uses. Native grouped
 *  <select>s; providers whose key doesn't resolve (per GET /api/chat/providers)
 *  have their options disabled and annotated instead of silently failing at
 *  run time. */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CHAT_MODEL_STORAGE_KEY, DEFAULT_CHAT_MODEL } from "../assistant/models";
import { savePolicy, ConsoleApiError } from "../lib/api";
import { useConsoleData } from "../lib/useConsoleData";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { useToast } from "../ui/toast";
import { Btn, Card, Field, Select } from "../ui/primitives";
import { fetchChatProviders } from "./lib";

/** Curated model catalog — a console-local copy of the data in
 *  app/ui/llm-model-catalog.ts (values/labels only; the console imports no
 *  legacy UI). Keep the two lists in sync when models are added. */
interface ModelOption {
  value: string;
  label: string;
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
}

interface ModelGroup {
  provider: string;
  label: string;
  options: ModelOption[];
}

const MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "openai",
    label: "OpenAI",
    options: [
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano — lowest cost OpenAI · $" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini — balanced default · $$", recommendedGreen: true },
      { value: "gpt-5.4", label: "gpt-5.4 — stronger analysis · $$$" },
      { value: "gpt-5.5", label: "gpt-5.5 — deepest OpenAI reasoning · $$$" }
    ]
  },
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    options: [
      { value: "claude-haiku-4-5", label: "claude-haiku-4-5 — fast Claude review · $" },
      { value: "claude-sonnet-5", label: "claude-sonnet-5 — balanced Claude analysis · $$", recommendedRed: true },
      { value: "claude-opus-4-8", label: "claude-opus-4-8 — premium Claude critique · $$$" },
      { value: "claude-fable-5", label: "claude-fable-5 — most capable Claude · $$$" }
    ]
  },
  {
    provider: "xai",
    label: "xAI (Grok)",
    options: [
      { value: "grok-build-0.1", label: "grok-build-0.1 — coding specialist · $" },
      { value: "grok-4.3", label: "grok-4.3 — default Grok analysis · $$" }
    ]
  },
  {
    provider: "gemini",
    label: "Google (Gemini)",
    options: [
      { value: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite — low-cost Gemini · $" },
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash — stable flagship Flash · $$", recommendedGreen: true },
      { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview — preview Pro reasoning · $$$", recommendedRed: true }
    ]
  },
  {
    provider: "mistral",
    label: "Mistral",
    options: [
      { value: "mistral-small-2603", label: "mistral-small-2603 — low-cost Mistral Small 4 · $" },
      { value: "mistral-medium-3-5", label: "mistral-medium-3-5 — frontier Mistral Medium · $$" }
    ]
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    options: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash — fast DeepSeek V4 · $" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro — stronger DeepSeek V4 · $$", recommendedGreen: true, recommendedRed: true }
    ]
  }
];

const CATALOG_IDS = new Set(MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.value)));

function ModelSelect({
  id,
  value,
  emptyLabel,
  emptyTitle,
  providers,
  title,
  role,
  onChange
}: {
  id: string;
  value: string;
  emptyLabel: string;
  emptyTitle: string;
  providers: Record<string, boolean> | null;
  title: string;
  role?: "proposer" | "red-team" | "coach";
  onChange: (next: string) => void;
}) {
  // A stored model id outside the catalog (typed on the Strategy screen or by
  // an older UI) still has to show as selected — never lie about the config.
  const customCurrent = value && !CATALOG_IDS.has(value) ? value : null;
  return (
    <Select id={id} value={value} title={title} onChange={(e) => onChange(e.target.value)}>
      <option value="" title={emptyTitle}>
        {emptyLabel}
      </option>
      {customCurrent && (
        <option value={customCurrent} title="A model id outside the curated list, kept exactly as stored.">
          {customCurrent} — custom id
        </option>
      )}
      {MODEL_GROUPS.map((group) => {
        // null = availability unknown (endpoint unreachable): don't disable anything.
        const hasKey = providers === null ? true : Boolean(providers[group.provider]);
        return (
          <optgroup key={group.provider} label={hasKey ? group.label : `${group.label} — no key`}>
            {group.options.map((option) => {
              const baseLabel = hasKey ? option.label : `${option.label} (no key configured)`;
              const label = role === "proposer" && option.recommendedGreen
                ? `${baseLabel} (Rec Proposer)`
                : role === "red-team" && option.recommendedRed
                ? `${baseLabel} (Rec Reviewer)`
                : baseLabel;
              return (
                <option key={option.value} value={option.value} disabled={!hasKey && option.value !== value}>
                  {label}
                </option>
              );
            })}
          </optgroup>
        );
      })}
    </Select>
  );
}

export function ModelsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draft, setDraft] = useState<{ llmModel?: string; redTeamLlmModel?: string } | null>(null);
  const [coachModel, setCoachModel] = useState("");
  const [providers, setProviders] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(draft !== null);

  useEffect(() => {
    let cancelled = false;
    fetchChatProviders()
      .then(({ providers: p }) => {
        if (!cancelled) setProviders(p);
      })
      .catch(() => {
        // Availability is advisory only — with the endpoint unreachable we
        // leave every option enabled rather than falsely disabling providers.
        if (!cancelled) setProviders(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
    setCoachModel(saved || DEFAULT_CHAT_MODEL);
  }, []);

  const pickCoachModel = (next: string) => {
    const model = next || DEFAULT_CHAT_MODEL;
    setCoachModel(model);
    window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, model);
    toast.push("info", "Coach model saved", "This browser will use it on the Coach page.");
  };

  const policy = snapshot?.policy;
  const green = draft?.llmModel !== undefined ? draft.llmModel : (policy?.llmModel ?? "");
  const red = draft?.redTeamLlmModel !== undefined ? draft.redTeamLlmModel : (policy?.redTeamLlmModel ?? "");

  const selectedNoKey = useMemo(() => {
    if (!providers) return [];
    const out: string[] = [];
    for (const model of [green, red, coachModel]) {
      if (!model) continue;
      const group = MODEL_GROUPS.find((g) => g.options.some((o) => o.value === model));
      if (group && !providers[group.provider] && !out.includes(group.label)) out.push(group.label);
    }
    return out;
  }, [providers, green, red, coachModel]);

  if (!snapshot || !policy) return null;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      // "" → null: the policy route strips nulls back to absent, which is how
      // an optional model field is actually cleared (empty string is rejected).
      await savePolicy({
        ...(draft.llmModel !== undefined ? { llmModel: draft.llmModel || null } : {}),
        ...(draft.redTeamLlmModel !== undefined ? { redTeamLlmModel: draft.redTeamLlmModel || null } : {})
      });
      await refresh();
      setDraft(null);
      toast.push("pos", "Models saved", "Takes effect on the next run.");
    } catch (error) {
      toast.push("neg", "Models not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const isCurated = (m: string) => !m || CATALOG_IDS.has(m);
  const showCustomWarning = (green && !isCurated(green)) || (red && !isCurated(red));

  return (
    <Card
      title="LLM models"
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            href="/console/usage"
            className="con-btn con-btn-outline con-btn-sm"
            title="Open the LLM usage and estimated cost page for your user keys, grouped by model and workflow."
          >
            Usage &amp; Cost
          </Link>
          {draft && (
            <>
              <Btn variant="ghost" size="sm" onClick={() => setDraft(null)} title="Throw away the unsaved model choices.">
                Discard
              </Btn>
              <Btn variant="primary" size="sm" disabled={busy} onClick={() => void save()} title="Write both model choices to this account's policy.">
                {busy ? "Saving…" : "Save"}
              </Btn>
            </>
          )}
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Which models argue about your money. The strategist (green team) proposes trades; the reviewer / strategy-review
        model (red team) tries to kill high-conviction ideas before they reach you. Coach is browser-local and also
        adjustable on the Coach page. Providers without a resolvable key are marked — add one under API keys below.
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <Field
          label="Strategist (green team)"
          hint="Writes the trade proposals each run."
          htmlFor="models-green"
        >
          <ModelSelect
            id="models-green"
            value={green}
            emptyLabel="app default (gpt-5.4-mini)"
            emptyTitle="No explicit choice — the app's default strategist model is used (server config can override)."
            providers={providers}
            title="The model that generates trade proposals for this account. Cost tiers: $ cheapest — $$$ premium."
            role="proposer"
            onChange={(next) => setDraft((d) => ({ ...(d ?? {}), llmModel: next }))}
          />
        </Field>
        <Field
          label="Reviewer / Strategy Review (red team)"
          hint="Argues against high-conviction ideas. Blank = same model as the strategist."
          htmlFor="models-red"
        >
          <ModelSelect
            id="models-red"
            value={red}
            emptyLabel="same as strategist"
            emptyTitle="No separate reviewer — the strategist model reviews its own high-conviction ideas."
            providers={providers}
            title="The adversarial reviewer model. A different provider here gives a genuinely independent second opinion."
            role="red-team"
            onChange={(next) => setDraft((d) => ({ ...(d ?? {}), redTeamLlmModel: next }))}
          />
        </Field>
        <Field
          label="Coach"
          hint="Answers the Coach page. Saved in this browser; transcript remains server-side."
          htmlFor="models-coach"
        >
          <ModelSelect
            id="models-coach"
            value={coachModel}
            emptyLabel={`app default (${DEFAULT_CHAT_MODEL})`}
            emptyTitle="No browser override — the Coach uses the app default chat model."
            providers={providers}
            title="The model that answers on the Coach page. Use the Usage & Cost link to see spend history by model and workflow."
            role="coach"
            onChange={pickCoachModel}
          />
        </Field>
      </div>
      {showCustomWarning && (
        <div className="mt-3 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50 rounded-md p-2.5 flex items-start gap-1.5">
          <svg className="h-4 w-4 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
          <div>
            Custom model selected. Cost tracking will use a conservative fallback rate to prevent budget bypass.
          </div>
        </div>
      )}
      {selectedNoKey.length > 0 && (
        <p className="mt-2 rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {selectedNoKey.join(" and ")} currently has no resolvable key for you — runs with this selection will fail
          until a key is added under API keys below.
        </p>
      )}
    </Card>
  );
}
