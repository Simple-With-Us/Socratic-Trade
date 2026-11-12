import { NextResponse } from "next/server";
import { getEightKDataset, reindexEightKDataset } from "@/lib/web-sources/sec8k";
import { getVectorStoreStats } from "@/lib/vector-db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { enforceAdminIngestRateLimit } from "@/lib/admin-ingest-rate-limit";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import { getOperationLeaseBusy } from "@/lib/operation-lease";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";

export const dynamic = "force-dynamic";

// Admin/diagnostic route to (re)embed the persisted SEC 8-K dataset into Pinecone and report
// vector-store stats. This backfills the index after the Voyage-billing 429 that left it empty.
// Admin-gated via the shared requireAdmin gate. requireTokenInProd makes x-admin-token mandatory in
// production; the local fallback is excluded by provenance everywhere, and there is no environment bypass.
export async function GET(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const limited = enforceAdminIngestRateLimit(request, "reindex-8k", "read");
  if (limited) return limited;
  const dataset = getEightKDataset();
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const stats = await getVectorStoreStats(userId);
  return NextResponse.json({
    ok: true,
    datasetRecordCount: dataset?.recordCount ?? 0,
    datasetFetchedAt: dataset?.fetchedAt,
    vectorStore: stats
  });
}

export async function POST(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  let limit = Number.POSITIVE_INFINITY;
  try {
    const body = (await request.json()) as { limit?: number };
    if (body && Number.isFinite(Number(body.limit))) limit = Number(body.limit);
  } catch {
    // no body / not JSON -> reindex the whole dataset
  }
  return withAdminOperationGuard(request, "reindex-8k", async (operationLeaseClaim) => {
    // Charge the job budget only after the lease claim succeeds, so a 409 duplicate is free.
    const limited = enforceAdminIngestRateLimit(request, "reindex-8k", "job");
    if (limited) return limited;
    const before = await getVectorStoreStats(userId);
    const result = await reindexEightKDataset(userId, limit, operationLeaseClaim);
    const busy = getOperationLeaseBusy(result);
    if (busy) return operationLeaseBusyResponse("reindex-8k", busy);
    const after = await getVectorStoreStats(userId);
    return NextResponse.json({
      ok: !result.error,
      result,
      vectorStoreBefore: before,
      vectorStoreAfter: after
    });
  });
}
