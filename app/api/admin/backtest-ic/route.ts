import { NextResponse } from "next/server";
import { buildFactorObservations, computeFactorICs, computePerFactorIC, computePerRegimeFactorICs, deriveWeightsFromIC, deriveWeightsFromICs, runWalkForwardOOS } from "@/lib/backtest";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";

export const dynamic = "force-dynamic";

// Admin/diagnostic route: validate the scan's factor weights against realized forward returns.
// READ-ONLY — never applies weights (auto-tuner's 20-closed-lot gate governs that).
// Admin-gated by a middleware-verified primary/allowlisted admin email or a timing-safe
// ADMIN_REINDEX_TOKEN match; there is no environment bypass. Cost admission runs after authorization.
//
// Query params:
//   horizonDays       Forward-return horizon in business days (default 5)
//   auditLimit        Max signal_snapshot rows to scan (default 500)
//   oos               Include walk-forward OOS validation (default true)
//   trainFraction     Train/test split fraction (default 0.7)
//   costRoundTripBps  Round-trip cost in bps for OOS adjustment (default 20)
//   taxRate           Short-term tax rate for OOS adjustment (default 0.24)
//   topK              Top-K names per date in OOS equity curve (default 3)
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const horizonDays = Number(url.searchParams.get("horizonDays")) || 5;
  const auditLimit = Number(url.searchParams.get("auditLimit")) || 500;
  const includeOOS = url.searchParams.get("oos") !== "false";
  const trainFraction = Number(url.searchParams.get("trainFraction")) || 0.7;
  const costRoundTripBps = Number(url.searchParams.get("costRoundTripBps")) || 20;
  const taxRate = Number(url.searchParams.get("taxRate")) || 0.24;
  const topK = Number(url.searchParams.get("topK")) || 3;
  return withAdminOperationGuard(request, "backtest-ic", async () => {
    const observations = await buildFactorObservations(userId, { horizonDays, auditLimit });
    const ics = computeFactorICs(observations);
    // Item 7 (report-only): per-regime factor ICs. Application of regime-conditioned weights is intentionally
    // left OFF — per-regime buckets are almost always too thin to act on without overfitting. `sufficient`
    // flags which regimes even have enough distinct snapshot dates to be worth reading.
    const perRegimeICs = computePerRegimeFactorICs(observations);
    // computePerFactorIC is an alias for computeFactorICs; derive weights using the minN gate.
    const perFactorIC = computePerFactorIC(observations);
    const suggestedWeightsGated = deriveWeightsFromIC(perFactorIC);
    const current = getPolicy(userId).scoringWeights;
    const suggestedWeights = deriveWeightsFromICs(ics, current);

    const oosResult = includeOOS
      ? await runWalkForwardOOS(userId, { horizonDays, auditLimit, trainFraction, costRoundTripBps, taxRate, topK })
      : null;

    return NextResponse.json({
      ok: true,
      horizonDays,
      observationCount: observations.length,
      informationCoefficients: ics,
      currentWeights: current ?? null,
      suggestedWeights,
      suggestedWeightsGated,
      perRegimeICs,
      perRegimeNote: "Report only. Per-regime weight APPLICATION is intentionally not wired (per-regime samples are typically too thin to act on without overfitting); read `sufficient` before drawing any conclusion.",
      note: "Suggestion only. Apply via the strategy tuner, which holds weight shifts to the 20-closed-lot gate.",
      oos: oosResult
        ? {
            trainObservations: oosResult.trainObservations,
            testObservations: oosResult.testObservations,
            trainDates: oosResult.trainDates,
            testDates: oosResult.testDates,
            oosIC: oosResult.oosIC,
            oosICIR: oosResult.oosICIR,
            oosICDefault: oosResult.oosICDefault,
            icWeights: oosResult.icWeights,
            equityCurve: oosResult.equityCurve,
            annualizedReturn: oosResult.annualizedReturn,
            benchmarkAnnualizedReturn: oosResult.benchmarkAnnualizedReturn,
            activeReturn: oosResult.activeReturn,
            sharpeRatio: oosResult.sharpeRatio,
            maxDrawdownPct: oosResult.maxDrawdownPct,
            note: oosResult.note
          }
        : oosResult === null && includeOOS
          ? { note: "Insufficient data: fewer than 4 unique snapshot dates available for a walk-forward split." }
          : null
    });
  });
}
