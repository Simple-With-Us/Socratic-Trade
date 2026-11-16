"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Chip, Stat } from "../../console/ui/primitives";
import { SymbolButton } from "../../console/ui/symbol-drilldown";
import {
  describeProbeNetworkError,
  describeProbeStatus,
  type ProbeErrorDescription
} from "../lib/probe-error";

type CategoryId = string;

interface CatalogSource {
  id: string;
  label: string;
  status: string;
  notes?: string;
}

interface CatalogFieldSource {
  sourceId: string;
  notes?: string;
  preferred?: boolean;
}

interface CatalogField {
  id: string;
  label: string;
  category: CategoryId;
  valueKind: string;
  description: string;
  provenanceRequired: true;
  llmKey?: string;
  sources: CatalogFieldSource[];
}

interface CategoryBlock {
  id: CategoryId;
  label: string;
  fields: CatalogField[];
}

interface FieldCompletenessRow {
  fieldId: string;
  label: string;
  category: string;
  completeness: number;
  filledCount: number;
  universeCount: number;
  method: string;
  notes?: string;
  sourceIds: string[];
}

interface CompletenessReport {
  asOf: string;
  universeSize: number;
  universeSource: string;
  overallCompleteness: number;
  numericalCompleteness: number;
  ragCompleteness: number;
  categories: Array<{
    category: string;
    label: string;
    completeness: number;
    fields: FieldCompletenessRow[];
  }>;
  rag: {
    tickersWithAnyCorpus: number;
    meanTickerPartial: number;
    byDocType: Record<string, { completeness: number; tickersWith: number }>;
    weakestTickers: Array<{
      symbol: string;
      partial: number;
      present: string[];
      missing: string[];
      chunkCount: number;
    }>;
    llmNote: string;
  };
  llmPresentation: { structuredScan: string; ragContext: string };
}

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

function statusTone(status: string): "pos" | "warn" | "neg" | "muted" | "accent" {
  if (status === "active" || status === "keyless" || status === "computed") return "pos";
  if (status === "scarce" || status === "opt_in" || status === "peer") return "warn";
  if (status === "retired") return "neg";
  return "muted";
}

