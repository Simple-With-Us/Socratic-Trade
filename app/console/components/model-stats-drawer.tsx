"use client";

/** Model stats drawer — the info affordance next to the Proposer/Reviewer/Strategist model
 *  pickers on the Strategy page and the AI review picker. One small button per
 *  select opens a sheet listing every catalog model with cost per call and latency (live
 *  figures when this user has enough real traffic, otherwise the standardized
 *  offline benchmark — the 2026-07-08 full sweep, topped up 2026-07-10 for
 *  Mistral once its capability-map bug was fixed — always labeled which is
 *  which) plus a performance column whose meaning is role-specific. Neither
 *  performance measure is shown unlabeled below its sample-size thresholds.
 *  - Green Team (proposer): realized performance = closed trades whose ENTRY this
 *    model proposed. Hidden below 20 closed trades ("needs >= 20 closed trades
 *    (n=X)"); 20-49 shows numbers WITH a small-sample caveat; 50+ plain.
 *  - Red Team (reviewer): veto value-add = the counterfactual "had-it-run" outcome
 *    of the risk-adding proposals this model vetoed (share whose forward return
 *    was a loss — a good veto avoids a loser — plus the average counterfactual
 *    return, where NEGATIVE = value added). Fed by getRedTeamEfficacy(userId)
 *    .byModel; gated on 20/50 MATURED vetoes with the same helpers as the
 *    Results page 'Red Team veto efficacy' scorecard. Same measure, per model.
 *  - Strategist (AI review / strategy-tune): no benchmark, no perf/efficacy join —
 *    just live cost/call, run count, and TOTAL cost per model over the window (the
 *    owner's explicit ask: historical spend on running AI review, per model). The
 *    table swaps Latency + performance for Runs + Total cost for this role.
 *  A trailing "Retired Models" group (owner 2026-09-18) lists any model id that has recorded
 *  stats for this role but is no longer a catalog row — see deriveRetiredModelIds below — so a
 *  catalog cleanup never silently deletes a model's history off this screen. */

import { useCallback, useRef, useState } from "react";
import { BarChart2 } from "lucide-react";
// Pure curated-model DATA (no legacy UI components) — same import the strategy
// page already uses, so the drawer lists exactly what the dropdowns offer.
import { CURATED_LLM_MODEL_GROUPS, CURATED_LLM_MODEL_IDS } from "../../ui/llm-model-catalog";
// Reuse the SAME veto-value-add gates + tone the Results page 'Red Team veto efficacy'
// scorecard uses, so the drawer and the scorecard never drift apart. Do NOT redefine these.
import {
  RED_TEAM_EFFICACY_MIN_RESOLVED,
  redTeamReturnTone,
  redTeamSampleGate,
  redTeamSampleTier // encapsulates the 20/50 (MIN/SOLID) matured-veto thresholds
} from "../lib/red-team-efficacy";
import { SENTENCE_GAP } from "../lib/format";
import { Chip, Dash, IconButton, Segmented, TONE_VAR } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

type PickerRole = "proposer" | "red-team" | "strategist";

interface ModelPerf {
  closedTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlUsd: number;
}

// Mirrors src/lib/model-stats.ts ReviewerPerf verbatim (the drawer hand-duplicates the
// route's response shapes). NOT win-rate: veto value-add is the counterfactual outcome of
// the proposals this reviewer vetoed — negative avgReturnPct = the veto avoided losses.
interface ReviewerPerf {
  maturedVetoes: number;
  vetoValueAddRate: number;
  survivorRiskHitRate: number;
  avgReturnPct: number;
}

