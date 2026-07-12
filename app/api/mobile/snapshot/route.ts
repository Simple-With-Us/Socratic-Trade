import { getDashboardSnapshot } from "@/lib/dashboard";
import { listMobileCommands, mobileControlCatalog, mobileReadiness } from "@/lib/mobile-api";
import { resolveRequestUser } from "@/lib/request-user";
import { listAlerts } from "@/lib/alerts";
import { listWatchlist } from "@/lib/watchlist";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  const snapshot = await getDashboardSnapshot(user.userId, user.email);
  return NextResponse.json({
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
      maxOrderNotional: snapshot.policy.maxOrderNotional,
      maxOrderPctOfNav: snapshot.policy.maxOrderPctOfNav,
      maxDailyNotional: snapshot.policy.maxDailyNotional,
      maxDailyOrders: snapshot.policy.maxDailyOrders
    },
    marketSession: snapshot.marketSession,
    scheduler: snapshot.scheduler,
    portfolio: snapshot.portfolio,
    positions: snapshot.positions,
    orders: snapshot.orders,
    pendingProposals: snapshot.pendingProposals,
    dailyStats: snapshot.dailyStats,
    performance: snapshot.performance,
    connectedAccounts: snapshot.connectedAccounts,
    watchlist: listWatchlist(user.userId),
    alerts: listAlerts(user.userId, "all"),
    recentCommands: listMobileCommands({ userId: user.userId, limit: 30 })
  });
}
