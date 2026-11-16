#!/usr/bin/env node
// Dry-run (default) inventory of junk / raw-HTML / duplicate / low-value Pinecone vectors.
// Live delete requires --apply --confirm=prune-operational-junk.
// Never deletes experience-memory, lessons, or useful full-body only-copies.
// Does not charge Stripe. Does not flip RAG_PINECONE_WRITE_CLASS.

import { applyOperationalIndexPrune, PRUNE_CONFIRM_TOKEN } from "../src/lib/rag/operational-index-prune";
import { purgeVectorRecordIds } from "../src/lib/vector-db";

function arg(name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const confirm = arg("--confirm");
  const result = await applyOperationalIndexPrune({
    dryRun: !apply,
    confirm,
    deleteIds: async (ids) => {
      const purged = await purgeVectorRecordIds({ ids });
      return purged.deleted;
    }
  });
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    deleteCount: result.deleteIds.length,
    keepCount: result.keepIds.length,
    deleted: result.deleted,
    counts: result.counts,
    confirmRequired: apply ? PRUNE_CONFIRM_TOKEN : undefined
  }, null, 2));
  if (apply && confirm !== PRUNE_CONFIRM_TOKEN) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
