import { NextResponse } from "next/server";
import { listIngestedAccessions } from "@/lib/db";
import { refreshFilingBodies } from "@/lib/web-sources/sec-filings";
import { getVectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import { getOperationLeaseBusy } from "@/lib/operation-lease";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";
import { normalizeSymbol } from "@/lib/money";

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
  let clearCache = false;
  try {
    const body = (await request.json()) as { symbols?: string[]; limit?: number; clearCache?: boolean; all?: boolean };
    const isAll = body?.all === true || (Array.isArray(body?.symbols) && body.symbols.includes("*"));
    if (isAll) {
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      const tickersSet = new Set<string>();
      const filingsRows = db.prepare("SELECT DISTINCT ticker FROM sec_filings").all() as { ticker: string }[];
      for (const r of filingsRows) if (r.ticker) tickersSet.add(r.ticker);
      const hasIngested = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ingested_accessions'").get();
      if (hasIngested) {
        const legacyRows = db.prepare("SELECT DISTINCT ticker FROM ingested_accessions").all() as { ticker: string }[];
        for (const r of legacyRows) if (r.ticker) tickersSet.add(r.ticker);
      }
      symbols = Array.from(tickersSet).map((s) => normalizeSymbol(s));
    } else if (Array.isArray(body?.symbols)) {
      symbols = [...new Set(body.symbols
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => normalizeSymbol(s)))];
    }
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
    if (body?.clearCache === true) clearCache = true;
  } catch {
    // no body / not JSON → empty symbols (will return error)
  }

  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: "Provide { symbols: string[], limit?: number, clearCache?: boolean } or { all: true } in the request body." }, { status: 400 });
  }

  return withAdminOperationGuard(request, "reindex-10k", async (operationLeaseClaim) => {
    if (clearCache) {
      const { getDb } = await import("@/lib/db");

      let accessionsToClear = new Set<string>();
      for (const symbol of symbols) {
        // Query ingested_accessions (legacy)
        const legacyRows = getDb().prepare(`
          SELECT accession FROM (
            SELECT accession FROM ingested_accessions WHERE ticker = ? AND doc_type = '10-K'
            ORDER BY indexed_at DESC LIMIT 10
          )
          UNION
          SELECT accession FROM (
            SELECT accession FROM ingested_accessions WHERE ticker = ? AND doc_type = '10-Q'
            ORDER BY indexed_at DESC LIMIT 10
          )
        `).all(symbol, symbol) as { accession: string }[];
        for (const r of legacyRows) accessionsToClear.add(r.accession);

        // Query sec_filings (new schema).
        // filed_at now preserves the original SEC filing date (see insertIngestedAccession
        // in db-learning.ts), so ORDER BY filed_at DESC picks the same recent-10-per-form
        // set that refreshFilingBodies will refetch from SEC Edgar.
        const filingRows = getDb().prepare(`
          SELECT accession FROM (
            SELECT accession FROM sec_filings WHERE ticker = ? AND form = '10-K'
            ORDER BY filed_at DESC LIMIT 10
          )
          UNION
          SELECT accession FROM (
            SELECT accession FROM sec_filings WHERE ticker = ? AND form = '10-Q'
            ORDER BY filed_at DESC LIMIT 10
          )
        `).all(symbol, symbol) as { accession: string }[];
        for (const r of filingRows) accessionsToClear.add(r.accession);
      }

      // If an explicit limit was provided, cap the cleared set so that we do not remove
      // filings that this run cannot rebuild (refreshFilingBodies stops at `limit` total).
      if (limit !== undefined && Number.isFinite(limit) && accessionsToClear.size > limit) {
        const trimmed = Array.from(accessionsToClear).slice(0, limit);
        accessionsToClear = new Set(trimmed);
      }

      if (accessionsToClear.size > 0) {
        const acns = Array.from(accessionsToClear);

        // Batch operations in groups of 50 to avoid SQLite's expression-depth limit
        // (~1000) when a broad reindex with many tickers generates hundreds of terms.
        const BATCH_SIZE = 50;

        // Delete from ingested_accessions
        for (let i = 0; i < acns.length; i += BATCH_SIZE) {
          const batch = acns.slice(i, i + BATCH_SIZE);
          const ph = batch.map(() => "?").join(",");
          getDb().prepare(
            `DELETE FROM ingested_accessions WHERE accession IN (${ph})`
          ).run(...batch);
        }

        // Delete from document_chunks using a chunk_id LIKE pattern for precise scoping
        for (let i = 0; i < acns.length; i += BATCH_SIZE) {
          const batch = acns.slice(i, i + BATCH_SIZE);
          const chunkQueries = batch.map(() => "chunk_id LIKE '%:' || ? || ':%'").join(" OR ");
          getDb().prepare(
            `DELETE FROM document_chunks WHERE content_hash IN (
              SELECT content_hash FROM document_chunks WHERE (${chunkQueries}) AND source = 'sec-edgar'
            )`
          ).run(...batch);
        }

        // Delete from chunk_occurrences (coverage helpers read this table and would
        // report stale data after a cache reset if rows were left behind)
        for (let i = 0; i < acns.length; i += BATCH_SIZE) {
          const batch = acns.slice(i, i + BATCH_SIZE);
          const ph = batch.map(() => "?").join(",");
          getDb().prepare(
            `DELETE FROM chunk_occurrences WHERE accession IN (${ph})`
          ).run(...batch);
        }

        // Update in sec_filings
        const now = new Date().toISOString();
        for (let i = 0; i < acns.length; i += BATCH_SIZE) {
          const batch = acns.slice(i, i + BATCH_SIZE);
          const ph = batch.map(() => "?").join(",");
          getDb().prepare(
            `UPDATE sec_filings SET status = 'discovered', updated_at = ? WHERE accession IN (${ph}) AND status = 'complete'`
          ).run(now, ...batch);
        }

        console.log(`[reindex-10k] Cleared local RAG metadata cache for ${acns.length} accession(s) across ${symbols.length} symbol(s): ${symbols.join(", ")}.`);
      } else {
        console.log(`[reindex-10k] No cached accessions found to clear for symbol(s): ${symbols.join(", ")}.`);
      }
    }

    // force: this is the operator explicitly asking for a backfill — it must not silently no-op
    // behind the scheduler's ingest TTL stamp (it did until 2026-07-09, returning {attempted: 0}
    // for up to a week after any scheduler attempt). An explicit `limit` also overrides the
    // free-tier 1-filing cap; omitted, the tier default applies (paid 25 / free 1).
    const result = await refreshFilingBodies(symbols, Date.now(), limit, { force: true, operationLeaseClaim });
    const busy = getOperationLeaseBusy(result);
    if (busy) return operationLeaseBusyResponse("reindex-10k", busy);
    const stats = await getVectorStoreStats();
    return NextResponse.json({ ok: result.errors.length === 0, result, vectorStore: stats, clearedCache: clearCache });
  });
}
