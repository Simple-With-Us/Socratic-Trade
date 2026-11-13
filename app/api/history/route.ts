import { NextResponse } from "next/server";
import {
  brokerReadError,
  brokerReadOrInternalError,
  isBrokerGatewayError,
  jsonError,
  reportHandledErrorThrottled,
  resolveRequestUserIdOrApiError
} from "@/lib/api-error";
import { fetchDailyOHLC, HistoryProviderError, toBusinessDay } from "@/lib/history";

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

const HISTORY_PROVIDER_ERROR_KEY = "history-provider";

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbol") ?? "";
  const symbol = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "invalid or missing symbol" }, { status: 400 });
  }

  const userId = resolveRequestUserIdOrApiError(req);
  if (userId instanceof Response) return userId;

  try {
    // A cascade where every attempted tier failed throws its last payload-free provider error,
    // so a timeout or rejected key is classified below instead of collapsing to null.
    const bars = await fetchDailyOHLC(symbol, Date.now(), userId, { throwOnProviderFailure: true });
    // null means no tier could answer (all skipped); an empty array is a confirmed "no usable series".
    if (bars == null) {
      reportHandledErrorThrottled(
        HISTORY_PROVIDER_ERROR_KEY,
        "Price history fetch failed",
        new Error("History provider returned no series")
      );
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
    if (error instanceof HistoryProviderError || isBrokerGatewayError(error)) {
      reportHandledErrorThrottled(HISTORY_PROVIDER_ERROR_KEY, "Price history fetch failed", error);
      return brokerReadError(error);
    }
    return brokerReadOrInternalError(error);
  }
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
