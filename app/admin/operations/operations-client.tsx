"use client";

// Admin > Operations — server-level pause/kill knobs (src/lib/server-knobs.ts) as REAL runtime
// toggles.  Each row shows the knob's current EFFECTIVE value, where it comes from (override /
// env / default), and an honest note on when a flip takes effect.  Writes go through
// /api/admin/server-knobs and audit `server_knob.changed`.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Card, Chip, RawNumInput, Toggle, Btn, type ChipTone } from "../../console/ui/primitives";
import { resolveServerKnobNumberCommit } from "../../console/lib/number-commit";
import { describeProbeStatus } from "../lib/probe-error";

interface ServerKnobRow {
  id: string;
  group: string;
  label: string;
  description: string;
  type: "boolean" | "number";
  defaultValue: boolean | number;
  min?: number;
  max?: number;
  effect: string;
  value: boolean | number;
  source: "override" | "env" | "default";
  envValue: boolean | number;
  override: boolean | number | null;
}

interface ServerKnobsResponse {
  ok: boolean;
  groups: Record<string, { title: string; blurb: string }>;
  knobs: ServerKnobRow[];
}

/** Owner copy rule: two spaces between sentences.  Catalog strings arrive with literal double
 *  spaces; HTML would collapse them, so render as NBSP + space (same gap SENTENCE_GAP encodes). */
function gap(s: string): string {
  return s.replaceAll("  ", "\u00A0 ");
}

const SOURCE_TONE: Record<ServerKnobRow["source"], ChipTone> = {
  override: "pos",
  env: "accent",
  default: "muted"
};

const SOURCE_TITLE: Record<ServerKnobRow["source"], string> = {
  override: "Runtime override set here — wins over Infisical/env",
  env: "Following Infisical/env",
  default: "Built-in default (no env, no override)"
};

function fmtValue(row: Pick<ServerKnobRow, "type">, v: boolean | number): string {
  if (row.type === "boolean") return v ? "on" : "off";
  return String(v);
}

export function OperationsClient() {
  const [data, setData] = useState<ServerKnobsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numberDrafts, setNumberDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/server-knobs");
      if (!res.ok) {
        setData(null);
        setError(describeProbeStatus(res.status).shortMessage);
        return;
      }
      setData((await res.json()) as ServerKnobsResponse);
    } catch {
      setData(null);
      setError("Request failed");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (id: string, value: boolean | number | null) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await fetch("/api/admin/server-knobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, value })
        });
        if (!res.ok) {
          setError(describeProbeStatus(res.status).shortMessage);
          return;
        }
        setData((await res.json()) as ServerKnobsResponse);
      } catch {
        setError("Request failed");
      } finally {
        setBusyId(null);
      }
    },
    []
  );

  const commitNumberRow = async (row: ServerKnobRow) => {
    const raw = numberDrafts[row.id];
    setNumberDrafts((d) => {
      if (!(row.id in d)) return d;
      const copy = { ...d };
      delete copy[row.id];
      return copy;
    });
    if (raw === undefined) return;
    const next = resolveServerKnobNumberCommit(raw, Number(row.value), row.min, row.max);
    if (next === null) return;
    await save(row.id, next);
  };

  const groupIds = data ? Object.keys(data.groups) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Operations</h1>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {gap(
              "Server-level pause and kill switches, flipped at runtime.  An override set here wins over the Infisical/env value until you reset it — no redeploy needed."
            )}
          </p>
        </div>
        <Btn
          variant="outline"
          size="sm"
          disabled={loading || refreshing}
          onClick={() => {
            setRefreshing(true);
            void load();
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </Btn>
      </div>

      {error && (
        <div className="rounded-[var(--con-radius)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4">
          <div className="flex items-start gap-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <span className="font-semibold">Could not load or save server knobs</span>
              <p className="mt-1 text-[length:var(--con-fs-xs)] opacity-90">{error}</p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Loading knobs...
        </div>
      ) : data ? (
        groupIds.map((groupId) => {
          const meta = data.groups[groupId] ?? { title: groupId, blurb: "" };
          const rows = data.knobs.filter((k) => k.group === groupId);
          if (rows.length === 0) return null;
          return (
            <Card key={groupId}>
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-[color:var(--con-muted)]" />
                <span className="text-[length:var(--con-fs-sm)] font-semibold">{meta.title}</span>
              </div>
              {meta.blurb && (
                <p className="mt-0.5 mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {gap(meta.blurb)}
                </p>
              )}
              <div className="mt-2 flex flex-col gap-2.5">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-[color:var(--con-line)] px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[length:var(--con-fs-sm)] font-semibold">{row.label}</span>
                        <Chip tone={SOURCE_TONE[row.source]} title={SOURCE_TITLE[row.source]}>
                          {row.source}
                        </Chip>
                        <Chip tone="none" title="The exact env var this knob overrides">
                          {row.id}
                        </Chip>
                      </div>
                      <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                        {gap(row.description)}
                      </p>
                      <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        {gap(row.effect)}
                        {row.override !== null && (
                          <>
                            {"\u00A0 "}Reset falls back to {fmtValue(row, row.envValue)}.
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {row.type === "boolean" ? (
                        <Toggle
                          checked={row.value === true}
                          disabled={busyId !== null}
                          onChange={(on) => void save(row.id, on)}
                          label={row.label}
                        />
                      ) : (
                        <RawNumInput
                          className="w-24"
                          value={numberDrafts[row.id] ?? String(row.value)}
                          emptyValue={Number(row.value) || 0}
                          min={row.min}
                          max={row.max}
                          disabled={busyId === row.id}
                          onValueChange={(_n, raw) => setNumberDrafts((d) => ({ ...d, [row.id]: raw }))}
                          onBlur={() => void commitNumberRow(row)}
                          aria-label={row.label}
                        />
                      )}
                      {row.override !== null && (
                        <button
                          type="button"
                          className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] underline-offset-2 hover:underline"
                          disabled={busyId !== null}
                          onClick={() => void save(row.id, null)}
                          title="Clear the runtime override; fall back to Infisical/env (or the default)"
                        >
                          reset
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })
      ) : null}
    </div>
  );
}
