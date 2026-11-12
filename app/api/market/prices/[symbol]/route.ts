import { NextResponse } from "next/server";
import { fetchPriceSeries, parseMarketRange } from "@/lib/market-read";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  bestEffortAudit,
  peerReadRouteSqliteRetry,
  peerReadSqliteContentionResponse,
  isSqliteBusyErrorCode
} from "@/lib/sqlite-peer-read";

export const dynamic = "force-dynamic";

// GET /api/market/prices/{symbol}?from=YYYY-MM-DD&to=YYYY-MM-DD — token-gated, read-only EOD price
// history for congress.trade (App A) cache-aside reads. Auth: the same APP_B_INGEST_TOKEN bearer
// secret as /api/admin/securities/import (middleware passes bearer requests through unauthenticated;
// verified strictly here, constant-time). An unknown symbol or a confirmed empty range is 200
// { ticker, closes: [] }.  A short-lag stale tail (newest close behind the latest completed
// session by <= TERMINAL_SERIES_AGE_DAYS in src/lib/market-read.ts) is 502
// { ok: false, error: "stale" }.  A terminal series (delisted/acquired/halted; newest close
// more than that threshold behind the latest session) is 200 with the closes in range and
// currentPrice/currentPriceDate from the newest bar — App A computes staleness itself from
// the price date and no next provider has newer bars.  App A treats 200-empty as "this source
// has nothing" and only tries the next provider on non-200.  Closes are DESCENDING by date
// (closes[0] = latest close). See src/lib/market-read.ts.
export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!verifySecuritiesImportToken(req)) {
    bestEffortAudit("market_read_rejected", { reason: "token", route: "prices" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;
  const { symbol } = await params;
  let read;
  try {
    read = await peerReadRouteSqliteRetry(() => fetchPriceSeries(symbol, parseMarketRange(req.url)));
  } catch (err) {
    if (isSqliteBusyErrorCode(err)) return peerReadSqliteContentionResponse();
    throw err;
  }
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
