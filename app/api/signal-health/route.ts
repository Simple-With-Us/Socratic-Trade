import { listSignalHealthSnapshots } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  SIGNAL_HEALTH_COST_ROUND_TRIP_BPS,
  SIGNAL_HEALTH_HORIZONS,
  SIGNAL_HEALTH_MIN_OBSERVATIONS,
  SIGNAL_HEALTH_TOP_K
} from "@/lib/signal-health";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/signal-health — per-horizon signal-health snapshot history for this user (newest
// first), written by the daily signal-health-refresh lane. Read-only: the console's Results-page
// section renders the latest row + rolling series per horizon. Horizons with no rows yet simply
// return an empty series — the UI shows an honest empty state, never an estimate.
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json({
    minObservations: SIGNAL_HEALTH_MIN_OBSERVATIONS,
    topK: SIGNAL_HEALTH_TOP_K,
    costRoundTripBps: SIGNAL_HEALTH_COST_ROUND_TRIP_BPS,
    horizons: SIGNAL_HEALTH_HORIZONS.map((horizon) => ({
      horizon,
      snapshots: listSignalHealthSnapshots(userId, { horizon, limit: 30 })
    }))
  });
}
