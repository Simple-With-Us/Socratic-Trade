import { countLookaheadFindingsByClassification, listLookaheadAuditFindings } from "@/lib/db";
import { computeLookaheadVerdict, loadLookaheadAuditConfig, lookaheadVerdictWindowSinceIso } from "@/lib/lookahead-audit";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/lookahead-audit — this user's truncated-replay lookahead-audit findings (newest pass
// first) plus the aggregate verdict, written by the weekly lookahead-audit due-job lane.
// Read-only: the console's Results-page panel renders per-decision persisted vs recomputed values
// with the honest three-way classification. The verdict is computed over the trailing
// LOOKAHEAD_VERDICT_WINDOW_DAYS window (not the full findings table) so one ancient, since-fixed
// mismatch cannot pin the verdict forever — see lookaheadVerdictWindowSinceIso.
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const cfg = loadLookaheadAuditConfig();
  return NextResponse.json({
    enabled: cfg.enabled,
    tolerancePoints: cfg.tolerancePoints,
    jaccardMin: cfg.jaccardMin,
    cadenceDays: cfg.cadenceDays,
    verdict: computeLookaheadVerdict(
      countLookaheadFindingsByClassification(userId, { sinceIso: lookaheadVerdictWindowSinceIso() }),
      cfg.verdictFloor
    ),
    findings: listLookaheadAuditFindings(userId, { limit: 200 })
  });
}
