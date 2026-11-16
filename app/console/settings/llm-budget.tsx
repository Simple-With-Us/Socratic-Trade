"use client";

/** Per-user daily AI spend cap. Blank = no user cap. When a cap is set,
 *  strategy, chat, and research skip for the rest of the day once spend
 *  reaches it. */

import { useCallback, useEffect, useState } from "react";
import { ConsoleApiError } from "../lib/api";
import { type AutoSaveStatus } from "../lib/useAutoSave";
import { useToast } from "../ui/toast";
import { Card, Chip, Field, RawNumInput } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";
import {
  fetchLlmBudget,
  patchLlmBudget,
  type LlmBudgetLimitSource,
  type LlmBudgetResponse
} from "./lib";

function sourceLabel(source: LlmBudgetLimitSource): string {
  switch (source) {
    case "user":
      return "you";
    case "policy":
      return "account";
    case "env":
      return "default";
    case "none":
      return "no cap";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function sourceTone(source: LlmBudgetLimitSource): "pos" | "muted" | "accent" {
  if (source === "user") return "pos";
  if (source === "none") return "muted";
  return "accent";
}

export function LlmBudgetCard() {
  const toast = useToast();
  const [data, setData] = useState<LlmBudgetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<AutoSaveStatus>("idle");
  const [draft, setDraft] = useState<{ tokenBudget?: number; costBudgetUsd?: number }>({});

  const load = useCallback(async () => {
    try {
      const next = await fetchLlmBudget();
      setData(next);
      setDraft({});
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ConsoleApiError ? err.message : "Could not load the daily AI budget.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tokenSaved = data?.tokenBudget ?? undefined;
  const costSaved = data?.costBudgetUsd ?? undefined;
  const tokenDraft = Object.prototype.hasOwnProperty.call(draft, "tokenBudget") ? draft.tokenBudget : tokenSaved;
  const costDraft = Object.prototype.hasOwnProperty.call(draft, "costBudgetUsd") ? draft.costBudgetUsd : costSaved;

  const commit = async (field: "tokenBudget" | "costBudgetUsd", next: number | undefined, saved: number | undefined) => {
    const normalized = next !== undefined && next >= 0 ? next : null;
    const savedNorm = saved !== undefined ? saved : null;
    if (normalized === savedNorm) return;
    setBusy(true);
    setSaveStatus("saving");
    try {
      setData(await patchLlmBudget({ [field]: normalized }));
      setDraft((d) => {
        const copy = { ...d };
        delete copy[field];
        return copy;
      });
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      toast.push("neg", "Could not save", err instanceof ConsoleApiError ? err.message : String(err));
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Daily AI Budget" action={<SaveStatus status={saveStatus} />}>
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Optional daily limit for model and research spend on your account.  Leave a field blank for
        no cap.  When a cap is set, strategy, chat, and research pause for the rest of the day once
        spend reaches it.
      </p>

      {loadError && (
        <p className="mb-3 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}

      {data && (
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          Today: {data.today.tokens.toLocaleString()} tokens · ${data.today.costUsd.toFixed(2)}
          {data.enforced ? " · cap is on" : " · no cap"}
        </p>
      )}

      <div className="grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Daily Token Cap"
          hint="Positive number.  Blank means no token cap.  Saves when you click away."
          htmlFor="llm-token-budget"
        >
          <div className="flex items-center gap-2">
            <RawNumInput
              id="llm-token-budget"
              className="w-full"
              value={tokenDraft === undefined ? "" : String(tokenDraft)}
              emptyValue={-1}
              min={0}
              disabled={busy || data === null}
              onValueChange={(n) => setDraft((d) => ({ ...d, tokenBudget: n >= 0 ? n : undefined }))}
              onBlur={() => void commit("tokenBudget", tokenDraft, tokenSaved)}
              aria-label="Daily token cap"
            />
            {data && (
              <Chip tone={sourceTone(data.effective.tokenSource)} title="Where the effective token cap comes from">
                {sourceLabel(data.effective.tokenSource)}
              </Chip>
            )}
          </div>
        </Field>
        <Field
          label="Daily Cost Cap ($)"
          hint="Estimated USD.  Blank means no dollar cap.  Saves when you click away."
          htmlFor="llm-cost-budget"
        >
          <div className="flex items-center gap-2">
            <RawNumInput
              id="llm-cost-budget"
              className="w-full"
              value={costDraft === undefined ? "" : String(costDraft)}
              emptyValue={-1}
              min={0}
              step={0.01}
              disabled={busy || data === null}
              onValueChange={(n) => setDraft((d) => ({ ...d, costBudgetUsd: n >= 0 ? n : undefined }))}
              onBlur={() => void commit("costBudgetUsd", costDraft, costSaved)}
              aria-label="Daily cost cap in dollars"
            />
            {data && (
              <Chip tone={sourceTone(data.effective.costSource)} title="Where the effective cost cap comes from">
                {sourceLabel(data.effective.costSource)}
              </Chip>
            )}
          </div>
        </Field>
      </div>

      {data && (data.tokenBudget !== null || data.costBudgetUsd !== null) && (
        <button
          type="button"
          className="mt-3 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] underline-offset-2 hover:underline"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setSaveStatus("saving");
              try {
                setData(await patchLlmBudget({ tokenBudget: null, costBudgetUsd: null }));
                setDraft({});
                setSaveStatus("saved");
              } catch (err) {
                setSaveStatus("error");
                toast.push("neg", "Could not save", err instanceof ConsoleApiError ? err.message : String(err));
                await load();
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          Clear Both Caps
        </button>
      )}
    </Card>
  );
}
