import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { buildCatalogPayload, buildDataCompletenessReport } from "@/lib/data-completeness";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/data-catalog
 * Static field→sources inventory + live completeness (numerical + RAG non-numeric).
 * Optional ?symbols=AAPL,MSFT to pin universe; otherwise store+filings-derived.
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const symbolsParam = url.searchParams.get("symbols");
  const explicit = symbolsParam
    ? symbolsParam.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    : undefined;

  const catalog = buildCatalogPayload();
  let completeness: ReturnType<typeof buildDataCompletenessReport> | null = null;
  let completenessError: string | null = null;
  try {
    completeness = buildDataCompletenessReport(explicit);
  } catch (err) {
    completenessError = err instanceof Error ? err.message : "completeness failed";
  }

  return NextResponse.json({
    ok: true,
    catalog,
    completeness,
    completenessError,
    llmNote:
      "Yes — per-ticker RAG is presented to the LLM, but only as retrieved snippets in retrievedFinancialContext (deep for top-3+held, scout for other candidates), not the full corpus. Structured scan fields are separate compact keys; missing values are omitted."
  });
}
