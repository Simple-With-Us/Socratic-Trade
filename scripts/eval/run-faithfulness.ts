/**
 * Faithfulness / citation-grounding eval runner (R11, 2026-07-01 RAG backlog).
 *
 * Runs the deterministic scorer over test/fixtures/rag-faithfulness-fixture.ts and prints a
 * citation-support rate + unsupported-claim count. No network, no API keys required.
 *
 * OPTIONAL LLM judge (opt-in, adds holistic scoring on top of the deterministic floor):
 *   RAG_EVAL_FAITHFULNESS_JUDGE=on OPENAI_API_KEY=sk-... npm run eval:faithfulness
 *
 * This script is NOT part of the required `verify` CI gate (tsc/test/build) — it's a manual/
 * scheduled diagnostic. The deterministic checks it wraps ARE covered by
 * test/rag-faithfulness-eval.test.ts, which DOES run in `npm test`.
 */
import { RAG_FAITHFULNESS_FIXTURE } from "../../test/fixtures/rag-faithfulness-fixture";
import { faithfulnessJudgeEnabled, judgeFaithfulness, scoreFaithfulness, summarizeFaithfulness } from "./faithfulness";

async function main(): Promise<void> {
  console.log(`\n▶ Faithfulness eval  cases=${RAG_FAITHFULNESS_FIXTURE.length}`);
  console.log(`  llm judge: ${faithfulnessJudgeEnabled() ? "YES (opt-in)" : "no (deterministic only)"}\n`);

  const results = RAG_FAITHFULNESS_FIXTURE.map(scoreFaithfulness);
  const summary = summarizeFaithfulness(results);

  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    console.log(`  ${icon} ${r.caseId}`);
    if (!r.citationsGrounded) {
      console.log(`      unsupported citations: ${r.unsupportedCitations.join(", ")}`);
    }
    if (!r.numericClaimsSupported) {
      console.log(`      unsupported numeric claims: ${r.unsupportedNumericClaims.join(", ")}`);
    }
  }

  if (faithfulnessJudgeEnabled()) {
    console.log("\n── LLM judge pass ──────────────────────────────────────\n");
    for (const evalCase of RAG_FAITHFULNESS_FIXTURE) {
      const judged = await judgeFaithfulness(evalCase);
      console.log(`  [${judged.pass ? "PASS" : "FAIL"}] ${judged.detail}`);
    }
  }

  console.log(
    `\n══ Summary  citationSupportRate=${(summary.citationSupportRate * 100).toFixed(1)}%  ` +
    `unsupportedClaims=${summary.unsupportedClaimCount}  pass=${summary.passCount}/${summary.total} ══\n`
  );

  // This is a diagnostic script, not a CI gate — always exit 0. A future workstream can promote
  // it to a hard gate once the fixture set and threshold are calibrated against a real corpus.
}

main().catch((e) => {
  console.error("Faithfulness eval runner crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
