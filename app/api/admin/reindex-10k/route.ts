import { NextResponse } from "next/server";
import { listIngestedAccessions } from "@/lib/db";
import { refreshFilingBodies } from "@/lib/web-sources/sec-filings";
import { getVectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import { getOperationLeaseBusy } from "@/lib/operation-lease";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";

export const dynamic = "force-dynamic";

// Admin/operator route to trigger a full 10-K/10-Q backfill once a paid Voyage key is set.
// Admin-gated via the shared requireAdmin gate: a middleware-verified primary/allowlisted admin email,
// or a timing-safe x-admin-token match against ADMIN_REINDEX_TOKEN; there is no environment bypass. (A local
// `authorized()` helper compared the token with `===`; migrated to the shared, constant-time gate.)
// Returns { indexed, skipped, errors } so the operator can confirm a successful backfill.

export async function GET(request: Request) {
  // requireTokenInProd: in production the x-admin-token is mandatory. The local fallback is already
  // excluded by provenance, and this stronger gate also rejects a genuinely verified email alone.
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const recent = listIngestedAccessions(50);
  const stats = await getVectorStoreStats();
  return NextResponse.json({ ok: true, ingestedAccessions: recent, vectorStore: stats });
}

export async function POST(request: Request) {
  // requireTokenInProd: in production the x-admin-token is mandatory. The local fallback is already
  // excluded by provenance, and this stronger gate also rejects a genuinely verified email alone.
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  let symbols: string[] = [];
  let limit: number | undefined;
  try {
    const body = (await request.json()) as { symbols?: string[]; limit?: number };
    if (Array.isArray(body?.symbols)) symbols = body.symbols.filter((s) => typeof s === "string" && s.length > 0);
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
  } catch {
    // no body / not JSON → empty symbols (will return error)
  }

  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: "Provide { symbols: string[], limit?: number } in the request body." }, { status: 400 });
  }

  return withAdminOperationGuard(request, "reindex-10k", async (operationLeaseClaim) => {
    // force: this is the operator explicitly asking for a backfill — it must not silently no-op
    // behind the scheduler's ingest TTL stamp (it did until 2026-07-09, returning {attempted: 0}
    // for up to a week after any scheduler attempt). An explicit `limit` also overrides the
    // free-tier 1-filing cap; omitted, the tier default applies (paid 25 / free 1).
    const result = await refreshFilingBodies(symbols, Date.now(), limit, { force: true, operationLeaseClaim });
    const busy = getOperationLeaseBusy(result);
    if (busy) return operationLeaseBusyResponse("reindex-10k", busy);
    const stats = await getVectorStoreStats();
    return NextResponse.json({ ok: result.errors.length === 0, result, vectorStore: stats });
  });
}
