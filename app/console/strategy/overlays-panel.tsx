"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TradingPolicy } from "@/lib/types";
import { MARKET_REGIME_LABELS, type MarketRegime } from "@/lib/market-regime";
import { selectActiveOverlays, type OverlayRegimeTag, type StrategyOverlay } from "@/lib/overlay-router";
import { OVERLAY_STARTER_TEMPLATES } from "@/lib/overlay-templates";
import { savePolicy } from "../lib/api";
import { Btn, Card, Empty, Field, RawNumInput, Select, TextArea, TextInput } from "../ui/primitives";
import { SaveStatus } from "../ui/save-status";

interface OverlayRow extends StrategyOverlay {
  userId?: string;
}

const REGIME_OPTIONS: OverlayRegimeTag[] = ["any", "crisis", "risk-off", "cautious-inverted", "neutral", "risk-on", "unknown"];

/** Decides what the Overlays "Max Active" field's blur should persist, given
 *  the raw text just typed and the last saved value. Returns null when
 *  nothing should be written to the server: blank/unparseable text reverts to
 *  the last saved value instead of silently saving a fallback (this field
 *  used to PATCH "2" straight to the server on the very next keystroke after
 *  clearing it), and an unchanged value is a no-op. Valid input floors at 1 —
 *  selectActiveOverlays needs at least one active overlay slot to mean
 *  anything, matching the floor the buggy per-keystroke handler also applied. */
export function resolveMaxActiveCommit(raw: string, committed: number): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  const next = Math.max(1, parsed);
  if (next === committed) return null;
  return next;
}