interface ModelRoleStats {
  model: string;
  role: "green" | "red" | "strategist";
  liveCalls: number;
  avgCostUsd: number | null;
  /** Live TOTAL cost (USD) over the window; null when liveCalls === 0. Strategist-section only —
   *  the owner's explicit ask for historical spend on running AI review, per model. */
  totalCostUsd: number | null;
  totalTokens?: number | null;
  avgTokensPerCall?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  callsWithTokens?: number;
  // Same-class predecessor ESTIMATES (src/lib/model-stats.ts). Every figure above is this model's
  // own data; these are separate, labelled "est." in the UI and never counted as live.
  inheritedFrom?: string | null;
  isInherited?: boolean;
  costInheritedFrom?: string | null;
  latencyInheritedFrom?: string | null;
  perfInheritedFrom?: string | null;
  vetoInheritedFrom?: string | null;
  inheritedCalls?: number;
  inheritedCostPerCall?: number | null;
  inheritedAvgTokensPerCall?: number | null;
  inheritedPromptTokensPerCall?: number | null;
  inheritedCompletionTokensPerCall?: number | null;
  inheritedP50LatencyMs?: number | null;
  inheritedLatencySamples?: number;
  inheritedPerf?: ModelPerf | null;
  inheritedClosedTrades?: number;
  inheritedReviewerPerf?: ReviewerPerf | null;
  modelClass?: string | null;
  modelClassLabel?: string | null;
  /** Concrete model an alias row last resolved to (llm_usage.served_model). */
  servedModel?: string;
  /** Catalog native slug an alias row is expected to resolve to, when nothing is recorded yet. */
  expectedModel?: string;
  p50LatencyMs: number | null;
  latencySamples: number;
  benchmarkCostUsd: number | null;
  benchmarkColdP50Ms: number | null;
  closedTrades: number;
  perf: ModelPerf | null;
  reviewerPerf: ReviewerPerf | null;
}

interface ModelStatsResponse {
  sinceDays: number;
  benchmark: { runAt: string; source: string };
  stats: ModelRoleStats[];
}

/** Live figures need at least this many samples before they outrank the benchmark. */
const LIVE_MIN_SAMPLES = 3;
/** Below this many closed trades, realized performance stays hidden behind an explicit label. */
const PERF_MIN_TRADES = 20;
/** Between PERF_MIN_TRADES and this, performance shows WITH a small-sample caveat. */
const PERF_SOLID_TRADES = 50;

function fmtCost(v: number): string {
  return v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtSignedPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toLocaleString();
}

/** Chip for a same-class predecessor estimate. Never shown next to a live chip for the same number. */
function EstimateChip({ from, n, what }: { from: string; n?: number; what?: string }) {
  return (
    <Chip
      tone="muted"
      title={`Estimated from predecessor model ${from} (same class); not this model's own calls.${n ? `${SENTENCE_GAP}Based on its ${n} ${what ?? "live calls"}.` : ""}`}
    >
      est. from {from}
    </Chip>
  );
}

function CostCell({ s }: { s: ModelRoleStats | undefined }) {
  if (s && s.liveCalls >= LIVE_MIN_SAMPLES && s.avgCostUsd !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtCost(s.avgCostUsd)}</span>
        <Chip tone="accent" title={`Average cost per call over your last ${s.liveCalls} real calls in this role.`}>
          live · n={s.liveCalls}
        </Chip>
      </span>
    );
  }
  if (s && s.costInheritedFrom && s.inheritedCostPerCall != null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtCost(s.inheritedCostPerCall)}</span>
        <EstimateChip from={s.costInheritedFrom} n={s.inheritedCalls} />
      </span>
    );
  }
  if (s && s.benchmarkCostUsd !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtCost(s.benchmarkCostUsd)}</span>
        <Chip title="Estimated cost per call from a standardized offline benchmark run — not your live traffic.">benchmark</Chip>
      </span>
    );
  }
  return <Dash />;
}

function TokensCell({ s }: { s: ModelRoleStats | undefined }) {
  if (s && !(s.avgTokensPerCall != null && s.avgTokensPerCall > 0) && s.costInheritedFrom && s.inheritedAvgTokensPerCall) {
    const prompt = s.inheritedPromptTokensPerCall;
    const comp = s.inheritedCompletionTokensPerCall;
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtTokens(s.inheritedAvgTokensPerCall)}</span>
        {prompt != null && comp != null && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            ({fmtTokens(prompt)}/{fmtTokens(comp)})
          </span>
        )}
        <EstimateChip from={s.costInheritedFrom} n={s.inheritedCalls} />
      </span>
    );
  }
  if (s && s.avgTokensPerCall != null && s.avgTokensPerCall > 0) {
    const tokenCalls = s.callsWithTokens && s.callsWithTokens > 0 ? s.callsWithTokens : s.liveCalls;
    const prompt = s.promptTokens != null && tokenCalls > 0 ? Math.round(s.promptTokens / tokenCalls) : null;
    const comp = s.completionTokens != null && tokenCalls > 0 ? Math.round(s.completionTokens / tokenCalls) : null;
    const tooltip =
      prompt !== null && comp !== null
        ? `Avg ${fmtTokens(s.avgTokensPerCall)} tokens/call (~${fmtTokens(prompt)} in / ~${fmtTokens(comp)} out).${SENTENCE_GAP}Total: ${fmtTokens(s.totalTokens ?? 0)} tokens across ${tokenCalls} calls with reported usage.`
        : `Avg ${fmtTokens(s.avgTokensPerCall)} tokens/call.${SENTENCE_GAP}Total: ${fmtTokens(s.totalTokens ?? 0)} tokens across ${tokenCalls} calls with reported usage.`;

    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={tooltip}>
        <span className="con-num">{fmtTokens(s.avgTokensPerCall)}</span>
        {prompt !== null && comp !== null && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            ({fmtTokens(prompt)}/{fmtTokens(comp)})
          </span>
        )}
      </span>
    );
  }
  return <Dash />;
}

