import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { listAuditByKindsSince } from "@/lib/db";
import {
  aggregateRetrievalQuality,
  aggregateRetrievalStageTraces,
  type RetrievalQualityPayload,
  type RetrievalTraceSnapshot
} from "@/lib/rag/retrieval-telemetry-read";

export const dynamic = "force-dynamic";

// Admin/diagnostic route: an AGGREGATING READ over the retrieval stage telemetry (P1-4).
//
// `rag_retrieval_stage_trace` and `rag_retrieval_quality` are written default-on, and until now
// nothing in the repo could read them — the only reference to either kind was audit-prune.ts, which
// decides how long to KEEP them.  So a recall stage that silently returned nothing was invisible:
// the only symptom was a decision that looked inexplicable.  This route is that missing read.
//
// READ-ONLY by construction: one bounded SELECT over `audit_events`, no writes, no provider calls,
// no LLM.  It returns aggregates only — per-stage counts/durations/drop arithmetic and per-symbol
// rollups.  It never reconstructs a query and never echoes document text; the payloads carry only a
// short deterministic query digest (see retrieval-stage-telemetry.ts, which states outright that the
// digest "is a correlation key, not a security or authentication primitive").
//
// GET /api/admin/retrieval-telemetry?sinceDays=7&limit=2000
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sinceDays = Math.min(90, Math.max(1, Number(url.searchParams.get("sinceDays")) || 7));
  // Hard row cap so a wide window cannot turn a diagnostics page into an unbounded read. The
  // response reports `truncated` so a capped read is never mistaken for a complete one.
  const limit = Math.min(5000, Math.max(50, Number(url.searchParams.get("limit")) || 2000));
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  const rows = listAuditByKindsSince(
    ["rag_retrieval_stage_trace", "rag_retrieval_quality"],
    sinceIso,
    "local",
    limit
  );

  const traces: RetrievalTraceSnapshot[] = [];
  const quality: RetrievalQualityPayload[] = [];
  let firstTraceAt: string | null = null;
  let lastTraceAt: string | null = null;
  for (const row of rows) {
    if (row.kind === "rag_retrieval_stage_trace") {
      const payload = row.payload as RetrievalTraceSnapshot;
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.stages)) continue;
      traces.push(payload);
      // Rows arrive newest-first, so the first non-null is the newest and the last is the oldest.
      if (!lastTraceAt) lastTraceAt = row.createdAt;
      firstTraceAt = row.createdAt;
    } else if (row.kind === "rag_retrieval_quality") {
      const payload = row.payload as RetrievalQualityPayload;
      if (!payload || typeof payload !== "object") continue;
      quality.push(payload);
    }
  }

  const stageReport = aggregateRetrievalStageTraces(traces);
  const qualityReport = aggregateRetrievalQuality(quality);

  return NextResponse.json({
    sinceIso,
    sinceDays,
    rowsRead: rows.length,
    // An absent gate is "not dispatched yet", never "passed" — the same rule CI follows. Here it
    // means: a capped read is reported as capped, so an owner never reads a partial window as if it
    // were the whole window.
    truncated: rows.length >= limit,
    traces: traces.length,
    firstTraceAt,
    lastTraceAt,
    routes: stageReport.routes,
    stages: stageReport.stages,
    symbols: stageReport.symbols,
    quality: qualityReport,
    // Explicit "there is nothing to read" rather than an empty object that reads like success.
    // The distinction matters: no data can mean the telemetry was OFF for the whole window, which
    // is itself the thing an owner needs to know when a decision looks inexplicable.
    noData: rows.length === 0
  });
}
