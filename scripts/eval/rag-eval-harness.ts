import { pathToFileURL } from "node:url";
import { getDb } from "../../src/lib/db";
import { retrieveContextDetailed } from "../../src/lib/vector-db";
import { resolveRetrievalAsOf } from "../../src/lib/rag/retrieval-asof";

interface GoldenSetItem {
  id: string;
  query: string;
  expected_cik: string;
  expected_accession: string;
  expected_text_snippet: string;
  category: string;
}

export async function runEvaluationHarness() {
  const db = getDb();
  const items = db.prepare("SELECT * FROM sec_eval_golden_set").all() as GoldenSetItem[];

  if (items.length === 0) {
    console.log("Evaluation golden set is empty. Insert records first.");
    return { recallAt10: 0, recallAt50: 0, ndcg: 0, count: 0, skipped: 0 };
  }

  let totalRecallAt10 = 0;
  let totalRecallAt50 = 0;
  let totalNdcg = 0;
  // Metrics must be divided by the number of queries that actually RAN. Rows whose CIK cannot be
  // resolved are skipped and reported separately — counting them in the denominator would deflate
  // global recall/nDCG while the report claims those queries were evaluated.
  let evaluated = 0;
  let skipped = 0;

  const categoryStats: Record<string, { count: number; recallAt10: number; recallAt50: number; ndcg: number }> = {};

  for (const item of items) {
    // Resolve symbol from CIK, check sec_filings first, fall back to sec_ingest_tasks
    let symbol: string | undefined;
    const filingRow = db.prepare("SELECT ticker FROM sec_filings WHERE cik = ? LIMIT 1").get(item.expected_cik) as any;
    if (filingRow?.ticker) {
      symbol = filingRow.ticker;
    } else {
      const taskRow = db.prepare("SELECT symbol FROM sec_ingest_tasks WHERE cik = ? LIMIT 1").get(item.expected_cik) as any;
      if (taskRow?.symbol) {
        symbol = taskRow.symbol;
      }
    }

    if (!symbol) {
      console.warn(`[rag-eval] No symbol found for CIK ${item.expected_cik} (${item.category}: "${item.query.slice(0, 60)}...") — skipping`);
      skipped++;
      continue;
    }
    evaluated++;

    // Production path only.  Search-fusion is research/eval-only and must not be the
    // merge-gate retriever — Green/Red/chat call retrieveContextDetailed.
    const results = await retrieveContextDetailed(item.query, symbol, 50, "local", {
      asOf: resolveRetrievalAsOf(),
      strictAsOf: true,
      applyDefaultFloors: true
    });

    let rank = -1;
    for (let i = 0; i < results.length; i++) {
      const chunk = results[i]!;
      const textMatches = chunk.text.toLowerCase().includes(item.expected_text_snippet.toLowerCase());
      const accession =
        (typeof chunk.metadata?.accession === "string" && chunk.metadata.accession) ||
        (chunk.id.includes(item.expected_accession) ? item.expected_accession : "");
      const accMatches = accession === item.expected_accession;
      if (textMatches && accMatches) {
        rank = i + 1; // 1-indexed rank
        break;
      }
    }

    const recallAt10 = rank > 0 && rank <= 10 ? 1 : 0;
    const recallAt50 = rank > 0 && rank <= 50 ? 1 : 0;
    const ndcg = rank > 0 ? 1 / Math.log2(rank + 1) : 0;

    totalRecallAt10 += recallAt10;
    totalRecallAt50 += recallAt50;
    totalNdcg += ndcg;

    if (!categoryStats[item.category]) {
      categoryStats[item.category] = { count: 0, recallAt10: 0, recallAt50: 0, ndcg: 0 };
    }
    const cat = categoryStats[item.category];
    cat.count++;
    cat.recallAt10 += recallAt10;
    cat.recallAt50 += recallAt50;
    cat.ndcg += ndcg;
  }

  const count = evaluated;
  const metrics = {
    recallAt10: count > 0 ? totalRecallAt10 / count : 0,
    recallAt50: count > 0 ? totalRecallAt50 / count : 0,
    ndcg: count > 0 ? totalNdcg / count : 0,
    count,
    skipped
  };

  console.log("\n================ RAG EVALUATION REPORT ================");
  console.log(`Evaluated ${count} of ${items.length} Golden Set queries (${skipped} skipped — unresolved CIK):\n`);
  console.log(`Global Recall@10: ${(metrics.recallAt10 * 100).toFixed(2)}%`);
  console.log(`Global Recall@50: ${(metrics.recallAt50 * 100).toFixed(2)}%`);
  console.log(`Global nDCG:      ${metrics.ndcg.toFixed(4)}\n`);

  console.log("Category Breakdown:");
  console.log("-------------------------------------------------------");
  console.log("Category        | Count | Recall@10 | Recall@50 | nDCG");
  console.log("-------------------------------------------------------");
  for (const [name, stats] of Object.entries(categoryStats)) {
    const c = stats.count;
    console.log(
      `${name.padEnd(15)} | ${String(c).padEnd(5)} | ${(stats.recallAt10 / c * 100).toFixed(1).padStart(8)}% | ${(stats.recallAt50 / c * 100).toFixed(1).padStart(8)}% | ${(stats.ndcg / c).toFixed(4).padStart(6)}`
    );
  }
  console.log("=======================================================\n");

  return metrics;
}

// ESM-safe direct-run guard: this repo is `type: module`, so `require` is undefined when the
// script runs under `tsx`/node as an ES module. Compare the module URL against the invoked
// script path instead; under vitest (which imports this module) argv[1] is the runner, not us.
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runEvaluationHarness().catch(err => {
    console.error("Evaluation harness failed:", err);
    process.exit(1);
  });
}
