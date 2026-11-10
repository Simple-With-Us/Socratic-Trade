import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import {
  armEarningsCallsBurst,
  clearEarningsCallsEntitlementBlock,
  earningsCallsBudgetUsage,
  earningsCallsBurstMaxTranscripts,
  earningsCallsBurstPending,
  earningsCallsEntitlementState,
  earningsCallsLastPicksAudit,
  manuallyProbeEarningsCallsEntitlement
} from "@/lib/earningscalls-transcripts";
import { earningsCallsTranscriptsEnabled } from "@/lib/earningscalls-gate";

export const dynamic = "force-dynamic";

// Admin/operator route for the EarningsCalls.dev burst/smart-daily program
// (docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md):
//   GET  -> entitlement state, dual-bound budget usage, pending burst, and the last pass's
//     scored picks + rationale.
//   POST {action:"burst", maxTranscripts?} -> arms the one-shot burst counter (default the
//     configured ceiling, EARNINGSCALLS_BURST_MAX_TRANSCRIPTS=25). Consumed by the NEXT scheduled
//     or admin-triggered pass, idempotently.
//   POST {action:"probe-entitlement"} -> immediately re-checks entitlement (GET /me + one real
//     transcript fetch), OUTSIDE the once/day cadence, so an operator can re-verify right after a
//     plan upgrade without waiting for the next scheduled pass.
//   POST {action:"clear-entitlement-block"} -> resets the durable block to "unknown" (spends no
//     requests) so the next scheduled pass re-determines it from scratch.
// Admin-gated via the shared requireAdmin gate + the durable RAG_REINDEX operation lease (mirrors
// app/api/admin/sec-ingest) — a manual action can never race the scheduler's own daily pass.

export async function GET(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  return NextResponse.json({
    ok: true,
    enabled: earningsCallsTranscriptsEnabled(),
    entitlement: earningsCallsEntitlementState(),
    budget: earningsCallsBudgetUsage(),
    burst: {
      pending: earningsCallsBurstPending(),
      maxTranscripts: earningsCallsBurstMaxTranscripts()
    },
    lastPicks: earningsCallsLastPicksAudit() ?? null
  });
}

export async function POST(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  let action: string | undefined;
  let maxTranscripts: number | undefined;
  try {
    const body = (await request.json()) as { action?: string; maxTranscripts?: number };
    action = body?.action;
    if (Number.isFinite(Number(body?.maxTranscripts))) maxTranscripts = Number(body.maxTranscripts);
  } catch {
    // no body / not JSON -> action stays undefined (handled below)
  }

  if (action !== "burst" && action !== "probe-entitlement" && action !== "clear-entitlement-block") {
    return NextResponse.json(
      {
        ok: false,
        error: 'Provide { action: "burst" | "probe-entitlement" | "clear-entitlement-block", maxTranscripts?: number } in the request body.'
      },
      { status: 400 }
    );
  }

  if (action === "clear-entitlement-block") {
    // No provider spend, no lease contention risk — a plain settings write.
    const state = clearEarningsCallsEntitlementBlock();
    return NextResponse.json({ ok: true, entitlement: state });
  }

  return withAdminOperationGuard(request, "earningscalls", async (claim) => {
    try {
      if (action === "burst") {
        const armed = armEarningsCallsBurst(maxTranscripts ?? earningsCallsBurstMaxTranscripts());
        return NextResponse.json({ ok: true, armed });
      }
      // probe-entitlement
      if (!claim) {
        return NextResponse.json({ ok: false, error: "Operation lease claim unavailable." }, { status: 500 });
      }
      const probe = await manuallyProbeEarningsCallsEntitlement(Date.now(), claim, undefined);
      return NextResponse.json({ ok: true, ...probe });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  });
}
