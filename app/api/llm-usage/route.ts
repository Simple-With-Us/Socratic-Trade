import { NextResponse } from "next/server";
import { describeUsageKey, getLlmUsageSummary } from "@/lib/llm-usage";
import { llmOperatorFallbackEnabled } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get("sinceDays")) || 30;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  const rows = getLlmUsageSummary({ sinceIso, userId }).map((r) => {
    const key = describeUsageKey(r);
    return { ...r, keyLabel: key?.label ?? null, keyLast4: key?.last4 ?? null, keyMasked: key?.masked ?? null };
  });
  const serverFailoverRows = rows.filter((r) => r.keySource === "operator");

  return NextResponse.json({
    sinceDays,
    operatorFallbackEnabled: llmOperatorFallbackEnabled(),
    totalCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    operatorFundedCostUsd: serverFailoverRows.reduce((s, r) => s + r.costUsd, 0),
    operatorFundedTenants: serverFailoverRows.length > 0 ? [userId] : [],
    rows
  });
}
