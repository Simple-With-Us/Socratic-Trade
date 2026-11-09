import { NextResponse } from "next/server";
import { dryRunAutonomousWeightTuning } from "@/lib/strategy-tuning";
import { resolveRequestUserId } from "@/lib/request-user";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";

export const dynamic = "force-dynamic";

// Admin/diagnostic route (panel P1-1): a READ-ONLY deterministic dry-run/replay of the autonomous
// weight-tuning decision. It runs the SAME gate path a real auto-apply would (propose → write-scope-strip →
// clamp → STRICTER OOS + paired-t + drawdown/starvation guards) and returns exactly what an apply WOULD do —
// with ZERO writes (no setPolicy, no ledger row, no audit, no cadence advance). It ignores the
// `autoApplyWeights` flag so an operator can inspect the decision BEFORE enabling autonomy; any tuning-config
// invariant violations that WOULD block a real apply are surfaced in the response.
//
// Admin-gated by a middleware-verified primary/allowlisted admin email or a timing-safe
// ADMIN_REINDEX_TOKEN match; there is no environment bypass. This mirrors the backtest-ic
// "suggestion only" pattern — it never mutates policy.
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return withAdminOperationGuard(request, "tuning-dry-run", async () => {
    const userId = resolveRequestUserId(request);

    const decision = await dryRunAutonomousWeightTuning(userId);
    return NextResponse.json({
      ok: true,
      dryRun: true,
      decision,
      note: "Dry-run only — NO writes performed (no setPolicy, no ledger row, no audit). `wouldApply` reflects whether a real auto-apply would persist these weights under the current config. `invariantViolations`, when present, would block a real apply until fixed."
    });
  });
}
