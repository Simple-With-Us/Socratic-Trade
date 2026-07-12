"use client";

/** Policy editing toolkit: sparse-draft editing over the live policy, a diff
 *  review sheet, and asymmetric friction — tightening saves with one click,
 *  loosening brokerage-account authority requires typing CONFIRM. The commit model comes
 *  from the explainability design: you never "save settings", you review and
 *  commit a change. The diff/classification logic lives in ../lib/policy-diff
 *  (pure, unit-tested); this file is the React skin over it. */

import { useMemo, useState, type ReactNode } from "react";
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
import { Btn, Chip, LiveTag, NumInput, Select, TextInput, Toggle } from "../ui/primitives";
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

export function PolicyFieldRow({ def, policy, draft }: { def: FieldDef; policy: TradingPolicy; draft: PolicyDraft }) {
  const current = getAtPath(policy, def.path);
  const touched = def.path in draft.values;
  const value = touched ? draft.values[def.path] : current;
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
          {def.hint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{def.hint}</p>}
        </div>
        <Toggle checked={value === true} onChange={(next) => draft.set(def.path, next)} label={def.label} />
      </div>
    );
  }

  if (def.kind === "select") {
    const fallback = String(getAtPath(DEFAULT_POLICY, def.path) ?? "");
    const selected = isBlank(value) ? fallback : String(value);
    return (
      <div className="py-2">
        <div className="flex items-end justify-between gap-4">
          <label className="text-[length:var(--con-fs-sm)] font-semibold" htmlFor={`pf-${def.path}`}>
            {def.label}
            {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
          </label>
          <div className="w-52">
            <Select id={`pf-${def.path}`} value={selected} onChange={(e) => draft.set(def.path, e.target.value)}>
              {(def.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {def.hint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{def.hint}</p>}
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
      {def.hint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{def.hint}</p>}
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
  const [mode, setModeState] = useState<"money" | "pct">(() => (!isBlank(pctValue) ? "pct" : "money"));
  const [editText, setEditText] = useState<string | null>(null);
  const activeDef = mode === "money" ? moneyDef : pctDef;
  const activeValue = mode === "money" ? moneyValue : pctValue;
  const touched = moneyTouched || pctTouched;
  const display = isBlank(activeValue) ? "" : String(activeValue);
  const unit = mode === "money" ? "$" : "%";

  const setMode = (next: "money" | "pct") => {
    setModeState(next);
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
          <div className="inline-flex rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-0.5" role="group" aria-label={`${label} mode`}>
            <button
              type="button"
              className={mode === "money" ? "rounded px-2 py-1 text-[length:var(--con-fs-xs)] font-bold text-[color:var(--con-fg)] bg-[color:var(--con-surface)]" : "rounded px-2 py-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]"}
              onClick={() => setMode("money")}
              title={moneyDef.hint ?? `Use a dollar cap for ${label}.`}
            >
              Dollar
            </button>
            <button
              type="button"
              className={mode === "pct" ? "rounded px-2 py-1 text-[length:var(--con-fs-xs)] font-bold text-[color:var(--con-fg)] bg-[color:var(--con-surface)]" : "rounded px-2 py-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]"}
              onClick={() => setMode("pct")}
              title={pctDef.hint ?? `Use a portfolio percentage cap for ${label}.`}
            >
              Percent
            </button>
          </div>
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
  extraPatch
}: {
  policy: TradingPolicy;
  draft: PolicyDraft;
  defs: FieldDef[];
  reality: RealityInfo;
  /** Extra body merged into the PUT (e.g. full arrays that aren't diffable). */
  extraPatch?: PolicyPatchBody;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const diff = useMemo(() => computeDiff(policy, draft.values, defs), [policy, draft, defs]);
  const extraEntries: ExtraDiffEntry[] = useMemo(() => classifyExtraPatch(policy, extraPatch), [policy, extraPatch]);
  const changeCount = diff.length + extraEntries.length;
  // Register the uncommitted draft with the shell's unsaved-changes guard
  // (beforeunload + nav interception). Must run before the early return.
  useUnsavedChanges(changeCount > 0);
  if (changeCount === 0) return null;

  // extraPatch changes (universe, blocklist, order types, sell-to-fund-buy) can
  // loosen the cage too — they must cost the typed word on brokerage accounts like any field.
  const hasLooser = diff.some((d) => d.direction === "looser") || extraEntries.some((e) => e.direction === "looser");
  const needsTyped = reality.tone === "live" && hasLooser;

  const commit = async () => {
    setBusy(true);
    try {
      await savePolicy({ ...buildPatch(diff, policy), ...(extraPatch ?? {}) });
      await refresh();
      draft.clear();
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
      <div className="sticky bottom-16 z-40 lg:bottom-4">
        <div className="con-card flex items-center justify-between gap-3 border-[color:var(--con-warn)] px-4 py-2.5">
          <span className="text-[length:var(--con-fs-sm)] font-semibold">
            {changeCount} uncommitted {changeCount === 1 ? "change" : "changes"}
          </span>
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => draft.clear()}>
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
            note="At least one change expands authority on a brokerage account. Unlocking authority costs a typed word; locking things down never does."
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
