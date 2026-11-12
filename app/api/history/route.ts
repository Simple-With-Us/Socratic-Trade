import { NextResponse } from "next/server";
import {
  brokerReadError,
  brokerReadOrInternalError,
  isBrokerGatewayError,
  jsonError,
  reportHandledError,
  resolveRequestUserIdOrApiError
} from "@/lib/api-error";
import { fetchDailyOHLC, toBusinessDay } from "@/lib/history";

export const dynamic = "force-dynamic";

// Daily OHLC price history for the symbol-drilldown price chart. Read-only; reuses the
// shared free OHLC fetch (Yahoo → Stooq) and returns chart-ready candles (deduped,
// ascending, 'YYYY-MM-DD' business days). No bars → empty array, never fabricated.

interface ChartBar {
  time: string; // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  vwap?: number; // only present when the source supplies it (e.g. Massive `vw`)
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbol") ?? "";
  const symbol = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid or missing symbol" }, { status: 400 });
  }

  const userId = resolveRequestUserIdOrApiError(req);
  if (userId instanceof Response) return userId;

  try {
    const bars = await fetchDailyOHLC(symbol, Date.now(), userId);
    // fetchDailyOHLC catches provider failures and resolves null; a genuine empty
    // series is an array (possibly length 0).  Only null is a total provider failure.
    if (bars == null) {
      reportHandledError("Price history fetch failed", new Error("History provider returned no series"));
      return jsonError(502, "broker_unavailable", "Price history is temporarily unavailable.");
    }
    if (bars.length === 0) {
      return NextResponse.json({ symbol, bars: [], note: "no price history available" });
    }

    // Map to chart-ready daily bars. Keyed providers usually give full OHLC candles; shared/imported
    // caches may only have closes. Keep close-only rows so the drawer can still render a line chart.
    const byDay = new Map<string, ChartBar>();
    for (const b of bars) {
      const time = toBusinessDay(b.time);
      if (!time) continue;
      const close = numOrUndef(b.close);
      if (close == null) continue;
      byDay.set(time, { time, open: numOrUndef(b.open), high: numOrUndef(b.high), low: numOrUndef(b.low), close, volume: numOrUndef(b.volume), vwap: numOrUndef(b.vwap) });
    }
    const chartBars = [...byDay.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    return NextResponse.json({ symbol, bars: chartBars });
  } catch (error) {
    if (isBrokerGatewayError(error)) {
      reportHandledError("Price history fetch failed", error);
      return brokerReadError(error);
    }
    return brokerReadOrInternalError(error);
  }
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
