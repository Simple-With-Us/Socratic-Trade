import { NextResponse } from "next/server";
import { fetchGroupedBarsRest } from "@/lib/market-signals/massive";
import { fetchGroupedDailyBars } from "@/lib/market-signals/massive-s3";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

/**
 * Bulk daily OHLCV for the whole market — the data-lake / backfill endpoint. For US stocks it
 * uses the working Massive REST grouped-daily endpoint; for other assets (or as a fallback) it
 * uses the S3 flat files (note: object download is plan-gated on the current account). `?date=
 * YYYY-MM-DD` returns every ticker's bar; add `?symbol=AAPL` to extract one. `?asset=stocks|
 * options|indices|crypto|forex` (default stocks). 404 on weekend/holiday/unavailable/ungranted.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  const symbol = searchParams.get("symbol");
  const asset = (searchParams.get("asset") ?? "stocks") as "stocks" | "options" | "indices" | "crypto" | "forex";
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD is required" }, { status: 400 });
  }
  const userId = resolveRequestUserId(req);
  // Prefer the working REST grouped endpoint for stocks; fall back to S3 flat files.
  const bars = (asset === "stocks" ? await fetchGroupedBarsRest(date, userId) : null) ?? (await fetchGroupedDailyBars(date, asset, userId));
  if (!bars) {
    return NextResponse.json({ error: "No data for that date (weekend/holiday/unavailable, or S3 flat-file download not granted on this plan)." }, { status: 404 });
  }
  if (symbol) {
    const bar = bars.find((b) => b.ticker === symbol.toUpperCase()) ?? null;
    return NextResponse.json({ date, asset, symbol: symbol.toUpperCase(), bar });
  }
  return NextResponse.json({ date, asset, count: bars.length, bars });
}
