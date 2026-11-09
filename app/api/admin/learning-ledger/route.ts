import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { resolveRequestUserId } from "@/lib/request-user";
import { getPolicy, listLearningMutations } from "@/lib/db";
import { revertLearningMutation, LEARNING_SUBSYSTEM_SCORING_WEIGHTS } from "@/lib/learning-ledger";

export const dynamic = "force-dynamic";

// Admin-only unified learning-mutation ledger (panel P0-4).
//   GET  → list recent ledger entries (before/after weight vectors, evidence, subsystem, flag, revert state).
//   POST → revert a learning mutation (restores the prior state via setPolicy ONLY). Body:
//            { entryId?: string, subsystem?: string }
//          `entryId` reverts a specific row; otherwise the most-recent non-reverted row for the subsystem
//          (default `scoring_weights`) on the caller's active account is reverted.
//
// Admin-gated because a revert mutates live policy and this repo has prior IDOR history. requireAdmin
// accepts a middleware-verified primary/allowlisted admin email or the timing-safe legacy
// x-admin-token; there is no environment bypass.

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const connectedAccountId = getPolicy(userId).connectedAccountId;
  const subsystem = url.searchParams.get("subsystem") || undefined;
  const limit = Number(url.searchParams.get("limit")) || 50;
  const entries = listLearningMutations(userId, { connectedAccountId, subsystem, limit });
  return NextResponse.json({ ok: true, count: entries.length, entries });
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  const body = (await request.json().catch(() => ({}))) as { entryId?: string; subsystem?: string };
  const connectedAccountId = getPolicy(userId).connectedAccountId;

  const result = revertLearningMutation({
    subsystem: body.subsystem || LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
    userId,
    connectedAccountId,
    entryId: typeof body.entryId === "string" ? body.entryId : undefined,
    revertedBy: request.headers.get("x-authenticated-user-email") || "admin"
  });

  if (!result.reverted) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 404 });
  }
  return NextResponse.json({ ok: true, entryId: result.entryId, restoredWeights: result.restoredWeights });
}
