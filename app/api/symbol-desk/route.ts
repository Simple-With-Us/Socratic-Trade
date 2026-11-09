import { NextResponse } from "next/server";
import {
  getActiveConnectedAccount,
  getPolicy,
  getStopPlans,
  getTakeProfitTrimBands,
  listConnectedAccounts,
  listPendingProposals,
  listPortfolioSnapshots,
  listSocraticDecisionCases
} from "@/lib/db";
import { resolveRequestUser } from "@/lib/request-user";
import { enforceRateLimit } from "@/lib/rate-limit";
import { buildSymbolDesk } from "@/lib/symbol-desk";
import { normalizeSymbol } from "@/lib/money";

export const dynamic = "force-dynamic";

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbol") ?? "";
  const symbol = normalizeSymbol(raw);
  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "invalid or missing symbol" }, { status: 400 });
  }

  const { userId } = resolveRequestUser(request);
  const limited = enforceRateLimit(userId, "symbol-desk", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const policy = getPolicy(userId);
  const active = getActiveConnectedAccount(userId);
  const currentAccountNumber = (policy.accountNumber ?? active?.accountNumber ?? "").trim();
  const accounts = listConnectedAccounts(userId);
  const rawPlans = currentAccountNumber ? getStopPlans(currentAccountNumber, userId) : {};
  const trims = currentAccountNumber ? getTakeProfitTrimBands(currentAccountNumber, userId) : {};
  const pending = currentAccountNumber ? listPendingProposals(currentAccountNumber, userId) : [];
  const cases = listSocraticDecisionCases(userId, {
    limit: 40,
    ...(active?.id ? { connectedAccountId: active.id } : {})
  });

  const desk = buildSymbolDesk({
    symbol,
    currentAccountNumber,
    accounts,
    latestPositions: (accountNumber) => {
      const snaps = listPortfolioSnapshots(accountNumber, undefined, 1, userId);
      const latest = snaps.at(-1);
      if (!latest) return undefined;
      return { positions: latest.positions, recordedAt: latest.createdAt };
    },
    stopPlan: rawPlans[symbol],
    trim: trims[symbol],
    pending,
    cases
  });

  return NextResponse.json(desk);
}
