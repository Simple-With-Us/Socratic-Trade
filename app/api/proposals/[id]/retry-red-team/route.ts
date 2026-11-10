import { getPolicy } from "@/lib/db";
import { invalidateDashboardSnapshotCache } from "@/lib/dashboard-snapshot-cache";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { retryProposalRedTeam, RetryRedTeamError } from "@/lib/retry-red-team";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
    const userId = resolveRequestUserId(request, body);
    const limited = enforceRateLimit(userId, "proposals/retry-red-team", RATE_LIMITS.orders);
    if (limited) return limited;
    if (isProposalActionStopped(getPolicy(userId))) {
      return NextResponse.json(
        { error: "system_stopped", message: STOPPED_PROPOSAL_ACTION_MESSAGE },
        { status: 409 }
      );
    }
    const { id } = await params;
    const result = await retryProposalRedTeam(id, userId);
    invalidateDashboardSnapshotCache(userId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RetryRedTeamError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Failed to retry Red Team.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
