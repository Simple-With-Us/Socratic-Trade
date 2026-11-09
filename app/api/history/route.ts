import { NextResponse } from "next/server";
import { fetchDailyOHLC, toBusinessDay } from "@/lib/history";
import { resolveRequestUserId } from "@/lib/request-user";

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

  try {
    const bars = await fetchDailyOHLC(symbol, Date.now(), resolveRequestUserId(req));
    if (!bars || bars.length === 0) {
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
  } catch {
    return NextResponse.json({ symbol, bars: [], note: "price history fetch failed" });
  }
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
