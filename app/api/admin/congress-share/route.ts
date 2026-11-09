import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { congressTradeToken, isCongressShareAutoEnabled, runCongressDailyShare } from "@/lib/congress-share";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import { getOperationLeaseBusy } from "@/lib/operation-lease";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";

export const dynamic = "force-dynamic";

// Admin/ops route to manually push company refs + daily closes + the S&P-500 series to congress.trade
// (App A). Admin-gated by a middleware-verified primary/allowlisted admin email or a timing-safe
// x-admin-token; there is no environment bypass. Requires CONGRESS_TRADE_TOKEN to be configured and
// bypasses the once-per-day cadence (force) so ops can test.
//
// Body (all optional):
//   { symbols?: string[] }      — share only those tickers (targeted test; does NOT advance the daily marker)
//   { fullHistory?: boolean }   — deep-history backfill: send each symbol's FULL series (uncapped, still
//                                 chunked) so App A can compute performance back to old trade dates.
//   { allIndexes?: boolean }    — expand the (non-custom) universe to all STATIC index members + monitored
//                                 (broad cross-index backfill; still capped by maxDailyTickers).
//   { flatFile?: boolean }      — source full history from Massive flat files (bulk per-day downloads) instead
//                                 of per-ticker REST calls — scales to a broad universe; per-ticker fallback
//                                 for any symbol the flat files miss. Best paired with fullHistory + allIndexes.
//   { fromAppANeeds?: boolean } — pull App A GET /api/export/price-needs and share those congressional
//                                 tickers (deep history when needsDeepHistory). Pair with fullHistory for a
//                                 one-shot performance backfill. Does NOT advance the daily marker.
// Otherwise shares the monitored universe union a page of App A price-needs (recent-capped except deep needs).
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (!congressTradeToken()) {
    return NextResponse.json(
      { ok: false, error: "CONGRESS_TRADE_TOKEN is not configured (server env)." },
      { status: 400 }
    );
  }

  let symbols: string[] | undefined;
  let fullHistory = false;
  let flatFile = false;
  let allIndexes = false;
  let fromAppANeeds = false;
  try {
    const body = (await request.json()) as {
      symbols?: unknown;
      fullHistory?: unknown;
      flatFile?: unknown;
      allIndexes?: unknown;
      fromAppANeeds?: unknown;
    };
    if (Array.isArray(body?.symbols)) {
      symbols = body.symbols.map((s) => String(s)).filter(Boolean);
    }
    fullHistory = body?.fullHistory === true;
    flatFile = body?.flatFile === true; // source full history from Massive flat files (bulk) vs per-ticker
    allIndexes = body?.allIndexes === true; // expand the universe to all static index members + monitored
    fromAppANeeds = body?.fromAppANeeds === true;
  } catch {
    // no body -> share the monitored universe
  }

  return withAdminOperationGuard(request, "congress-share", async (operationLeaseClaim) => {
    const summary = await runCongressDailyShare({
      now: Date.now(),
      force: true,
      symbols,
      fullHistory,
      flatFile,
      allIndexes,
      fromAppANeeds,
      operationLeaseClaim
    });
    const busy = getOperationLeaseBusy(summary);
    if (busy) return operationLeaseBusyResponse("congress-share", busy);
    return NextResponse.json({ autoEnabled: isCongressShareAutoEnabled(), ...summary });
  });
}
