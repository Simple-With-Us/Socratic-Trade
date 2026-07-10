// Per-model cost / latency / realized-performance rollup for the model pickers.
//
// Pure aggregation only — no DB access here, so the whole thing is unit-testable.
// The API route (app/api/llm-usage/model-stats/route.ts) feeds it:
//   - llm_usage summary rows        → live cost per call, per (model, role)
//   - llm_call_latency audit events → live p50 latency, per (model, role)
//   - the static 2026-07-08 benchmark JSON (docs/benchmarks/) → benchmark cost +
//     cold p50 so EVERY catalog model has numbers even with zero live traffic
//   - closed lots (calculatePnl) with their entry model (proposedByModel) →
//     realized win-rate / avg P&L, GREEN (proposer) only.
//
// Role mapping conventions (see recordLlmUsage call sites + recordLlmOutcome):
//   llm_usage.context: "strategy" = green/proposer; "strategy-bear" and
//   "red-team" = red/reviewer. Other contexts (chat, coach, …) are ignored —
//   this rollup exists for the Proposer/Reviewer pickers.
//   llm_call_latency payload.step: "bull" = green, "bear" = red.
//
// Performance gating contract (owner request 2026-07-08): the API always
// reports `closedTrades`, and includes `perf` whenever closedTrades >= 1 —
// the UI decides how to present it (hidden/caveated below its own thresholds).
// Red/reviewer perf is deliberately null: Red attribution is per-run (veto
// value-add in getRedTeamScorecard), not per-closed-trade — do not fake it here.

export type ModelRole = "green" | "red";

/** Subset of LlmUsageRow the rollup needs (llm_usage-shaped aggregate rows). */
export interface UsageRowLike {
  model: string | null;
  context: string | null;
  calls: number;
  costUsd: number;
}

/** One llm_call_latency audit event (payload is the raw audit JSON). */
export interface LatencyEventLike {
  payload: unknown;
}

/** Normalized benchmark reference for one (model, role) — from the static benchmark JSON. */
export interface BenchmarkRoleSummary {
  model: string;
  role: ModelRole;
  /** Benchmark avg estimated cost per call (USD). */
  benchmarkCostUsd?: number;
  /** Benchmark COLD p50 latency (ms) — first-call latency, the pessimistic bound. */
  benchmarkColdP50Ms?: number;
}

/** Subset of ClosedLot the rollup needs. */
export interface ClosedLotLike {
  /** Model that proposed the ENTRY (proposedByModel stamped on the opening proposal). */
  entryModel?: string;
  /** Model that reviewed the ENTRY. */
  reviewedByModel?: string;
  pnl: number;
  returnPct: number;
}

export interface ModelPerf {
  closedTrades: number;
  /** % of closed lots with returnPct > 0, 0-100, 1 decimal. */
  winRate: number;
  /** Mean returnPct across closed lots, 2 decimals. */
  avgPnlPct: number;
  /** Sum of realized P&L (USD), 2 decimals. */
  totalPnlUsd: number;
}

export interface ModelRoleStats {
  model: string;
  role: ModelRole;
  /** Live llm_usage calls in the window for this (model, role). */
  liveCalls: number;
  /** Live avg cost per call (USD); null when liveCalls === 0. */
  avgCostUsd: number | null;
  /** Live p50 latency (ms) from llm_call_latency audits; null when no samples. */
  p50LatencyMs: number | null;
  /** Number of successful live latency samples behind p50LatencyMs. */
  latencySamples: number;
  benchmarkCostUsd: number | null;
  benchmarkColdP50Ms: number | null;
  /** ALWAYS reported (0 when none) so the UI can render "needs >= N (n=X)". */
  closedTrades: number;
  /** Realized performance — present whenever closedTrades >= 1; UI applies display thresholds. */
  perf: ModelPerf | null;
}

/** Map an llm_usage context to a picker role; null = not a strategy-loop context. */
export function roleForUsageContext(context: string | null | undefined): ModelRole | null {
  if (context === "strategy") return "green";
  if (context === "strategy-bear" || context === "red-team") return "red";
  return null;
}

/** Map an llm_call_latency step to a picker role; null = unknown step. */
export function roleForLatencyStep(step: string | null | undefined): ModelRole | null {
  if (step === "bull") return "green";
  if (step === "bear") return "red";
  return null;
}

/** p50 via nearest-rank on a sorted copy; null for an empty list. */
export function medianMs(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid] + sorted[mid + 1]) / 2);
}

function key(model: string, role: ModelRole): string {
  return `${role} ${model}`;
}

export interface AggregateModelStatsInput {
  usageRows: UsageRowLike[];
  latencyEvents: LatencyEventLike[];
  benchmarkSummaries: BenchmarkRoleSummary[];
  closedLots: ClosedLotLike[];
  /** Optional extra model ids (e.g. the picker catalog) that must appear even with zero data anywhere. */
  models?: string[];
}

/**
 * Roll everything up to one row per (model, role). Emits the union of models seen in any
 * input (usage, latency, benchmark, closed lots, `models`), both roles each, so the picker
 * UI can look up any dropdown option and always find a row.
 */
