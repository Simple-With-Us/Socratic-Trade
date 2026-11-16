import { NextResponse } from "next/server";
import { describeUsageKey, getLlmUsageSummary } from "@/lib/llm-usage";
import { llmOperatorFallbackEnabled } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

// Admin/diagnostic route: per-user LLM usage + cost, grouped by (user, provider, key source).
// This is the visibility that gates the operator-funded LLM failover — `operatorFunded` isolates
// spend where a NON-`local` tenant used the operator's env key.
//
// Query params:
//   sinceDays         Window in days (default 30)
//   operatorFundedOnly  "true" → only rows where a non-local tenant spent the operator key
//   accountId         Filter to a single connected account
//   broker            Filter to a broker (alpaca | robinhood | ...) via the connected_accounts join
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get("sinceDays")) || 30;
  const operatorFundedOnly = url.searchParams.get("operatorFundedOnly") === "true";
  const connectedAccountId = url.searchParams.get("accountId") || undefined;
  const broker = url.searchParams.get("broker") || undefined;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  // Enrich each per-key row with a human-readable label + masked key resolved from the live key
  // store — so the per-key view isn't just an opaque fingerprint. Null when the key is detached.
  const rows = getLlmUsageSummary({ sinceIso, operatorFundedOnly, connectedAccountId, broker }).map((r) => {
    const key = describeUsageKey(r);
    return { ...r, keyLabel: key?.label ?? null, keyFingerprint: key?.fingerprint ?? null };
  });
  const operatorFunded = rows.filter((r) => r.keySource === "operator" && r.userId !== "local");

  return NextResponse.json({
    sinceDays,
    operatorFallbackEnabled: llmOperatorFallbackEnabled(),
    totalCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    // Cost provenance split — see the same fields on /api/llm-usage.  Billed is the transport's own
    // `usage.cost`; estimated comes from the price table and must be labelled as an estimate.
    billedCostUsd: rows.reduce((s, r) => s + r.billedCostUsd, 0),
    estimatedCostUsd: rows.reduce((s, r) => s + r.estimatedCostUsd, 0),
    operatorFundedCostUsd: operatorFunded.reduce((s, r) => s + r.costUsd, 0),
    operatorFundedTenants: Array.from(new Set(operatorFunded.map((r) => r.userId))),
    rows
  });
}
