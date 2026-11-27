// ST-4682 (OD-6, owner 2026-11-24 ~11:26 PM CT): bounded, resumable backfill for the managed
// embedding representation bump. ST-4664 gave every storeDocument filing/transcript chunk a
// structured `[TICKER | FORM PERIOD | SECTION]` header in its embeddingText; ST-4682 stamped the
// managed class with MANAGED_CONTEXT_EMBED_REV = 4 so already-committed headerless vectors stop
// being reused without a re-embed. This script is the OPERATOR ENTRY POINT for draining the
// stale corpus: DRY-RUN by default (local-DB census only, zero network), `--execute` runs bounded
// re-embed slices through the EXISTING embed path (corpus-reembed -> storeDocument/storeContexts,
// so every ledger receipt, daily budget fuse and batch-pacing rule applies — no second write path).
//
// Unlike the older scripts in this directory, this one intentionally does NOT read .env.local
// (strict-Infisical repo policy, 2026-09-18): run it inside the app's secret context (e.g.
// `node scripts/infisical-run.mjs -- npx tsx scripts/backfill-embed-rev.ts ...`) and pass the
// database explicitly.
//
// `src/lib/db.ts` imports `server-only`, whose exports map resolves to an empty module ONLY under
// the react-server condition (same requirement as scripts/eval/rag-production-eval.ts — see
// scripts/eval/golden/rag-production-golden-v1.json). Invoke as:
//
//   NODE_OPTIONS="--conditions react-server" npx tsx scripts/backfill-embed-rev.ts --db <path-to-app.db>
//       DRY RUN: per-(collection, source) stale counts + estimated embedding calls/tokens.
//   NODE_OPTIONS="--conditions react-server" npx tsx scripts/backfill-embed-rev.ts --db <path> --execute
//       Bounded execute: slices until budgets/watermark say stop. Resumable — the settings-table
//       watermark (`embedRevBackfill:progress`) tracks lifetime totals per target revision.
//
// Env knobs (all optional; the DRY RUN prints the effective values):
//   BACKFILL_EMBED_REV_MAX_ROWS        max stale rows this invocation may consume (default 5000)
//   BACKFILL_EMBED_REV_MAX_TOKENS      max estimated embedding tokens this invocation (default 2000000)
//   BACKFILL_EMBED_REV_MAX_ERRORS      hard stop after this many failed candidates per invocation (default 5)
//   BACKFILL_EMBED_REV_BATCH_DOCS      candidates per slice handed to the embed path (default 100)
//   BACKFILL_EMBED_REV_TOKENS_PER_ROW  token estimate per stale chunk (default 600)
//   BACKFILL_EMBED_REV_USER            userId (default "local")
//   BACKFILL_EMBED_REV_COVER           extra source tags the runner covers (CSV, e.g. "insider-filing")
//
// Guards: refuses without --db (no default database path); refuses --execute on a Pinecone write
// backend (the retired Pinecone-only lane must never be touched); never reads or writes secrets.
// The LIVE re-embed run against production data is a separate off-hours operator step (ST-4675
// daily-embed-cap raise first) — running this script with --execute against a live DB spends real
// embedding budget and is gated on that coordination.
import fs from "node:fs";
import path from "node:path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const args = process.argv.slice(2);
let dbPath: string | undefined;
let execute = false;
let help = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--db") dbPath = args[++i];
  else if (arg?.startsWith("--db=")) dbPath = arg.slice("--db=".length);
  else if (arg === "--execute") execute = true;
  else if (arg === "--help" || arg === "-h") help = true;
  else {
    console.error(`[backfill-embed-rev] unknown argument: ${arg}`);
    process.exit(2);
  }
}
if (help) {
  console.log("usage: npx tsx scripts/backfill-embed-rev.ts --db <app.db> [--execute] (see header comment for env knobs)");
  process.exit(0);
}
if (!dbPath) {
  console.error("[backfill-embed-rev] REFUSED: an explicit --db <path> is required (no default database path).");
  process.exit(2);
}
const resolvedDb = path.resolve(dbPath);
if (!fs.existsSync(resolvedDb)) {
  console.error(`[backfill-embed-rev] REFUSED: database file not found: ${resolvedDb}`);
  process.exit(2);
}
// Point the app's db module at the operator-named file BEFORE any src/lib import resolves getDb().
process.env.DATABASE_URL = `file:${resolvedDb}`;

