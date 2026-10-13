import { getDashboardSnapshot } from "@/lib/dashboard";
import { listMobileCommands, mobileControlCatalog, mobileReadiness } from "@/lib/mobile-api";
import { withMobileEquityCurveCompat } from "@/lib/mobile-equity-curve-compat";
import { compactMobileMarketScan } from "@/lib/mobile-scan";
import { buildNotificationHistory } from "@/lib/notification-history";
import { resolveRequestUser } from "@/lib/request-user";
import { listAlerts } from "@/lib/alerts";
import { listWatchlist } from "@/lib/watchlist";
import { isWorkingOrderState } from "@/lib/broker-held-orders";
import { plainEnglishRunFailure } from "@/lib/strategy-run-failure";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  const snapshot = await getDashboardSnapshot(user.userId, user.email);
  return NextResponse.json({
    // Server-side partial flag.  iOS ORs this with per-item decode drops so a timed-out
    // broker read pauses Owner Approve instead of looking like a complete book.
    partialData: snapshot.partialData === true,
    partialReason: snapshot.partialReason ?? null,
    currentUser: snapshot.currentUser,
    catalog: mobileControlCatalog(),
    readiness: mobileReadiness(user.userId),
    policy: {
      systemState: snapshot.policy.systemState,
      strategyAuthority: snapshot.policy.strategyAuthority,
      accountNumber: snapshot.policy.accountNumber ?? null,
      connectedAccountId: snapshot.policy.connectedAccountId ?? null,
      includedIndices: snapshot.policy.includedIndices,
      additionalSymbols: snapshot.policy.additionalSymbols,
      blocklist: snapshot.policy.blocklist ?? [],
      holdingHorizon: snapshot.policy.holdingHorizon,
      runCadenceMinutes: snapshot.policy.runCadenceMinutes,
      // Lets iOS share the console's market-aware run-state vocabulary
      // (deriveStateInfo): without it "active" outside market hours renders
      // "Running" on the phone while the console says "Paused · market closed".
      runDuringExtendedHours: snapshot.policy.runDuringExtendedHours,
      maxOrderNotional: snapshot.policy.maxOrderNotional,
      maxOrderPctOfNav: snapshot.policy.maxOrderPctOfNav,
      maxDailyNotional: snapshot.policy.maxDailyNotional,
      maxDailyPctOfNav: snapshot.policy.maxDailyPctOfNav,
      maxDailyOrders: snapshot.policy.maxDailyOrders,
      requireTypedConfirmation: snapshot.policy.requireTypedConfirmation !== false
    },
    marketSession: snapshot.marketSession,
    scheduler: snapshot.scheduler,
    portfolio: snapshot.portfolio,
    positions: snapshot.positions,
    orders: snapshot.orders.filter(o => isWorkingOrderState(o.state)),
    pendingProposals: snapshot.pendingProposals,
    dailyStats: snapshot.dailyStats,
    performance: withMobileEquityCurveCompat(snapshot.performance),
    connectedAccounts: snapshot.connectedAccounts,
    watchlist: listWatchlist(user.userId),
    alerts: listAlerts(user.userId, "all"),
    notifications: buildNotificationHistory({
      notifications: snapshot.notifications,
      symbolMetaBySymbol: snapshot.symbolMetaBySymbol,
      connectedAccounts: snapshot.connectedAccounts
    }),
    strategyRuns: (snapshot.strategyRuns ?? []).map((run) => ({
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      status: run.status,
      summary: run.summary ?? null,
      connectedAccountId: run.connectedAccountId ?? null,
      placedCount: run.placedCount,
      paperCount: run.paperCount,
      blockedCount: run.blockedCount,
      proposedCount: run.proposedCount,
      totalCount: run.totalCount,
      failure:
        run.status === "failed" ? plainEnglishRunFailure({ status: run.status, summary: run.summary }) : null
    })),
    unifiedFeed: (snapshot.unifiedFeed ?? []).slice(0, 40).map((group) => ({
      id: group.id,
      title: group.title,
      detail: group.detail,
      status: group.status,
      updatedAt: group.updatedAt,
      accountLabel: group.accountLabel ?? null,
      failure:
        group.status === "failed"
          ? plainEnglishRunFailure({ status: group.status, summary: group.detail })
          : null
    })),
    recentCommands: listMobileCommands({ userId: user.userId, limit: 30 }),
    // Same last-good universe `/console/scan` paints when live Refresh 503s.
    latestScan: compactMobileMarketScan(snapshot.latestScan),
    weeklyMarketDigest: snapshot.weeklyMarketDigest
  });
}
