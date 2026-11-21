import type { BenchmarkComparison } from "@/lib/types";
import type { DayPnl, DayPnlBrokerHints } from "./derive";

// Presentation only. Never edit the amount, calculation inputs, or persisted history.
// Matching an inferred hint to a render is not proof of fill/cash inclusion timing.
export function dayPnlDisplayAvailable(value: DayPnl | null, hints?: DayPnlBrokerHints): boolean {
  return value !== null && value.cashFlowSource === "broker"
    && typeof hints?.todayBrokerFlow === "number" && Number.isFinite(hints.todayBrokerFlow);
}

export function externalFlowDisplayAvailable(
  benchmark: Pick<BenchmarkComparison, "cashFlowSource"> | undefined
): boolean {
  return benchmark?.cashFlowSource === "broker";
}

export const CASH_FLOW_TIMING_UNAVAILABLE = "Unavailable: cash-flow timing is not verified.";

export const BENCHMARK_TIMING_CAVEAT = "Existing comparison model. Cash-flow timing is not verified, so inferred adjustments are not established deposits or withdrawals. Numerical return calculations are unchanged.";
