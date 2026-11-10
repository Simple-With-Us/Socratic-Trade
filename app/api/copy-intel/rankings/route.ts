import { NextResponse } from "next/server";
import { resolveRequestUserId } from "@/lib/request-user";
import { getConnectedAccountByBroker } from "@/lib/db";
import { DEFAULT_COPY_FOLLOW_POLICY, scoreCopyInvestor, shouldObserve } from "@/lib/copy-intel";
import { fetchEToroRankings } from "@/lib/etoro-copy";

export const dynamic = "force-dynamic";

/**
 * Observe-only CopyTrader rankings from the official eToro API.
 * Requires a connected eToro account.  Never starts a copy from this route.
 */
export async function GET(req: Request) {
  const userId = resolveRequestUserId(req);
  if (!shouldObserve(DEFAULT_COPY_FOLLOW_POLICY)) {
    return NextResponse.json({ error: "Copy intel is off." }, { status: 404 });
  }
  const acct = getConnectedAccountByBroker("etoro", userId) ?? getConnectedAccountByBroker("etoro", "local");
  const apiKey = acct?.apiKey?.trim();
  const userKey = acct?.apiSecret?.trim();
  if (!apiKey || !userKey) {
    return NextResponse.json({
      connected: false,
      results: [],
      note: "Connect eToro (Settings → Trading → API Key Management) to load official Popular Investor rankings."
    });
  }
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "OneYearAgo";
  try {
    const rows = await fetchEToroRankings(
      { apiKey, userKey },
      { period, popularInvestor: true, sort: "-gain", pageSize: 25 }
    );
    return NextResponse.json({
      connected: true,
      period,
      results: rows.map((row) => ({ ...row, score: scoreCopyInvestor(row) }))
    });
  } catch (error) {
    return NextResponse.json(
      { connected: true, error: error instanceof Error ? error.message : String(error), results: [] },
      { status: 502 }
    );
  }
}
