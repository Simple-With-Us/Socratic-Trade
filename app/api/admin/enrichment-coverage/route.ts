import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  listEnrichmentCoverageRunHistory,
  resolveEnrichmentCoverageReport
} from "@/lib/db-enrichment-coverage";

export const dynamic = "force-dynamic";

/**
 * Admin/diagnostic route: last market-enrichment cascade coverage report.
 *
 * Populated after any CascadingEnrichmentProvider.enrich() run (scan / strategy).
 * Shows per-field fill rates, winning sources (and most-frequent source), missing
 * fields, and provider failures — so the owner can see what free/keyless/RapidAPI
 * (and paid) sources actually delivered.
 *
 * GET /api/admin/enrichment-coverage
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const historyLimit = Number.parseInt(url.searchParams.get("historyLimit") ?? "20", 10);

  const report = resolveEnrichmentCoverageReport();
  if (!report) {
    return NextResponse.json({
      ok: true,
      available: false,
      message:
        "No enrichment coverage report yet. Run a Market Scan or strategy cycle first; the cascade persists field fill/source/missing summaries after each enrich run."
    });
  }

  const history = listEnrichmentCoverageRunHistory(
    Number.isFinite(historyLimit) ? historyLimit : 20
  );

  return NextResponse.json({
    ok: true,
    available: true,
    report,
    history
  });
}
