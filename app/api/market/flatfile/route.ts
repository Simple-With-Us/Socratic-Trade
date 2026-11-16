import { NextResponse } from "next/server";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "@/lib/auth/strip-identity";
import { fetchGroupedBarsRest } from "@/lib/market-signals/massive";
import { fetchGroupedDailyBars } from "@/lib/market-signals/massive-s3";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserIdOrResponse } from "@/lib/request-user";

export const dynamic = "force-dynamic";

/**
 * Bulk daily OHLCV for the whole market — the data-lake / backfill endpoint. For US stocks it
 * uses the working Massive REST grouped-daily endpoint; for other assets (or as a fallback) it
 * uses the S3 flat files (note: object download is plan-gated on the current account). `?date=
 * YYYY-MM-DD` returns every ticker's bar; add `?symbol=AAPL` to extract one. `?asset=stocks|
 * options|indices|crypto|forex` (default stocks). 404 on weekend/holiday/unavailable/ungranted.
 *
 * Session only.  A peer APP_B_INGEST_TOKEN bearer is not a session and must not authorize this
 * pull.  Middleware keeps the path off isPeerMarketReadPath for the same reason.  An authenticated
 * session is rate-limited before any Massive REST or S3 read.
 */
function isFlatfileSessionSource(source: string | null): boolean {
  return (
    source === AUTHENTICATED_IDENTITY_SOURCES.authJsSession ||
    source === AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess ||
    source === AUTHENTICATED_IDENTITY_SOURCES.localFallback
  );
}

function hasFlatfileSession(req: Request): boolean {
  const email = req.headers.get(AUTHENTICATED_EMAIL_HEADER)?.trim() ?? "";
  if (!email.includes("@")) return false;
  return isFlatfileSessionSource(req.headers.get(AUTHENTICATED_IDENTITY_SOURCE_HEADER));
}

export async function GET(req: Request) {
  if (!hasFlatfileSession(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const userId = resolveRequestUserIdOrResponse(req);
  if (userId instanceof Response) return userId;

  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  const symbol = searchParams.get("symbol");
  const asset = (searchParams.get("asset") ?? "stocks") as "stocks" | "options" | "indices" | "crypto" | "forex";
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date=YYYY-MM-DD is required" }, { status: 400 });
  }

  const limited = enforceRateLimit(userId, "market/flatfile", RATE_LIMITS.flatfile);
  if (limited) return limited;

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
