"use client";

/** Policy editing toolkit: sparse-draft editing over the live policy, a diff
 *  review sheet, and asymmetric friction — tightening saves with one click,
 *  loosening brokerage-account authority requires typing CONFIRM. The commit model comes
 *  from the explainability design: you never "save settings", you review and
 *  commit a change. The diff/classification logic lives in ../lib/policy-diff
 *  (pure, unit-tested); this file is the React skin over it. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Lock, Unlock } from "lucide-react";
import { DEFAULT_POLICY } from "@/lib/defaults";
import type { TradingPolicy } from "@/lib/types";
import { savePolicy, ConsoleApiError, type PolicyPatchBody } from "../lib/api";
import type { RealityInfo } from "../lib/derive";
import {
  buildPatch,
  classifyExtraPatch,
  clearedFallback,
  computeDiff,
  getAtPath,
  isBlank,
  type DiffEntry,
  type ExtraDiffEntry,
  type FieldDef
} from "../lib/policy-diff";
import { fmtNum, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { useToast } from "../ui/toast";
import { Btn, Chip, LiveTag, NumInput, Segmented, Select, TextInput, Toggle } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { TypedConfirm } from "./chrome";

export type { FieldDef, FieldKind, DiffEntry } from "../lib/policy-diff";
export { getAtPath, computeDiff, buildPatch } from "../lib/policy-diff";

// ── Draft state (sparse: only touched fields) ────────────────────────────────

export interface PolicyDraft {
  values: Record<string, unknown>;
  set: (path: string, value: unknown) => void;
  clear: () => void;
}

export function usePolicyDraft(): PolicyDraft {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return {
    values,
    set: (path, value) => setValues((prev) => ({ ...prev, [path]: value })),
    clear: () => setValues({})
  };
}

// ── Field renderer ───────────────────────────────────────────────────────────

function fmtValue(def: FieldDef, v: unknown): string {
  if (def.kind === "select") {
    const label = (value: unknown) => def.options?.find((o) => o.value === String(value))?.label ?? String(value);
    return isBlank(v) ? `default (${label(getAtPath(DEFAULT_POLICY, def.path))})` : label(v);
  }
  if (isBlank(v)) {
    if (!def.optional) return EM_DASH;
    // Honest blank label: the server re-applies the shipped default for fields
    // that have one — only claim "off" when clearing truly turns the guard off.
    const fallback = clearedFallback(def);
    return fallback !== undefined ? `default (${fmtValue(def, fallback)})` : "off";
  }
  if (def.kind === "bool") return v === true ? "on" : "off";
  if (def.kind === "money") return `$${fmtNum(v as number)}`;
  if (def.kind === "pct") return `${fmtNum(v as number)}%`;
  if (def.kind === "minutes") return `${fmtNum(v as number)} min`;
  if (def.kind === "seconds") return `${fmtNum(v as number)} s`;
  return String(v);
}

export function PolicyFieldRow({
  def,
  policy,
  draft,
  hint
}: {
  def: FieldDef;
  policy: TradingPolicy;
  draft: PolicyDraft;
  hint?: string;
}) {
  const current = getAtPath(policy, def.path);
  const touched = def.path in draft.values;
  const value = touched ? draft.values[def.path] : current;
  const effectiveHint = hint ?? def.hint;
  // While the input is focused we render the raw typed text, so transient
  // states like "0." or "12." survive keystrokes (Number() would collapse
  // them). The parsed number is still committed to the draft on every change;
  // blur snaps the text back to the canonical value.
  const [editText, setEditText] = useState<string | null>(null);

  if (def.kind === "bool") {
    return (
      <div className="flex items-start justify-between gap-4 py-2">
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">
            {def.label}
            {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
          </div>
          {effectiveHint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{effectiveHint}</p>}
        </div>
        <Toggle checked={value === true} onChange={(next) => draft.set(def.path, next)} label={def.label} />
      </div>
    );
  }

  if (def.kind === "select") {
    const fallback = String(getAtPath(DEFAULT_POLICY, def.path) ?? "");
    // Reverse-map a typed value (boolean/null) back to its string option key when optionValues is
    // present; plain string-valued selects need no mapping.
    const selectedKey = def.optionValues
      ? (Object.keys(def.optionValues).find((key) => def.optionValues![key] === value) ?? "")
      : String(value);
    const selected = isBlank(value) ? fallback : selectedKey;
    return (
      <div className="py-2">
        <div className="flex items-end justify-between gap-4">
          <label className="text-[length:var(--con-fs-sm)] font-semibold" htmlFor={`pf-${def.path}`}>
            {def.label}
            {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
          </label>
          <div className="w-52">
            <Select
              id={`pf-${def.path}`}
              value={selected}
              onChange={(e) => {
                const raw = e.target.value;
                // hasOwnProperty (not ??): an explicit null mapping ("" → clear-to-global) must
                // survive, and ?? would fall through to the raw string for exactly that case.
                const mapped = def.optionValues && Object.prototype.hasOwnProperty.call(def.optionValues, raw)
                  ? def.optionValues[raw]
                  : raw;
                draft.set(def.path, mapped);
              }}
            >
              {(def.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {effectiveHint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{effectiveHint}</p>}
      </div>
    );
  }

  const unit = def.kind === "money" ? "$" : def.kind === "pct" ? "%" : def.kind === "minutes" ? "min" : def.kind === "seconds" ? "sec" : undefined;
  const numeric = def.kind !== "text";
  const display = isBlank(value) ? "" : String(value);
  const blankFallback = def.optional ? clearedFallback(def) : undefined;
  const blankPlaceholder = def.optional ? (blankFallback !== undefined ? `default ${blankFallback}` : "off") : undefined;

  return (
    <div className="py-2">
      <div className="flex items-end justify-between gap-4">
        <label className="text-[length:var(--con-fs-sm)] font-semibold" htmlFor={`pf-${def.path}`}>
          {def.label}
          {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
        </label>
        <div className="flex w-36 items-center gap-1.5">
          {unit === "$" && <span className="text-[color:var(--con-faint)]">$</span>}
          {numeric ? (
            <NumInput
              id={`pf-${def.path}`}
              value={editText ?? display}
              placeholder={blankPlaceholder}
              onFocus={() => setEditText(display)}
              onBlur={() => setEditText(null)}
              onChange={(e) => {
                const raw = e.target.value;
                setEditText(raw);
                const parsed = Number(raw);
                draft.set(def.path, raw === "" || !Number.isFinite(parsed) ? null : parsed);
              }}
            />
          ) : (
            <TextInput id={`pf-${def.path}`} value={display} onChange={(e) => draft.set(def.path, e.target.value)} />
          )}
          {unit && unit !== "$" && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{unit}</span>}
        </div>
      </div>
      {effectiveHint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{effectiveHint}</p>}
    </div>
  );
}

export function PolicyDualModeRow({
  label,
  moneyDef,
  pctDef,
  policy,
  draft,
  hint
}: {
  label: string;
  moneyDef: FieldDef;
  pctDef: FieldDef;
  policy: TradingPolicy;
  draft: PolicyDraft;
  hint?: string;
}) {
  const moneyTouched = moneyDef.path in draft.values;
  const pctTouched = pctDef.path in draft.values;
  const moneyValue = moneyTouched ? draft.values[moneyDef.path] : getAtPath(policy, moneyDef.path);
  const pctValue = pctTouched ? draft.values[pctDef.path] : getAtPath(policy, pctDef.path);
  // Percentage is the safe, account-relative default. Preserve an explicit
  // dollar mode for legacy/custom policies, but never default a blank pair to
  // an arbitrary dollar field.
  const policyMode: "money" | "pct" = !isBlank(getAtPath(policy, pctDef.path)) || isBlank(getAtPath(policy, moneyDef.path)) ? "pct" : "money";
  const [draftMode, setDraftMode] = useState<"money" | "pct">(policyMode);
  const [editText, setEditText] = useState<string | null>(null);
  // Sync draft mode when the policy mode changes (e.g. account switch) so the first
  // keystroke after the switch doesn't snap back to the stale previous account's mode.
  useEffect(() => { setDraftMode(policyMode); }, [policyMode]);
  // A mode choice is interaction state only while this field pair has an active draft. After
  // discard/save or an account switch, derive from that account's persisted policy immediately;
  // this avoids a stale selector without an effect-driven synchronization render.
  const mode = moneyTouched || pctTouched ? draftMode : policyMode;
  const activeDef = mode === "money" ? moneyDef : pctDef;
  const activeValue = mode === "money" ? moneyValue : pctValue;
  const touched = moneyTouched || pctTouched;
  const display = isBlank(activeValue) ? "" : String(activeValue);
  const unit = mode === "money" ? "$" : "%";

  const setMode = (next: "money" | "pct") => {
    setDraftMode(next);
    setEditText(null);
    if (next === "money") {
      draft.set(pctDef.path, null);
      if (!(moneyDef.path in draft.values)) draft.set(moneyDef.path, isBlank(moneyValue) ? null : moneyValue);
    } else {
      draft.set(moneyDef.path, null);
      if (!(pctDef.path in draft.values)) draft.set(pctDef.path, isBlank(pctValue) ? null : pctValue);
    }
  };

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">
            {label}
            {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
          </div>
          {hint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{hint}</p>}
        </div>
        <div className="flex min-w-[18rem] flex-wrap items-center justify-end gap-2">
          <Segmented
            value={mode}
            onChange={setMode}
            ariaLabel={`${label} mode`}
            options={[
              { value: "money", label: "Dollar", title: moneyDef.hint ?? `Use a dollar cap for ${label}.` },
              { value: "pct", label: "Percent", title: pctDef.hint ?? `Use a portfolio percentage cap for ${label}.` }
            ]}
          />
          <div className="flex w-36 items-center gap-1.5">
            {unit === "$" && <span className="text-[color:var(--con-faint)]">$</span>}
            <NumInput
              id={`pf-${activeDef.path}`}
              value={editText ?? display}
              placeholder="off"
              onFocus={() => setEditText(display)}
              onBlur={() => setEditText(null)}
              onChange={(e) => {
                const raw = e.target.value;
                setEditText(raw);
                const parsed = Number(raw);
                draft.set(activeDef.path, raw === "" || !Number.isFinite(parsed) ? null : parsed);
                draft.set(mode === "money" ? pctDef.path : moneyDef.path, null);
              }}
              title={activeDef.hint}
            />
            {unit === "%" && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">%</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Save bar + review sheet ──────────────────────────────────────────────────

function DirectionTag({ direction }: { direction: DiffEntry["direction"] }) {
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

export function PolicySaveBar({
  policy,
  draft,
  defs,
  reality,
  extraPatch,
  onDiscard
}: {
  policy: TradingPolicy;
  draft: PolicyDraft;
  defs: FieldDef[];
  reality: RealityInfo;
  /** Extra body merged into the PUT (e.g. full arrays that aren't diffable). */
  extraPatch?: PolicyPatchBody;
  /** Called with draft.clear() so pages that keep a sibling draft (Universe) reset it too. */
  onDiscard?: () => void;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const diff = useMemo(() => computeDiff(policy, draft.values, defs), [policy, draft, defs]);
  const extraEntries: ExtraDiffEntry[] = useMemo(() => classifyExtraPatch(policy, extraPatch), [policy, extraPatch]);
  const changeCount = diff.length + extraEntries.length;
  // Register the uncommitted draft with the shell's unsaved-changes guard (beforeunload + nav
  // interception). The onReview opener powers the nav prompt's "Review & save" option. Must run
  // before the early return.
  useUnsavedChanges(changeCount > 0, () => setReviewOpen(true));
  if (changeCount === 0) return null;

  // extraPatch changes (universe, blocklist, order types, sell-to-fund-buy) can
  // loosen the cage too — they must cost the typed word on brokerage accounts like any field.
  const hasLooser = diff.some((d) => d.direction === "looser") || extraEntries.some((e) => e.direction === "looser");
  // Loosening a guardrail on a live account normally costs a typed word; the owner can turn that off
  // in Settings → Advanced action confirmation (policy.requireTypedConfirmation).
  const needsTyped = reality.tone === "live" && hasLooser && policy.requireTypedConfirmation !== false;

  const commit = async () => {
    setBusy(true);
    try {
      await savePolicy(
        { ...buildPatch(diff, policy), ...(extraPatch ?? {}) },
        policy.connectedAccountId
      );
      await refresh();
      if (onDiscard) onDiscard();
      else draft.clear();
      setReviewOpen(false);
      setTyped("");
      toast.push("pos", "Guardrails updated", "Takes effect from the next policy-gate evaluation.");
    } catch (error) {
      toast.push("neg", "Save refused", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sticky bottom-[calc(3.75rem+env(safe-area-inset-bottom,0px))] z-40 lg:bottom-4">
        <div className="con-card flex items-center justify-between gap-3 border-[color:var(--con-warn)] px-4 py-2.5">
          <span className="text-[length:var(--con-fs-sm)] font-semibold">
            {changeCount} uncommitted {changeCount === 1 ? "change" : "changes"}
          </span>
          <div className="flex gap-2">
            <Btn
              variant="ghost"
              size="sm"
              onClick={() => {
                if (onDiscard) onDiscard();
                else draft.clear();
              }}
            >
              Discard
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => setReviewOpen(true)}>
              Review &amp; save
            </Btn>
          </div>
        </div>
      </div>

      <Sheet open={reviewOpen} onClose={() => setReviewOpen(false)} title="Review changes" tone={needsTyped ? "live" : undefined}>
        <div className="mb-3 flex items-center gap-2 text-[length:var(--con-fs-sm)]">
          <Chip tone={reality.tone}>
            {reality.word} · {reality.phrase}
          </Chip>
          <span className="text-[color:var(--con-muted)]">Changes apply to this account only.</span>
        </div>
        <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
          {diff.map((d) => (
            <div key={d.def.path} className="flex items-center justify-between gap-3 py-2 text-[length:var(--con-fs-sm)]">
              <span className="font-semibold">{d.def.label}</span>
              <span className="con-num flex items-center gap-2">
                <span className="text-[color:var(--con-faint)]">{fmtValue(d.def, d.from)}</span>
                <span className="text-[color:var(--con-faint)]">→</span>
                <span>{fmtValue(d.def, d.to)}</span>
                <DirectionTag direction={d.direction} />
              </span>
            </div>
          ))}
          {extraEntries.map((entry) => (
            <div key={entry.key} className="flex items-center justify-between gap-3 py-2 text-[length:var(--con-fs-sm)]">
              <span className="font-semibold">{entry.label}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[color:var(--con-faint)]">{entry.summary}</span>
                <DirectionTag direction={entry.direction} />
              </span>
            </div>
          ))}
        </div>

        {needsTyped ? (
          <TypedConfirm
            phrase="CONFIRM"
            value={typed}
            onChange={setTyped}
            busy={busy}
            variant="primary"
            confirmLabel={
              <>
                Commit changes <LiveTag />
              </>
            }
            note="At least one change expands authority on a brokerage account.  Unlocking authority costs a typed word; locking things down never does."
            onConfirm={() => void commit()}
          />
        ) : (
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setReviewOpen(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={() => void commit()} disabled={busy}>
              {busy ? "Saving…" : "Commit changes"}
            </Btn>
          </div>
        )}
      </Sheet>
    </>
  );
}

// ── Section wrapper ──────────────────────────────────────────────────────────

export function AdvancedGroup({ title, children, defaultOpen }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="con-disclosure border-t border-[color:var(--con-line)]" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}