export function DataCatalogClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProbeErrorDescription | null>(null);
  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [categories, setCategories] = useState<CategoryBlock[]>([]);
  const [completeness, setCompleteness] = useState<CompletenessReport | null>(null);
  const [llmNote, setLlmNote] = useState<string | null>(null);
  const [provenancePolicy, setProvenancePolicy] = useState<string | null>(null);
  const [openFieldId, setOpenFieldId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [gapsOnly, setGapsOnly] = useState(false);

  const sourceMap = useMemo(() => {
    const m = new Map<string, CatalogSource>();
    for (const s of sources) m.set(s.id, s);
    return m;
  }, [sources]);

  const completenessByField = useMemo(() => {
    const m = new Map<string, FieldCompletenessRow>();
    if (!completeness) return m;
    for (const cat of completeness.categories) {
      for (const f of cat.fields) m.set(f.fieldId, f);
    }
    return m;
  }, [completeness]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/data-catalog", { cache: "no-store" });
      if (!res.ok) {
        setError(describeProbeStatus(res.status));
        return;
      }
      const body = (await res.json()) as {
        ok: boolean;
        catalog?: {
          sources: CatalogSource[];
          categories: CategoryBlock[];
          provenancePolicy?: string;
        };
        completeness?: CompletenessReport | null;
        llmNote?: string;
      };
      setSources(body.catalog?.sources ?? []);
      setCategories(body.catalog?.categories ?? []);
      setProvenancePolicy(body.catalog?.provenancePolicy ?? null);
      setCompleteness(body.completeness ?? null);
      setLlmNote(body.llmNote ?? null);
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const q = filter.trim().toLowerCase();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Data catalog & completeness</h1>
          <p className="mt-1 max-w-3xl text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Every field the app uses, which sources can supply it (including retired/theoretical),
            live fill % for numbers and RAG/non-numeric corpus, and how the LLM actually sees the
            data.  Expand a field for the source table.
          </p>
        </div>
        <Btn size="sm" variant="outline" onClick={() => void fetchData()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Btn>
      </div>

      {error && (
        <p
          className="rounded-control border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] px-3 py-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]"
          title={error.rawLabel}
        >
          {error.message}
        </p>
      )}

      {llmNote && (
        <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          <strong className="text-[color:var(--con-fg)]">LLM presentation: </strong>
          {llmNote}
        </div>
      )}

      {provenancePolicy && (
        <div className="rounded-control border border-[color:var(--con-accent-border,var(--con-line))] bg-[color:var(--con-accent-soft)] px-3 py-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-accent)]">
          <strong>Provenance policy: </strong>
          {provenancePolicy}
        </div>
      )}

      {completeness && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Overall completeness" value={pct(completeness.overallCompleteness)} />
          <Stat
            label="Numerical / table fields"
            value={pct(completeness.numericalCompleteness)}
            sub={`${completeness.universeSize} symbols · ${completeness.universeSource}`}
          />
          <Stat
            label="RAG / non-numeric"
            value={pct(completeness.ragCompleteness)}
            sub={`mean ticker partial ${pct(completeness.rag.meanTickerPartial)}`}
          />
          <Stat
            label="Tickers with any corpus"
            value={String(completeness.rag.tickersWithAnyCorpus)}
            sub={`of ${completeness.universeSize} universe`}
          />
        </div>
      )}

      {completeness && (
        <div className="rounded-control border border-[color:var(--con-line)] p-3">
          <h2 className="text-sm font-semibold">RAG doc-type coverage (partial-safe)</h2>
          <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Score = share of universe tickers with ≥1 document of that type. Extra 10-Ks on one name
            do not push the score above 100%. {completeness.rag.llmNote}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(completeness.rag.byDocType).map(([dt, row]) => (
              <Chip
                key={dt}
                tone={row.completeness >= 0.7 ? "pos" : row.completeness >= 0.3 ? "warn" : "neg"}
                title={`${row.tickersWith} tickers`}
              >
                {dt}: {pct(row.completeness)}
              </Chip>
            ))}
          </div>
          {completeness.rag.weakestTickers.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
                Weakest tickers (by doc-type partial)
              </summary>
              <div className="mt-2 max-h-48 overflow-auto text-[length:var(--con-fs-xs)] font-mono">
                {completeness.rag.weakestTickers.slice(0, 25).map((t) => (
                  <div key={t.symbol} className="border-b border-[color:var(--con-line)] py-1">
                    <SymbolButton symbol={t.symbol} /> {pct(t.partial)} · missing{" "}
                    {t.missing.join(", ") || "—"} · chunks {t.chunkCount}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter fields…"
          className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-2 py-1 text-[length:var(--con-fs-sm)]"
        />
        <label className="flex items-center gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          <input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} />
          Gaps only (&lt;100% when known)
        </label>
      </div>

      {categories.map((cat) => {
        let fields = cat.fields;
        if (q) {
          fields = fields.filter(
            (f) =>
              f.id.toLowerCase().includes(q) ||
              f.label.toLowerCase().includes(q) ||
              f.description.toLowerCase().includes(q) ||
              f.sources.some((s) => s.sourceId.toLowerCase().includes(q))
          );
        }
        if (gapsOnly) {
          fields = fields.filter((f) => {
            const c = completenessByField.get(f.id);
            return !c || c.completeness < 1;
          });
        }
        if (fields.length === 0) return null;
        const catComplete = completeness?.categories.find((c) => c.category === cat.id);
        return (
          <section key={cat.id} className="rounded-control border border-[color:var(--con-line)]">
            <header className="flex flex-wrap items-center gap-2 border-b border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
              <h2 className="text-sm font-semibold">{cat.label}</h2>
              {catComplete && (
                <Chip tone={catComplete.completeness >= 0.7 ? "pos" : catComplete.completeness >= 0.3 ? "warn" : "neg"}>
                  {pct(catComplete.completeness)} complete
                </Chip>
              )}
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {fields.length} field{fields.length === 1 ? "" : "s"}
              </span>
            </header>
            <ul className="divide-y divide-[color:var(--con-line)]">
              {fields.map((field) => {
                const open = openFieldId === field.id;
                const cov = completenessByField.get(field.id);
                return (
                  <li key={field.id}>
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[color:var(--con-surface-2)]"
                      onClick={() => setOpenFieldId(open ? null : field.id)}
                      aria-expanded={open}
                    >
                      <span className="font-semibold text-[length:var(--con-fs-sm)]">{field.label}</span>
                      <span className="font-mono text-[10px] text-[color:var(--con-faint)]">{field.id}</span>
                      {field.llmKey && (
                        <Chip tone="accent" title="LLM prompt key">
                          LLM: {field.llmKey}
                        </Chip>
                      )}
                      <Chip tone="muted">{field.valueKind}</Chip>
                      {cov && (
                        <Chip
                          tone={cov.completeness >= 0.7 ? "pos" : cov.completeness >= 0.3 ? "warn" : "neg"}
                          title={cov.notes}
                        >
                          {pct(cov.completeness)} · {cov.method}
                        </Chip>
                      )}
                      <span className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        {open ? "Hide sources ▲" : "Sources ▼"}
                      </span>
                    </button>
                    {open && (
                      <div className="border-t border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-3 py-3">
                        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                          {field.description}
                        </p>
                        {cov?.notes && (
                          <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                            Completeness: {cov.notes}
                          </p>
                        )}
                        <p className="mt-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-fg)]">
                          Provenance required: source + as_of + fetched_at on every observation
                        </p>
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full min-w-[32rem] text-left text-[length:var(--con-fs-xs)]">
                            <thead>
                              <tr className="border-b border-[color:var(--con-line)] text-[color:var(--con-faint)]">
                                <th className="py-1 pr-3 font-semibold">Source</th>
                                <th className="py-1 pr-3 font-semibold">Status</th>
                                <th className="py-1 font-semibold">Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {field.sources.map((fs) => {
                                const meta = sourceMap.get(fs.sourceId);
                                const notes = [meta?.notes, fs.notes].filter(Boolean).join(" · ");
                                return (
                                  <tr
                                    key={`${field.id}-${fs.sourceId}`}
                                    className="border-b border-[color:var(--con-line)] align-top"
                                  >
                                    <td className="py-1.5 pr-3 font-medium">
                                      {meta?.label ?? fs.sourceId}
                                      {fs.preferred ? " ★" : ""}
                                      <div className="font-mono text-[10px] text-[color:var(--con-faint)]">
                                        {fs.sourceId}
                                      </div>
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      <Chip tone={statusTone(meta?.status ?? "muted")}>
                                        {meta?.status ?? "unknown"}
                                      </Chip>
                                    </td>
                                    <td className="py-1.5 text-[color:var(--con-muted)]">{notes || "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section className="rounded-control border border-[color:var(--con-line)] p-3">
        <h2 className="text-sm font-semibold">All source registry</h2>
        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Active, scarce, opt-in, keyless, peer, computed, and retired — so agents do not re-enable
          FMP/Quiver by accident.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {sources.map((s) => (
            <div
              key={s.id}
              className="rounded-control border border-[color:var(--con-line)] px-2 py-1.5 text-[length:var(--con-fs-xs)]"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold">{s.label}</span>
                <Chip tone={statusTone(s.status)}>{s.status}</Chip>
                <span className="font-mono text-[10px] text-[color:var(--con-faint)]">{s.id}</span>
              </div>
              {s.notes && <p className="mt-0.5 text-[color:var(--con-muted)]">{s.notes}</p>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
