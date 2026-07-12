import { NextResponse } from "next/server";
import { getEightKDataset, reindexEightKDataset } from "@/lib/web-sources/sec8k";
import { getVectorStoreStats } from "@/lib/vector-db";
import { resolveRequestUserId } from "@/lib/request-user";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

// Admin/diagnostic route to (re)embed the persisted SEC 8-K dataset into Pinecone and report
// vector-store stats. This backfills the index after the Voyage-billing 429 that left it empty.
// Admin-gated via the shared requireAdmin gate. requireTokenInProd: in production the x-admin-token
// is mandatory (a synthetic/injected admin email from an auth-unconfigured deploy must not trigger a
// paid Voyage reindex); non-production stays open for dev/ops ergonomics.
export async function GET(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const dataset = getEightKDataset();
  const stats = await getVectorStoreStats(resolveRequestUserId(request));
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
  const userId = resolveRequestUserId(request);
  let limit = Number.POSITIVE_INFINITY;
  try {
    const body = (await request.json()) as { limit?: number };
    if (body && Number.isFinite(Number(body.limit))) limit = Number(body.limit);
  } catch {
    // no body / not JSON → reindex the whole dataset
  }
  const before = await getVectorStoreStats(userId);
  const result = await reindexEightKDataset(userId, limit);
  const after = await getVectorStoreStats(userId);
  return NextResponse.json({
    ok: !result.error,
    result,
    vectorStoreBefore: before,
    vectorStoreAfter: after
  });
}
