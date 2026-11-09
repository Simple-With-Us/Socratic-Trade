import { NextResponse } from "next/server";
import { getPolicy } from "@/lib/db";
import { newestPersistedMarketScan } from "@/lib/market-scan-freshness";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { resolveRequestUserId } from "@/lib/request-user";
import { refreshWeeklyMarketDigest, weeklyMarketDigestForScan } from "@/lib/weekly-market-digest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  let userId = "local";
  try {
    userId = resolveRequestUserId(request);
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const limited = enforceRateLimit(
      userId,
      refresh ? "weekly-digest-refresh" : "weekly-digest",
      refresh ? RATE_LIMITS.weeklyDigestRefresh : RATE_LIMITS.weeklyDigest
    );
    if (limited) return limited;

    if (refresh) {
      const digest = await refreshWeeklyMarketDigest(userId);
      return NextResponse.json({ digest, refreshed: true });
    }

    const policy = getPolicy(userId);
    const persisted = newestPersistedMarketScan(userId, policy.connectedAccountId);
    const digest = weeklyMarketDigestForScan(userId, persisted?.scan);
    return NextResponse.json({ digest, refreshed: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Weekly screens failed." },
      { status: 500 }
    );
  }
}
