import { NextResponse } from "next/server";
import { buildCongressScoreObservations, evaluateCongressScore } from "@/lib/congress-score-eval";
import { storeCongressScoreVerdict, readCongressScoreVerdict } from "@/lib/congress-score-gate";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

// Admin/diagnostic route (item 2): run the congress-score statistical validation (placebo-IC, t-stat,
// marginal-IC, quantile spread) and CACHE the go/no-go verdict so `policy.tuning.congressGoNoGoGating`
// can gate the scan on it cheaply. READ-ONLY for the market path — storing a verdict never places trades.
// Gated: runs only outside production OR when ADMIN_REINDEX_TOKEN matches the x-admin-token header.
//
// GET  → return the currently-cached verdict (or null) without recomputing.
// POST → recompute from signal_snapshot audit history + SPY benchmark, store the fresh verdict, return it.
//
// Query params (POST):
//   horizonDays   Forward-return horizon in business days (default 63)
//   auditLimit    Max signal_snapshot rows to scan (default 1000)
//   placeboSeed   Optional seed to also run the placebo (rotate-scores) control
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  const verdict = readCongressScoreVerdict(userId);
  return NextResponse.json({ ok: true, verdict: verdict ?? null });
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const horizonDays = Number(url.searchParams.get("horizonDays")) || 63;
  const auditLimit = Number(url.searchParams.get("auditLimit")) || 1000;
  const placeboSeedRaw = url.searchParams.get("placeboSeed");
  const placeboSeed = placeboSeedRaw != null && placeboSeedRaw !== "" ? Number(placeboSeedRaw) : undefined;

  // P2-3: honor the operator's `congressRequireTopBucketPositive` flag so the cached verdict reflects the
  // long-leg-positive requirement (default off → unchanged verdict).
  const requireTopBucketPositive = getPolicy(userId).tuning?.congressRequireTopBucketPositive ?? false;
  const observations = await buildCongressScoreObservations(userId, { horizonDays, auditLimit });
  const evaluation = evaluateCongressScore(observations, {
    ...(placeboSeed !== undefined ? { placeboSeed } : {}),
    requireTopBucketPositive
  });
  const verdict = storeCongressScoreVerdict(userId, evaluation);

  return NextResponse.json({
    ok: true,
    verdict,
    evaluation: {
      observations: evaluation.observations,
      dates: evaluation.dates,
      tickers: evaluation.tickers,
      rankIC: evaluation.rankIC,
      marginalIC: evaluation.marginalIC ?? null,
      topMinusBottomReturn: evaluation.topMinusBottomReturn,
      placeboDeltaIC: evaluation.placeboDeltaIC ?? null,
      goNoGo: evaluation.goNoGo
    },
    note: "Verdict cached. `policy.tuning.congressGoNoGoGating` (default off) gates the scan on it; a stale (>14d) verdict fails open (no gating)."
  });
}
