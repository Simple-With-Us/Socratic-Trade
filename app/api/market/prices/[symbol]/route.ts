import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { fetchPriceSeries, parseMarketRange } from "@/lib/market-read";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/market/prices/{symbol}?from=YYYY-MM-DD&to=YYYY-MM-DD — token-gated, read-only EOD price
// history for congress.trade (App A) cache-aside reads. Auth: the same APP_B_INGEST_TOKEN bearer
// secret as /api/admin/securities/import (middleware passes bearer requests through unauthenticated;
// verified strictly here, constant-time). An unknown symbol or a confirmed empty range is 200
// { ticker, closes: [] }.  A stale tail is 502 { ok: false, error: "stale" }.  App A treats
// 200-empty as "this source has nothing" and only tries the next provider on non-200.  Closes
// are DESCENDING by date (closes[0] = latest close). See src/lib/market-read.ts.
export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!verifySecuritiesImportToken(req)) {
    audit("market_read_rejected", { reason: "token", route: "prices" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;
  const { symbol } = await params;
  const read = await fetchPriceSeries(symbol, parseMarketRange(req.url));
  switch (read.kind) {
    case "ok":
      return NextResponse.json(read.series);
    case "stale":
      return NextResponse.json({ ok: false, error: "stale" }, { status: 502 });
    default: {
      const _exhaustive: never = read;
      return _exhaustive;
    }
  }
}