/** Strategist-only: call count over the window (Runs column). */
function RunsCell({ s }: { s: ModelRoleStats | undefined }) {
  if (!s || s.liveCalls === 0) return <Dash />;
  return <span className="con-num whitespace-nowrap">{s.liveCalls}</span>;
}

/** Strategist-only: TOTAL cost over the window — the owner's explicit ask for historical spend
 *  on running AI review, per model (distinct from the per-call CostCell above). */
function TotalCostCell({ s }: { s: ModelRoleStats | undefined }) {
  if (!s || s.totalCostUsd === null) return <Dash />;
  return <span className="con-num whitespace-nowrap">{fmtCost(s.totalCostUsd)}</span>;
}

function LatencyCell({ s }: { s: ModelRoleStats | undefined }) {
  if (s && s.latencySamples >= LIVE_MIN_SAMPLES && s.p50LatencyMs !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtLatency(s.p50LatencyMs)}</span>
        <Chip tone="accent" title={`Median (p50) of your last ${s.latencySamples} successful real calls in this role.`}>
          live · n={s.latencySamples}
        </Chip>
      </span>
    );
  }
  if (s && s.latencyInheritedFrom && s.inheritedP50LatencyMs != null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtLatency(s.inheritedP50LatencyMs)}</span>
        <EstimateChip from={s.latencyInheritedFrom} n={s.inheritedLatencySamples} what="successful live calls" />
      </span>
    );
  }
  if (s && s.benchmarkColdP50Ms !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtLatency(s.benchmarkColdP50Ms)}</span>
        <Chip title="Cold-start p50 from a standardized offline benchmark run — not your live traffic.">benchmark</Chip>
      </span>
    );
  }
  return <Dash />;
}

/** Which figure a performance cell shows: the model's OWN results whenever it has any (even a
 *  small sample, flagged as an early read), the same-class predecessor ESTIMATE only when it has
 *  none of its own, else nothing.  Real own results are never hidden behind an estimate.  Pure so
 *  it is unit-testable without rendering (test/model-stats-drawer.test.ts). */
export type PerfSource = "own" | "estimate" | "none";

export function greenPerfSource(
  s: Pick<ModelRoleStats, "closedTrades" | "perf" | "inheritedPerf" | "perfInheritedFrom"> | undefined
): PerfSource {
  if (s && (s.closedTrades ?? 0) > 0 && s.perf) return "own";
  if (s && s.inheritedPerf && s.perfInheritedFrom) return "estimate";
  return "none";
}

export function vetoPerfSource(
  s: Pick<ModelRoleStats, "reviewerPerf" | "inheritedReviewerPerf" | "vetoInheritedFrom"> | undefined
): PerfSource {
  if (s?.reviewerPerf && s.reviewerPerf.maturedVetoes > 0) return "own";
  if (s?.inheritedReviewerPerf && s.vetoInheritedFrom) return "estimate";
  return "none";
}

/** Reviewer (Red Team) veto value-add — the RED-role 4th column. NOT win-rate: it reports the
 *  counterfactual outcome of the proposals this model vetoed. HIGHER good-veto % is better, and
 *  a NEGATIVE avg counterfactual return is GOOD (the veto avoided losses), so the avg is toned
 *  via redTeamReturnTone (negative → the positive/"pos" tone).  Below the 20 matured-veto gate the
 *  model's own figure still shows, flagged as an early read; the predecessor estimate shows only
 *  when the model has no matured vetoes of its own. */
