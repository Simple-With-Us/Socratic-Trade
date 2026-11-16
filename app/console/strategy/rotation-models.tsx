"use client";

/** Rotation Models checklist (ST-4589): shown under a seat's model picker while that seat is on the
 *  rotate option.  The owner ticks which catalog models that seat may rotate between; nothing
 *  ticked = every eligible model rotates (the pre-ST-4589 behaviour).  Groups and rows come from the
 *  catalog-driven picker groups, so catalog rows added or removed later need no change here.
 *  Persists through the parent's policy save (`llmRotationModels` / `redTeamRotationModels`). */

import { isRetiredCatalogModel, isRotationOptInOnly } from "@/lib/llm-model-catalog";
import { CURATED_LLM_MODEL_GROUPS, CURATED_LLM_MODEL_IDS } from "../../ui/llm-model-catalog";
import { SENTENCE_GAP } from "../lib/format";
import { Btn } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";
import type { AutoSaveStatus } from "../lib/useAutoSave";

/** Next selection after toggling one model: catalog models in catalog order, then any stored
 *  non-catalog ids kept as they were (the checklist never silently drops them). */
export function toggleRotationModel(current: readonly string[], model: string, checked: boolean): string[] {
  const set = new Set(current);
  if (checked) set.add(model);
  else set.delete(model);
  const catalog = CURATED_LLM_MODEL_IDS.filter((id) => set.has(id));
  const custom = current.filter((id) => !CURATED_LLM_MODEL_IDS.includes(id) && set.has(id));
  return [...catalog, ...custom];
}

/** The models "Select All" ticks: every catalog model in the default pool (so "all ticked" and
 *  "nothing ticked" rotate over the same models), plus any opt-in-only model (cost-excluded or Code
 *  CLI-only) the owner ALREADY ticked, plus stored non-catalog ids.  Opt-in models are never ticked
 *  by Select All; they need their own explicit tick. */
export function selectAllRotationModels(current: readonly string[]): string[] {
  const set = new Set(current);
  const catalog = CURATED_LLM_MODEL_IDS.filter((id) => !isRotationOptInOnly(id) || set.has(id));
  const custom = current.filter((id) => !CURATED_LLM_MODEL_IDS.includes(id));
  return [...catalog, ...custom];
}

/** Stored ticks that are not offered catalog rows (a retired row, or an id that was never in the
 *  catalog).  Policies are not migrated, so these can sit in a saved rotation set; rotation ignores
 *  them, and the checklist shows them under "No Longer Offered" so the owner can see and untick them. */
export function staleRotationTicks(current: readonly string[]): string[] {
  return current.filter((id) => !CURATED_LLM_MODEL_IDS.includes(id));
}

/** Row label for a stale tick: "<id> (retired — not served)", or "(not in the catalog — not served)"
 *  for an id that was never a catalog row. */
export function staleRotationTickLabel(model: string): string {
  return isRetiredCatalogModel(model) ? `${model} (retired — not served)` : `${model} (not in the catalog — not served)`;
}

/** Catalog models Select All would tick from scratch (the default rotation pool). */
const SELECT_ALL_DEFAULT_IDS = CURATED_LLM_MODEL_IDS.filter((id) => !isRotationOptInOnly(id));

export function RotationModelChecklist({
  id,
  seatLabel,
  value,
  onChange,
  status
}: {
  id: string;
  seatLabel: string;
  /** The seat's saved (or optimistic local) rotation set. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  status: AutoSaveStatus;
}) {
  const ticked = new Set(value);
  const tickedCatalog = CURATED_LLM_MODEL_IDS.filter((model) => ticked.has(model)).length;
  const stale = staleRotationTicks(value);
  const headingId = `${id}-heading`;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span id={headingId} className="text-[length:var(--con-fs-sm)] font-semibold">
          Rotation Models
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SaveStatus status={status} />
          <Btn
            size="sm"
            onClick={() => onChange(selectAllRotationModels(value))}
            disabled={SELECT_ALL_DEFAULT_IDS.every((model) => ticked.has(model))}
            aria-label={`Select all ${seatLabel} rotation models`}
          >
            Select All
          </Btn>
          <Btn
            size="sm"
            onClick={() => onChange([])}
            disabled={value.length === 0}
            aria-label={`Clear ${seatLabel} rotation models`}
          >
            Clear
          </Btn>
        </div>
      </div>
      <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        {value.length === 0
          ? "Nothing ticked, so every eligible model rotates (except those marked only when ticked)."
          : `${tickedCatalog} of ${CURATED_LLM_MODEL_IDS.length} models ticked.${SENTENCE_GAP}Each run picks one whose key works, and falls back to the whole pool if none does.${SENTENCE_GAP}Select All leaves the models marked only when ticked to you.${stale.length > 0 ? `${SENTENCE_GAP}Ticks under No Longer Offered are never served; untick them or press Clear.` : ""}`}
      </p>
      <div className="flex flex-col gap-3">
        {CURATED_LLM_MODEL_GROUPS.filter((group) => group.options.length > 0).map((group) => (
          <fieldset key={group.provider} className="min-w-0">
            <legend className="mb-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
              {group.label}
            </legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {group.options.map((option) => {
                const inputId = `${id}-${option.value}`;
                const excluded = isRotationOptInOnly(option.value);
                return (
                  <label
                    key={option.value}
                    htmlFor={inputId}
                    className="flex min-w-0 items-start gap-2 text-[length:var(--con-fs-sm)]"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      className="mt-1 shrink-0"
                      checked={ticked.has(option.value)}
                      onChange={(event) => onChange(toggleRotationModel(value, option.value, event.target.checked))}
                    />
                    <span className="min-w-0 break-words">
                      {option.label}
                      {option.tier && (
                        <span className="ml-1 text-[color:var(--con-faint)]">{option.tier}</span>
                      )}
                      {excluded && (
                        <span className="ml-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          (only when ticked)
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        {stale.length > 0 && (
          <fieldset className="min-w-0">
            <legend className="mb-1 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
              No Longer Offered
            </legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {stale.map((model) => {
                const inputId = `${id}-stale-${model}`;
                return (
                  <label key={model} htmlFor={inputId} className="flex min-w-0 items-start gap-2 text-[length:var(--con-fs-sm)]">
                    <input
                      id={inputId}
                      type="checkbox"
                      className="mt-1 shrink-0"
                      checked
                      onChange={(event) => onChange(toggleRotationModel(value, model, event.target.checked))}
                    />
                    <span className="min-w-0 break-words">{staleRotationTickLabel(model)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
      </div>
    </div>
  );
}
