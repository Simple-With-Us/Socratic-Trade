/**
 * Strategy (Bull/Bear) offline eval runner — Chat A item 2. Mirrors scripts/eval/run-offline.ts but
 * is 100% DETERMINISTIC: it never calls an LLM or a provider. It scores the fixed fixtures in
 * strategy-dataset.ts against the three hard money-path invariants (no off-universe opens; every
 * short carries a stop; no buy contradicts structured evidence). Every scorer here is safety-critical,
 * so ANY failing case fails the run.
 *
 * Run:  npm run eval:strategy-offline
 * Exit: 0 = all cases pass, 1 = an invariant was violated, 2 = crash.
 */
import { STRATEGY_DATASET } from "./strategy-dataset";
import { scoreStrategyCase } from "./strategy-score";

function main(): void {
  const results = STRATEGY_DATASET.map(scoreStrategyCase);
  let allPass = true;

  console.log("Strategy offline eval — deterministic Bull/Bear money-path invariants\n");
  for (const r of results) {
    console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.id}  (score ${r.score.toFixed(2)})`);
    for (const s of r.scorers) {
      if (!s.result.pass) console.log(`    ✗ ${s.name}: ${s.result.detail}`);
    }
    if (!r.pass) allPass = false;
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} cases passed.`);

  if (!allPass) {
    console.error("STRATEGY EVAL FAILED — a money-path invariant was violated.");
    process.exit(1);
  }
  console.log("PASS");
}

try {
  main();
} catch (err) {
  console.error("STRATEGY EVAL CRASHED:", err);
  process.exit(2);
}