function ReviewerPerfCell({ s }: { s: ModelRoleStats | undefined }) {
  const source = vetoPerfSource(s);
  const n = s?.reviewerPerf?.maturedVetoes ?? 0;
  if (source === "estimate" && s?.inheritedReviewerPerf && s.vetoInheritedFrom) {
    const est = s.inheritedReviewerPerf;
    const estTone = redTeamReturnTone(est.avgReturnPct);
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">
          {est.vetoValueAddRate.toFixed(0)}% good vetoes · avg{" "}
          <span style={estTone === "muted" ? undefined : { color: TONE_VAR[estTone] }}>{fmtSignedPct(est.avgReturnPct)}</span>
        </span>
        <EstimateChip from={s.vetoInheritedFrom} n={est.maturedVetoes} what="matured vetoes" />
      </span>
    );
  }
  if (source !== "own" || !s?.reviewerPerf) {
    return <span className="whitespace-nowrap text-[color:var(--con-faint)]">— {redTeamSampleGate(n)}</span>;
  }
  const { vetoValueAddRate, avgReturnPct } = s.reviewerPerf;
  const avgTone = redTeamReturnTone(avgReturnPct);
  const tier = redTeamSampleTier(n);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="con-num">
        {vetoValueAddRate.toFixed(0)}% good vetoes · avg{" "}
        <span style={avgTone === "muted" ? undefined : { color: TONE_VAR[avgTone] }}>{fmtSignedPct(avgReturnPct)}</span>
      </span>
      {tier === "ready" ? (
        <Chip title={`${n} matured blocking vetoes attributed to this reviewer model; negative avg = losses avoided.`}>
          {redTeamSampleGate(n)}
        </Chip>
      ) : (
        <Chip tone="warn" title={`Only ${n} matured vetoes — treat this as an early read, not an established edge.`}>
          small sample (n={n})
        </Chip>
      )}
    </span>
  );
}

function PerfCell({ s, role }: { s: ModelRoleStats | undefined; role: Exclude<PickerRole, "strategist"> }) {
  if (role === "red-team") return <ReviewerPerfCell s={s} />;
  const source = greenPerfSource(s);
  const n = s?.closedTrades ?? 0;
  if (source === "estimate" && s?.inheritedPerf && s.perfInheritedFrom) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">
          {s.inheritedPerf.winRate.toFixed(0)}% win · avg {fmtSignedPct(s.inheritedPerf.avgPnlPct)}
        </span>
        <EstimateChip from={s.perfInheritedFrom} n={s.inheritedClosedTrades} what="closed trades" />
      </span>
    );
  }
  if (source !== "own" || !s?.perf) {
    return (
      <span className="whitespace-nowrap text-[color:var(--con-faint)]">
        — needs ≥{PERF_MIN_TRADES} closed trades (n={n})
      </span>
    );
  }
  const { winRate, avgPnlPct } = s.perf;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="con-num">
        {winRate.toFixed(0)}% win · avg {fmtSignedPct(avgPnlPct)}
      </span>
      {n < PERF_SOLID_TRADES ? (
        <Chip tone="warn" title={`Only ${n} closed trades — treat this as an early read, not an established edge.`}>
          small sample (n={n})
        </Chip>
      ) : (
        <Chip title={`${n} closed trades attributed to entries this model proposed.`}>n={n}</Chip>
      )}
    </span>
  );
}

/** Model ids with recorded stats that have since left the curated catalog (e.g. a catalog
 *  cleanup removed the row, or a raw historical id was never a catalog member at all) — derived
 *  as ids-with-stats MINUS ids-in-the-catalog, never a hardcoded list, so this keeps working
 *  after any future catalog edit without a matching change here. Pure so it's unit-testable
 *  without rendering: see test/model-stats-drawer.test.ts. `statsModelIds` should already be
 *  canonicalModelId output (that's what `s.model` on every ModelRoleStats row is), so a retired
 *  model's historical variants collapse onto the same one bare-slug entry here too. */
