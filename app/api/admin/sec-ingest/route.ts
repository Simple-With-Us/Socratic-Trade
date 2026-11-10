import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSecIngestJobReceipt, reconcileSecIngestJob, requeueSecIngestDeadLetters, type SecIngestJobReceipt } from "@/lib/db-rag-ingest";
import { seedSecIngestJobsFromManifest } from "@/lib/rag/sec-ingest-seeder";
import { padCik } from "@/lib/web-sources/sec-filings";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";

export const dynamic = "force-dynamic";

// Admin/operator route for the SEC ingest backfill (see docs/rollouts/2026-07-18-sec-ingest-worker-wiring.md):
//   GET  -> job/task receipt summary (checkpoint distribution, dead-letter counts, per-job status).
//   POST {action:"seed", offset?, limit?, ciks?} -> seeds jobs/tasks from the frozen universe
//     manifest (data/rag-universe-manifest.json) for SecIngestWorker to pick up. Idempotent: re-seeding
//     an already-sealed issuer job is a no-op (see sec-ingest-seeder.ts's dead-letter discipline).
// Admin-gated via the shared requireAdmin gate, same as app/api/admin/reindex-10k.

const JOB_TERMINAL_STATUSES = new Set(["complete", "complete_with_errors", "failed_terminal", "canceled"]);

export async function GET(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  const db = getDb();
  const jobRows = db.prepare("SELECT id FROM sec_ingest_jobs ORDER BY created_at ASC").all() as Array<{ id: string }>;

  const receipts: SecIngestJobReceipt[] = [];
  for (const row of jobRows) {
    // Reconcile-on-read: nothing else watches a running job's tasks all reaching a terminal status,
    // so this is where a finished job actually flips to complete/complete_with_errors.
    reconcileSecIngestJob(row.id);
    const receipt = getSecIngestJobReceipt(row.id);
    if (receipt) receipts.push(receipt);
  }

  const checkpointRows = db
    .prepare("SELECT checkpoint, COUNT(*) AS n FROM sec_ingest_tasks GROUP BY checkpoint")
    .all() as Array<{ checkpoint: string; n: number }>;
  const tasksByCheckpoint: Record<string, number> = {};
  for (const row of checkpointRows) tasksByCheckpoint[row.checkpoint] = row.n;

  const byJobStatus: Record<string, number> = {};
  let totalTasks = 0;
  let totalDeadLetterTasks = 0;
  let totalCompleteTasks = 0;
  for (const receipt of receipts) {
    byJobStatus[receipt.job.status] = (byJobStatus[receipt.job.status] ?? 0) + 1;
    totalTasks += receipt.totalTasks;
    totalDeadLetterTasks += receipt.byStatus.dead_letter;
    totalCompleteTasks += receipt.byStatus.complete;
  }
  const allTerminal = receipts.length > 0 && receipts.every((r) => JOB_TERMINAL_STATUSES.has(r.job.status));

  return NextResponse.json({
    ok: true,
    totalJobs: receipts.length,
    totalTasks,
    byJobStatus,
    tasksByCheckpoint,
    totalDeadLetterTasks,
    totalCompleteTasks,
    allTerminal,
    jobs: receipts.map((r) => ({
      jobId: r.job.id,
      status: r.job.status,
      corpusRevision: r.job.corpusRevision,
      universeSnapshotId: r.job.universeSnapshotId,
      totalTasks: r.totalTasks,
      byStatus: r.byStatus,
      updatedAt: r.job.updatedAt
    }))
  });
}

export async function POST(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  let action: string | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  let ciks: string[] = [];
  try {
    const body = (await request.json()) as { action?: string; offset?: number; limit?: number; ciks?: string[] };
    action = body?.action;
    if (Number.isFinite(Number(body?.offset))) offset = Number(body.offset);
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
    if (Array.isArray(body?.ciks)) {
      ciks = [...new Set(body.ciks.filter((c) => typeof c === "string" && c.length > 0).map((c) => padCik(c)))];
    }
  } catch {
    // no body / not JSON -> action stays undefined (will return error below)
  }

  if (action === "requeue-dead-letter") {
    // Recovery after an infra-level failure (EDGAR access block, since-fixed bug) buried healthy
    // tasks: fresh stage-attempt budget, reopens complete_with_errors jobs. Idempotent.
    try {
      const result = requeueSecIngestDeadLetters();
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (action !== "seed") {
    return NextResponse.json({ ok: false, error: 'Provide { action: "seed" | "requeue-dead-letter", offset?: number, limit?: number, ciks?: string[] } in the request body.' }, { status: 400 });
  }

  return withAdminOperationGuard(request, "sec-ingest-seed", async (claim) => {
    try {
      const result = await seedSecIngestJobsFromManifest({
        offset,
        limit,
        issuerCiks: ciks.length > 0 ? ciks : undefined,
        operationLeaseClaim: claim
      });
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  });
}
