import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getLastEnrichmentCoverageReport } from "@/lib/enrichment-coverage";

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

  const report = getLastEnrichmentCoverageReport();
  if (!report) {
    return NextResponse.json({
      ok: true,
      available: false,
      message:
        "No enrichment coverage report yet. Run a Market Scan or strategy cycle first; the cascade stores the latest field fill/source/missing summary in memory."
    });
  }

  return NextResponse.json({
    ok: true,
    available: true,
    report
  });
}