export function deriveRetiredModelIds(statsModelIds: Iterable<string>, catalogModelIds: Iterable<string>): string[] {
  const known = new Set(catalogModelIds);
  const retired = new Set<string>();
  for (const model of statsModelIds) {
    if (!known.has(model)) retired.add(model);
  }
  return Array.from(retired).sort();
}

/** Small stats button + drawer for ONE picker. `role` picks which side of the
 *  per-(model, role) stats to show: proposer = green, red-team = red, strategist = strategist
 *  (the AI review / strategy-tune seat — no benchmark, no perf/efficacy join, just live cost/call,
 *  run count, and total cost over the window). */
export function ModelStatsButton({ role }: { role: PickerRole }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sinceDays, setSinceDays] = useState<number>(0);
  // Generation counter + AbortController so a slow All-Time response cannot overwrite a newer
  // 30/90-day result, and an earlier finally cannot clear loading while a newer request is pending.
  const fetchGenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback((days: number) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++fetchGenRef.current;
    setLoading(true);
    const query = days > 0 ? `?sinceDays=${days}` : "";
    fetch(`/api/llm-usage/model-stats${query}`, { signal: ac.signal })
      .then(async (res) => {
        if (gen !== fetchGenRef.current) return;
        if (!res.ok) throw new Error(`Stats unavailable (${res.status}).`);
        setData((await res.json()) as ModelStatsResponse);
        setError(null);
      })
      .catch((err) => {
        if (gen !== fetchGenRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (gen === fetchGenRef.current) setLoading(false);
      });
  }, []);

  const openDrawer = useCallback(() => {
    setOpen(true);
    if (!data && !loading) {
      fetchStats(sinceDays);
    }
  }, [data, loading, fetchStats, sinceDays]);

  const statsRole = role === "proposer" ? "green" : role === "red-team" ? "red" : "strategist";
  const byModel = new Map((data?.stats ?? []).filter((s) => s.role === statsRole).map((s) => [s.model, s]));
  // Models that have stats for this role but have since left the curated catalog — shown as a
  // trailing "Retired Models" group below so their history doesn't silently disappear from the
  // drawer the moment a catalog cleanup removes the row (owner 2026-09-18).
  const retiredModelIds = deriveRetiredModelIds(byModel.keys(), CURATED_LLM_MODEL_IDS);
  // Naming follows the owner-directed convention from PR #1466 (Green Team / Red Team).
  const roleLabel = role === "proposer" ? "Green Team (proposer)" : role === "red-team" ? "Red Team (reviewer)" : "Strategist (AI review)";
  const isStrategist = role === "strategist";

  return (
    <>
      <IconButton
        label={
          isStrategist
            ? `Model stats — cost per call and total spend for every ${roleLabel} option.`
            : `Model stats — cost, latency and realized performance for every ${roleLabel} option.`
        }
        onClick={openDrawer}
      >
        <BarChart2 size={15} />
      </IconButton>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Model stats — ${roleLabel}`} wide>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] flex-1 min-w-[200px]">
            {isStrategist ? (
              <>
                Cost per call, token usage, run count, and total spend for every model in this picker, from your own recent AI review
                runs{data ? (data.sinceDays > 0 ? ` (last ${data.sinceDays} days)` : " (all time)") : ""}. There is no offline benchmark for AI review — a model with
                no runs in the window shows no data.
              </>
            ) : (
              <>
                Cost, latency, token usage, and realized performance per call for every model in this picker.{SENTENCE_GAP}Figures marked <strong>live</strong> come from your own
                recent calls in this role{data ? (data.sinceDays > 0 ? ` (last ${data.sinceDays} days)` : " (all time)") : ""}; models without enough live traffic show an
                estimate from their same-class predecessor (labelled <strong>est.</strong>) or a standardized offline <strong>benchmark</strong> run{data ? ` (most recently updated ${new Date(data.benchmark.runAt).toLocaleDateString(undefined, { timeZone: "America/Chicago" })})` : ""}.
              </>
            )}
          </p>
          <Segmented
            value={String(sinceDays)}
            onChange={(val) => {
              const days = Number(val);
              setSinceDays(days);
              fetchStats(days);
            }}
            options={[
              { value: "0", label: "All Time" },
              { value: "90", label: "90 Days" },
              { value: "30", label: "30 Days" }
            ]}
          />
        </div>
        {loading && <p className="py-4 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading model stats…</p>}
        {error && !loading && (
          <p className="rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
            {error}
          </p>
        )}
        {data && !loading && (
          <div className="overflow-x-auto">
            <table className="con-table w-full">
              <thead>
                <tr>
                  <th className="text-left">Provider</th>
                  <th className="text-left">Model</th>
                  <th className="text-left">Cost / call</th>
                  {isStrategist ? (
                    <>
                      <th className="text-left">Tokens / call</th>
                      <th className="text-left">Runs</th>
                      <th className="text-left">Total cost{data ? (data.sinceDays > 0 ? ` (${data.sinceDays}d)` : " (all time)") : ""}</th>
                    </>
                  ) : (
                    <>
                      <th className="text-left">Latency (p50)</th>
                      <th className="text-left">Tokens / call</th>
                      <th className="text-left">{role === "proposer" ? "Realized performance" : "Veto value-add"}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {CURATED_LLM_MODEL_GROUPS.map((group) => (
                  <ProviderRows key={group.provider} label={group.label} models={group.options.map((o) => o.value)} byModel={byModel} role={role} />
                ))}
                {retiredModelIds.length > 0 && (
                  <ProviderRows key="retired" label="Retired Models" models={retiredModelIds} byModel={byModel} role={role} />
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && !loading && (
          <p className="mt-3 text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            {isStrategist ? (
              <>
                Total cost = the sum of every AI review call&apos;s actual cost over the window shown above, per model; Runs =
                the number of AI review calls this model made in that window. Figures are live-only — there is no offline
                benchmark for AI review.
              </>
            ) : role === "proposer" ? (
              <>
                Realized performance = closed trades whose ENTRY this model proposed (win rate and average return per closed
                lot, all your accounts). Hidden until 20 closed trades exist; shown with a small-sample caveat until 50.
              </>
            ) : (
              <>
                Veto value-add = of the risk-adding proposals this model vetoed, the share whose counterfactual
                (had-it-run) outcome was a loss — a good veto avoids a loser — and the average counterfactual return
                (negative = value added). A veto resolves ~5 trading days after it&apos;s made; hidden until 20 resolved
                vetoes, small-sample caveat until 50. Same measure as the Results page &apos;Red Team veto efficacy&apos;
                scorecard, per model.
              </>
            )}
          </p>
        )}
      </Sheet>
    </>
  );
}

function ProviderRows({
  label,
  models,
  byModel,
  role
}: {
  label: string;
  models: string[];
  byModel: Map<string, ModelRoleStats>;
  role: PickerRole;
}) {
  return (
    <>
      {models.map((model, idx) => {
        const s = byModel.get(model);
        return (
          <tr key={model} className={idx === 0 ? "border-t border-[color:var(--con-border)]" : ""}>
            {idx === 0 && (
              <td
                rowSpan={models.length}
                className="align-middle pr-4 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]"
              >
                <div className="max-sm:[writing-mode:vertical-rl] max-sm:rotate-180 sm:whitespace-nowrap flex items-center justify-center min-h-[4rem] sm:min-h-0 sm:block sm:h-auto">
                  {label}
                </div>
              </td>
            )}
            <td className="whitespace-nowrap font-medium">
              <span>{model}</span>
              {s?.modelClassLabel && (
                <span className="block text-[length:10px] text-[color:var(--con-muted)] font-normal">
                  class: {s.modelClassLabel}
                </span>
              )}
              {(s?.servedModel || s?.expectedModel) && (
                <span className="block text-[length:10px] text-[color:var(--con-muted)] font-normal">
                  {s.servedModel ? `currently → ${s.servedModel}` : `expected → ${s.expectedModel}`}
                </span>
              )}
            </td>
            <td>
              <CostCell s={s} />
            </td>
            {role === "strategist" ? (
              <>
                <td>
                  <TokensCell s={s} />
                </td>
                <td>
                  <RunsCell s={s} />
                </td>
                <td>
                  <TotalCostCell s={s} />
                </td>
              </>
            ) : (
              <>
                <td>
                  <LatencyCell s={s} />
                </td>
                <td>
                  <TokensCell s={s} />
                </td>
                <td>
                  <PerfCell s={s} role={role} />
                </td>
              </>
            )}
          </tr>
        );
      })}
    </>
  );
}
