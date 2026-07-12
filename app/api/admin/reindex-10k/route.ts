import { NextResponse } from "next/server";
import { listIngestedAccessions } from "@/lib/db";
import { refreshFilingBodies } from "@/lib/web-sources/sec-filings";
import { getVectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

// Admin/operator route to trigger a full 10-K/10-Q backfill once a paid Voyage key is set.
// Admin-gated via the shared requireAdmin gate: verified ADMIN_USER_EMAILS / primary operator, OR a
// timing-safe x-admin-token match against ADMIN_REINDEX_TOKEN, OR non-production. (Previously a local
// `authorized()` helper compared the token with `===`; migrated to the shared, constant-time gate.)
// Returns { indexed, skipped, errors } so the operator can confirm a successful backfill.

export async function GET(request: Request) {
  // requireTokenInProd: in production the x-admin-token is mandatory — a synthetic/injected admin
  // email (app auth unconfigured) must not be able to trigger this paid Voyage backfill.
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const recent = listIngestedAccessions(50);
  const stats = await getVectorStoreStats();
  return NextResponse.json({ ok: true, ingestedAccessions: recent, vectorStore: stats });
}

export async function POST(request: Request) {
  // requireTokenInProd: in production the x-admin-token is mandatory — a synthetic/injected admin
  // email (app auth unconfigured) must not be able to trigger this paid Voyage backfill.
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  let symbols: string[] = [];
  let limit = Number.POSITIVE_INFINITY;
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

  const result = await refreshFilingBodies(symbols, Date.now(), limit);
  const stats = await getVectorStoreStats();
  return NextResponse.json({ ok: result.errors.length === 0, result, vectorStore: stats });
}
