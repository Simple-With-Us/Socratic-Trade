import { getConnectedAccount } from "@/lib/db";
import { getPerformanceSummary } from "@/lib/performance";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Performance summary for ONE connected account, for the Results-page comparison
// picker. The account is resolved by id SCOPED TO THE REQUESTING USER (mirrors
// [id]/route.ts's DELETE) — a client can never pick another user's account, and
// never supplies the accountNumber directly; it comes only from the server-side
// row. listConnectedAccounts/getConnectedAccount never include secrets, and this
// response only projects an explicit safe subset.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserId(req);
    const account = getConnectedAccount(id, userId);
    if (!account) return new NextResponse("Connected account not found.", { status: 404 });

    const performance = account.accountNumber ? getPerformanceSummary(account.accountNumber, {}, userId) : undefined;

    return NextResponse.json({
      account: {
        id: account.id,
        label: account.label,
        broker: account.broker,
        environment: account.environment
      },
      performance: performance ?? null,
      // This comparison-only endpoint deliberately never fetches live quotes (no
      // currentPrices are passed to getPerformanceSummary above), so whenever `performance`
      // is present its unrealized-P&L fields are NOT real numbers -- just the zero you get
      // from an empty currentPrices map. Flag it so the client renders unrealized as
      // unavailable ("-") instead of a fabricated $0.00 next to the active account's real
      // figure. Meaningless (and false) when there's no performance to mark.
      pricesUnavailable: Boolean(performance)
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
