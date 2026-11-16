// server-asof-filter backfill (2026-07-06): idempotently add the numeric `as_of_epoch_ms` metadata
// field to EXISTING Pinecone vectors, recomputing it from each vector's OWN date metadata
// (acceptance_datetime -> published_at -> as_of -> timestamp). Vectors that already have a finite
// epoch are skipped (idempotent — safe to re-run); genuinely-undated vectors are left absent (the
// fail-open signal the query path relies on). See docs/rollouts/2026-07-06-server-asof-filter.md.
//
// This is a thin operator entrypoint over `backfillAsOfEpoch` in src/lib/vector-db.ts — all the
// scan/fetch/update logic lives there (and is unit-tested); this file only loads env, parses a few
// operator knobs, and prints the result.
//
// No secrets live in this file — the Pinecone key is read from .env.local / the environment (the
// same resolution retrieval uses). Turning VECTOR_ASOF_SERVER_FILTER=on afterward is safe on the
// default (fail-open) semantics even before this completes; the backfill just makes the
// topK-fill improvement effective for older vectors too.
//
//   npx tsx scripts/backfill-asof-epoch.ts               (backfill for the "local"/operator key)
//   BACKFILL_DRY_RUN=1 npx tsx scripts/backfill-asof-epoch.ts   (report counts, issue no updates)
//   BACKFILL_USER=local BACKFILL_PREFIX=AAPL BACKFILL_BATCH=200 npx tsx scripts/backfill-asof-epoch.ts
import fs from "node:fs";
import path from "node:path";

// tsx does not auto-load .env.local; parse it into process.env (without clobbering already-set vars).
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { backfillAsOfEpoch } = await import("../src/lib/vector-db");

const userId = process.env.BACKFILL_USER || "local";
const dryRun = ["1", "true", "on", "yes"].includes(String(process.env.BACKFILL_DRY_RUN ?? "").trim().toLowerCase());
const prefix = process.env.BACKFILL_PREFIX || undefined;
const batchSize = Number(process.env.BACKFILL_BATCH || 100);

console.log(
  `[backfill-asof-epoch] starting${dryRun ? " (DRY RUN — no updates will be written)" : ""} ` +
    `userId=${userId}${prefix ? ` prefix=${prefix}` : ""} batchSize=${batchSize}`
);

const result = await backfillAsOfEpoch({
  userId,
  dryRun,
  prefix,
  batchSize: Number.isFinite(batchSize) ? batchSize : 100,
  onProgress: (p) =>
    console.log(
      `[backfill-asof-epoch] progress: scanned=${p.scanned} updated=${p.updated} ` +
        `skippedHasEpoch=${p.skippedHasEpoch} skippedUndated=${p.skippedUndated} errors=${p.errors}`
    )
});

console.log(`[backfill-asof-epoch] done: ${JSON.stringify(result)}`);
if (result.errors > 0) process.exitCode = 1;