const userId = process.env.BACKFILL_EMBED_REV_USER?.trim() || "local";
const coveredExtra = (process.env.BACKFILL_EMBED_REV_COVER ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const { planEmbedRevBackfill, runEmbedRevBackfill, defaultEmbedRevBudget } =
  await import("../src/lib/rag/embed-rev-backfill");
const { vectorWriteBackendOrNull } = await import("../src/lib/vector-store/qdrant-write");

const backend = vectorWriteBackendOrNull();
if (execute && backend !== "qdrant") {
  console.error(
    `[backfill-embed-rev] REFUSED: --execute requires the Qdrant write backend (detected: ${backend ?? "qdrant-misconfigured"}). ` +
      "The retired Pinecone-only lane must never be touched."
  );
  process.exit(2);
}

const budget = {
  ...defaultEmbedRevBudget(),
  maxRows: envInt("BACKFILL_EMBED_REV_MAX_ROWS", defaultEmbedRevBudget().maxRows),
  maxEstimatedTokens: envInt("BACKFILL_EMBED_REV_MAX_TOKENS", defaultEmbedRevBudget().maxEstimatedTokens),
  maxEmbedErrors: envInt("BACKFILL_EMBED_REV_MAX_ERRORS", defaultEmbedRevBudget().maxEmbedErrors),
  batchDocs: envInt("BACKFILL_EMBED_REV_BATCH_DOCS", defaultEmbedRevBudget().batchDocs)
};

console.log(
  `[backfill-embed-rev] ${execute ? "EXECUTE (bounded, resumable)" : "DRY RUN (no writes, no network)"} ` +
    `db=${resolvedDb} user=${userId} backend=${backend ?? "qdrant-misconfigured"}`
);
console.log(
  `[backfill-embed-rev] budgets: maxRows=${budget.maxRows} maxEstimatedTokens=${budget.maxEstimatedTokens} ` +
    `maxErrors=${budget.maxEmbedErrors} batchDocs=${budget.batchDocs}`
);

function printPlan(plan: Awaited<ReturnType<typeof planEmbedRevBackfill>>): void {
  console.log(
    `[backfill-embed-rev] target managed embed revision = ${plan.targetEmbedRevision} ` +
      `(rev ${plan.targetRev}, model ${plan.embedModel})`
  );
  if (plan.collections.length === 0) {
    console.log("[backfill-embed-rev] no committed vector_ingest_commits rows found.");
    return;
  }
  console.log("[backfill-embed-rev] collection           | source                  | commits stale/total | rows stale/total | runner");
  for (const c of plan.collections) {
    const key = `${c.vectorNamespace.padEnd(20)}| ${c.source.padEnd(22)}| ${(String(c.staleCommits) + "/" + c.totalCommits).padEnd(19)}| ${(String(c.staleRows) + "/" + c.totalRows).padEnd(17)}| ${c.runnerCovers ? "re-embeds" : "live-touch only"}`;
    console.log(`[backfill-embed-rev] ${key}`);
  }
  console.log(
    `[backfill-embed-rev] totals: staleCommits=${plan.staleCommits} staleRows=${plan.staleRows} ` +
      `(coverable=${plan.coverableStaleRows}, live-touch-only=${plan.uncoverableStaleRows})`
  );
  console.log(
    `[backfill-embed-rev] estimate: embeddingInputs=${plan.estimatedEmbedCalls} ` +
      `estimatedTokens=${plan.estimatedTokens} (${plan.tokensPerRow}/row)`
  );
}

const outcome = await runEmbedRevBackfill({
  execute,
  userId,
  budget,
  planOptions: { coveredSources: coveredExtra },
  runner: execute
    ? async (maxDocs) => {
        const { runCorpusReembedAwaited } = await import("../src/lib/rag/corpus-reembed");
        const out = await runCorpusReembedAwaited({ userId, maxTexts: maxDocs });
        if (!out.acquired || !out.result) return null;
        const result = out.result;
        const embedded = result.docTypes.reduce((s, d) => s + d.embedded, 0);
        const reused = result.docTypes.reduce((s, d) => s + d.reusedInSpace, 0);
        const failed = result.docTypes.reduce((s, d) => s + d.failed, 0);
        const completed = result.docTypes.length > 0 && result.docTypes.every((d) => d.completed);
        return {
          embedded,
          reused,
          failed,
          completed,
          stoppedForBudget: result.stoppedForBudget || result.stoppedForCap
        };
      }
    : async () => null
});

printPlan(outcome.finalPlan);
if (outcome.watermark) {
  console.log(`[backfill-embed-rev] watermark: ${JSON.stringify(outcome.watermark)}`);
}
console.log(
  `[backfill-embed-rev] ${execute ? "execute" : "dry-run"} finished: reason=${outcome.reason} ` +
    `slices=${outcome.slices} embedded=${outcome.embedded} reused=${outcome.reused} failed=${outcome.failed} ` +
    `rowsConsumed=${outcome.rowsConsumed} estTokensConsumed=${outcome.estimatedTokensConsumed} ` +
    `remainingCoverableStaleRows=${outcome.finalPlan.coverableStaleRows}`
);
if (execute && outcome.reason !== "exhausted") process.exitCode = 1;