export function OverlaysPanel({
  policy,
  onSaved
}: {
  policy: TradingPolicy;
  onSaved: () => Promise<void> | void;
}) {
  const [overlays, setOverlays] = useState<OverlayRow[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [previewRegime, setPreviewRegime] = useState<MarketRegime>("neutral");
  // Raw in-progress text for the Max Active field — commit-on-blur (see
  // commitMaxActive below), matching every other numeric field in the console
  // instead of PATCHing the server on every keystroke.
  const [maxActiveDraft, setMaxActiveDraft] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: "",
    instructions: "",
    marketRegimes: ["any"] as OverlayRegimeTag[],
    priority: 100
  });
  const loadSeq = useRef(0);

  const applyOverlays = useCallback((next: OverlayRow[] | undefined, seq: number) => {
    if (seq !== loadSeq.current) return;
    setOverlays(next ?? []);
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await fetch("/api/overlays", { cache: "no-store" });
    const body = (await res.json()) as { overlays?: OverlayRow[] };
    applyOverlays(body.overlays, seq);
  }, [applyOverlays]);

  useEffect(() => {
    void load();
  }, [load]);

  const enabled = Boolean(policy.tuning?.strategyOverlaysEnabled);
  const maxActive = policy.tuning?.maxActiveOverlays ?? 2;
  const wouldFire = useMemo(
    () => selectActiveOverlays({ overlays, regime: previewRegime, maxCount: maxActive }),
    [overlays, previewRegime, maxActive]
  );

  async function patchTuning(patch: { strategyOverlaysEnabled?: boolean; maxActiveOverlays?: number }) {
    setStatus("saving");
    try {
      await savePolicy({ tuning: { ...policy.tuning, ...patch } }, policy.connectedAccountId);
      await onSaved();
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  }

  // Commits the Max Active field's typed text on blur. Blank or unparseable
  // text reverts to the last saved value instead of silently persisting a
  // fallback (an emptied field used to write "2" straight to the server on
  // the very next keystroke).
  async function commitMaxActive() {
    const raw = maxActiveDraft;
    setMaxActiveDraft(null);
    if (raw === null) return;
    const next = resolveMaxActiveCommit(raw, maxActive);
    if (next === null) return;
    await patchTuning({ maxActiveOverlays: next });
  }

  async function createOverlay() {
    setError(null);
    setStatus("saving");
    const seq = ++loadSeq.current;
    const res = await fetch("/api/overlays", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft)
    });
    if (!res.ok) {
      setStatus("error");
      setError("Could not create overlay.");
      return;
    }
    const body = (await res.json()) as { overlay?: OverlayRow };
    setDraft({ name: "", instructions: "", marketRegimes: ["any"], priority: 100 });
    if (body.overlay && seq === loadSeq.current) {
      setOverlays((current) => [...current, body.overlay!]);
    } else {
      await load();
    }
    setStatus("saved");
  }

  async function seedStarters() {
    setError(null);
    setStatus("saving");
    const seq = ++loadSeq.current;
    const res = await fetch("/api/overlays", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: true })
    });
    if (!res.ok) {
      setStatus("error");
      setError("Could not load starters.");
      return;
    }
    const body = (await res.json()) as { overlays?: OverlayRow[] };
    applyOverlays(body.overlays, seq);
    setStatus("saved");
  }

  async function patchOverlay(id: string, patch: Partial<OverlayRow>) {
    setStatus("saving");
    const seq = ++loadSeq.current;
    const res = await fetch(`/api/overlays/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      setStatus("error");
      setError("Could not update overlay.");
      return;
    }
    const body = (await res.json()) as { overlay?: OverlayRow };
    if (body.overlay && seq === loadSeq.current) {
      setOverlays((current) => current.map((row) => (row.id === id ? body.overlay! : row)));
    } else {
      await load();
    }
    setStatus("saved");
  }

  async function removeOverlay(id: string) {
    setStatus("saving");
    const seq = ++loadSeq.current;
    const res = await fetch(`/api/overlays/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setStatus("error");
      setError("Could not delete overlay.");
      return;
    }
    if (seq === loadSeq.current) {
      setOverlays((current) => current.filter((row) => row.id !== id));
    } else {
      await load();
    }
    setStatus("saved");
  }

  return (
    <div id="overlays" className="scroll-mt-28">
      <Card title="Overlays" collapsible defaultOpen action={<SaveStatus status={status} />}>
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Regime-tagged playbooks injected into the proposer as DATA, never as commands.  They cannot
          raise risk limits.  Off by default until you enable them here.
        </p>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-[length:var(--con-fs-sm)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => void patchTuning({ strategyOverlaysEnabled: event.target.checked })}
            />
            Enable overlays
          </label>
          <Field label="Max Active" htmlFor="overlay-max">
            <RawNumInput
              id="overlay-max"
              min={1}
              max={6}
              value={maxActiveDraft ?? String(maxActive)}
              emptyValue={maxActive}
              onValueChange={(_parsed, raw) => setMaxActiveDraft(raw)}
              onBlur={() => void commitMaxActive()}
            />
          </Field>
          <Btn type="button" onClick={() => void seedStarters()}>
            Load Starters
          </Btn>
        </div>

        <div className="mb-4 rounded-[var(--con-radius)] border border-[color:var(--con-line)] p-3">
          <Field label="Would Fire Now" htmlFor="overlay-preview-regime">
            <Select
              id="overlay-preview-regime"
              value={previewRegime}
              onChange={(event) => setPreviewRegime(event.target.value as MarketRegime)}
            >
              {(Object.keys(MARKET_REGIME_LABELS) as MarketRegime[]).map((regime) => (
                <option key={regime} value={regime}>
                  {MARKET_REGIME_LABELS[regime]}
                </option>
              ))}
            </Select>
          </Field>
          {wouldFire.length === 0 ? (
            <Empty>No enabled overlay matches this regime.</Empty>
          ) : (
            <ul className="mt-2 list-disc pl-5 text-[length:var(--con-fs-sm)]">
              {wouldFire.map((overlay) => (
                <li key={overlay.id}>{overlay.name}</li>
              ))}
            </ul>
          )}
        </div>

        {overlays.length === 0 ? (
          <Empty>
            No overlays yet.  Load starters ({OVERLAY_STARTER_TEMPLATES.length} templates) or add your own.
          </Empty>
        ) : (
          <ul className="mb-4 space-y-3">
            {overlays.map((overlay) => (
              <li key={overlay.id} className="rounded-[var(--con-radius)] border border-[color:var(--con-line)] p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <strong>{overlay.name}</strong>
                  <div className="flex items-center gap-2">
                    <label className="text-[length:var(--con-fs-xs)]">
                      <input
                        type="checkbox"
                        checked={overlay.enabled}
                        onChange={(event) => void patchOverlay(overlay.id, { enabled: event.target.checked })}
                      />{" "}
                      On
                    </label>
                    <Btn type="button" onClick={() => void removeOverlay(overlay.id)}>
                      Delete
                    </Btn>
                  </div>
                </div>
                <p className="mb-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  Regimes: {overlay.marketRegimes.join(", ")} · Priority {overlay.priority}
                </p>
                <p className="text-[length:var(--con-fs-sm)]">{overlay.instructions}</p>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3">
          <Field label="Name" htmlFor="overlay-name">
            <TextInput
              id="overlay-name"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>
          <Field label="Regimes" htmlFor="overlay-regimes">
            <Select
              id="overlay-regimes"
              multiple
              value={draft.marketRegimes}
              onChange={(event) => {
                const selected = Array.from(event.target.selectedOptions).map((option) => option.value as OverlayRegimeTag);
                setDraft((current) => ({ ...current, marketRegimes: selected.length ? selected : ["any"] }));
              }}
            >
              {REGIME_OPTIONS.map((regime) => (
                <option key={regime} value={regime}>
                  {regime}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Instructions" htmlFor="overlay-instructions">
            <TextArea
              id="overlay-instructions"
              rows={5}
              value={draft.instructions}
              onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
            />
          </Field>
          {error ? <p className="text-[length:var(--con-fs-xs)] text-red-600">{error}</p> : null}
          <Btn type="button" onClick={() => void createOverlay()}>
            Add Overlay
          </Btn>
        </div>
      </Card>
    </div>
  );
}
