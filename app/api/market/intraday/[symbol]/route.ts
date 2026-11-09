import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { fetchIntradayBars, normalizeTimeframe } from "@/lib/market-realtime";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/market/intraday/{symbol}?start=ISO&end=ISO&timeframe=1Min — token-gated intraday bars for
// congress.trade (App A). Same APP_B_INGEST_TOKEN bearer as the other peer-read routes.
//
// THIS IS THE IMPORTANT ONE. App A schedules its latency price snapshots RETROSPECTIVELY, so their due
// times are already in the past by the time a row exists. A live quote cannot answer a question about
// the past without fabricating it — which is exactly why 2937 of 2955 snapshots correctly refused and
// wrote `missed_window`. Minute bars answer it exactly, and can rebuild history after the fact.
//
// Returns 200 with `bars: []` when a provider confirmed the range has no bars (weekend, halt,
// pre-listing) so the caller only treats non-200 as a provider failure.  A credential miss,
// HTTP error, or timeout is 502 — collapsing that to empty bars made CT record a false miss
// and skip its fallback.  Never substitutes a current price for a past bar.
const MAX_RANGE_MS = 8 * 24 * 60 * 60 * 1000; // a week-plus of intraday is plenty per call

export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!verifySecuritiesImportToken(req)) {
    audit("market_read_rejected", { reason: "token", route: "intraday" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;

  const { symbol } = await params;
  const sp = new URL(req.url).searchParams;
  const start = sp.get("start") ?? "";
  const end = sp.get("end") ?? "";
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return NextResponse.json({ ok: false, error: "start and end must be ISO timestamps with end > start" }, { status: 400 });
  }
  if (endMs - startMs > MAX_RANGE_MS) {
    return NextResponse.json({ ok: false, error: "range too large; request at most 8 days per call" }, { status: 400 });
  }

  const timeframe = normalizeTimeframe(sp.get("timeframe"));
  const result = await fetchIntradayBars(
    symbol,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
    timeframe,
    undefined,
    { operatorPeerRead: true }
  );
  switch (result.kind) {
    case "ok":
      // Confirmed empty (weekend / halt) stays 200 so the caller only treats non-200 as a provider failure.
      return NextResponse.json({ ok: true, symbol: symbol.toUpperCase(), timeframe, bars: result.bars });
    case "unavailable":
      return NextResponse.json({ ok: false, error: result.reason }, { status: 502 });
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