export function aggregateModelStats(input: AggregateModelStatsInput): ModelRoleStats[] {
  const modelSet = new Set<string>(input.models ?? []);

  // Live cost per (model, role) from llm_usage rows.
  const cost = new Map<string, { calls: number; totalCostUsd: number }>();
  for (const row of input.usageRows) {
    const role = roleForUsageContext(row.context);
    if (!role || !row.model) continue;
    modelSet.add(row.model);
    const k = key(row.model, role);
    const bucket = cost.get(k) ?? { calls: 0, totalCostUsd: 0 };
    bucket.calls += Number.isFinite(row.calls) ? row.calls : 0;
    bucket.totalCostUsd += Number.isFinite(row.costUsd) ? row.costUsd : 0;
    cost.set(k, bucket);
  }

  // Live latency samples per (model, role). Only successful calls count — an instant
  // 429/error would otherwise drag the p50 toward zero.
  const latency = new Map<string, number[]>();
  for (const event of input.latencyEvents) {
    const p = event.payload as { step?: unknown; model?: unknown; durationMs?: unknown; ok?: unknown } | null | undefined;
    if (!p || typeof p !== "object") continue;
    const role = roleForLatencyStep(typeof p.step === "string" ? p.step : undefined);
    const model = typeof p.model === "string" && p.model ? p.model : undefined;
    const durationMs = typeof p.durationMs === "number" && Number.isFinite(p.durationMs) && p.durationMs > 0 ? p.durationMs : undefined;
    if (!role || !model || durationMs === undefined || p.ok !== true) continue;
    modelSet.add(model);
    const k = key(model, role);
    const bucket = latency.get(k);
    if (bucket) bucket.push(durationMs);
    else latency.set(k, [durationMs]);
  }

  // Benchmark reference per (model, role).
  const benchmark = new Map<string, BenchmarkRoleSummary>();
  for (const summary of input.benchmarkSummaries) {
    if (!summary.model) continue;
    modelSet.add(summary.model);
    benchmark.set(key(summary.model, summary.role), summary);
  }

  // Realized performance per proposer model (Green) and reviewer model (Red).
  const proposerLotsByModel = new Map<string, ClosedLotLike[]>();
  const reviewerLotsByModel = new Map<string, ClosedLotLike[]>();
  for (const lot of input.closedLots) {
    if (lot.entryModel) {
      modelSet.add(lot.entryModel);
      const bucket = proposerLotsByModel.get(lot.entryModel);
      if (bucket) bucket.push(lot);
      else proposerLotsByModel.set(lot.entryModel, [lot]);
    }
    if (lot.reviewedByModel) {
      modelSet.add(lot.reviewedByModel);
      const bucket = reviewerLotsByModel.get(lot.reviewedByModel);
      if (bucket) bucket.push(lot);
      else reviewerLotsByModel.set(lot.reviewedByModel, [lot]);
    }
  }

  const out: ModelRoleStats[] = [];
  const models = Array.from(modelSet).sort();
  for (const model of models) {
    for (const role of ["green", "red"] as ModelRole[]) {
      const c = cost.get(key(model, role));
      const lat = latency.get(key(model, role)) ?? [];
      const bench = benchmark.get(key(model, role));
      const lots = role === "green" ? (proposerLotsByModel.get(model) ?? []) : (reviewerLotsByModel.get(model) ?? []);
      const closedTrades = lots.length;
      let perf: ModelPerf | null = null;
      if (closedTrades >= 1) {
        const wins = lots.filter((l) => l.returnPct > 0).length;
        perf = {
          closedTrades,
          winRate: Number(((wins / closedTrades) * 100).toFixed(1)),
          avgPnlPct: Number((lots.reduce((s, l) => s + l.returnPct, 0) / closedTrades).toFixed(2)),
          totalPnlUsd: Number(lots.reduce((s, l) => s + l.pnl, 0).toFixed(2))
        };
      }
      out.push({
        model,
        role,
        liveCalls: c?.calls ?? 0,
        avgCostUsd: c && c.calls > 0 ? Number((c.totalCostUsd / c.calls).toFixed(6)) : null,
        p50LatencyMs: medianMs(lat),
        latencySamples: lat.length,
        benchmarkCostUsd: typeof bench?.benchmarkCostUsd === "number" ? bench.benchmarkCostUsd : null,
        benchmarkColdP50Ms: typeof bench?.benchmarkColdP50Ms === "number" ? bench.benchmarkColdP50Ms : null,
        closedTrades,
        perf
      });
    }
  }
  return out;
}

/** Raw shape of one summaries[] entry in docs/benchmarks/2026-07-08-llm-model-benchmark.json. */
export interface RawBenchmarkSummary {
  model?: unknown;
  role?: unknown;
  coldP50LatencyMs?: unknown;
  p50LatencyMs?: unknown;
  avgEstCostUsd?: unknown;
  coldAvgCostUsd?: unknown;
  warmAvgCostUsd?: unknown;
  successes?: unknown;
}

/**
 * Normalize the benchmark JSON's summaries into BenchmarkRoleSummary rows. Entries with
 * zero successes (e.g. the mistral rows that only saw HTTP errors) carry no numbers and
 * are dropped. Cold p50 is preferred (that's what a first picker-driven call feels like);
 * when a run never recorded a cold sample the overall p50 stands in. Cost prefers the
 * all-rounds average, then cold, then warm.
 */
export function normalizeBenchmarkSummaries(raw: RawBenchmarkSummary[]): BenchmarkRoleSummary[] {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const out: BenchmarkRoleSummary[] = [];
  for (const s of raw) {
    const model = typeof s.model === "string" ? s.model : undefined;
    const role = s.role === "green" || s.role === "red" ? (s.role as ModelRole) : undefined;
    if (!model || !role) continue;
    const benchmarkColdP50Ms = num(s.coldP50LatencyMs) ?? num(s.p50LatencyMs);
    const benchmarkCostUsd = num(s.avgEstCostUsd) ?? num(s.coldAvgCostUsd) ?? num(s.warmAvgCostUsd);
    if (benchmarkColdP50Ms === undefined && benchmarkCostUsd === undefined) continue;
    out.push({
      model,
      role,
      ...(benchmarkCostUsd !== undefined ? { benchmarkCostUsd } : {}),
      ...(benchmarkColdP50Ms !== undefined ? { benchmarkColdP50Ms } : {})
    });
  }
  return out;
}
