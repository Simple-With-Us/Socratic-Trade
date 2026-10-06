// One-off cascade audit: enrich a few symbols with the current provider registration and
// print which provider won each field + which fields nothing filled. Run:
//   source ~/.secrets/global-api-keys.env && DATABASE_URL=file:/tmp/cascade-audit.db npx tsx scripts/cascade-audit.ts
import { getEnrichmentProvider } from "../src/lib/data-providers";
import { resolveEnrichmentCoverageReport } from "../src/lib/db-enrichment-coverage";

async function main() {
  const provider = getEnrichmentProvider("local");
  console.log("cascade:", provider.name);
  const symbols = ["AAPL", "MSFT", "JNJ"];
  const result = await provider.enrich(symbols);
  for (const sym of symbols) {
    const e = result[sym] ?? {};
    console.log(`\n=== ${sym} ===`);
    const sourced = (e as { sourcedFields?: Record<string, { source?: string }> }).sourcedFields ?? {};
    for (const [k, v] of Object.entries(e)) {
      if (k === "sourcedFields" || k === "headlines") continue;
      const src = (sourced as Record<string, { source?: string }>)[k]?.source ?? "?";
      console.log(`  ${k} = ${JSON.stringify(v)}  [${src}]`);
    }
  }
  const report = resolveEnrichmentCoverageReport();
  if (report) {
    console.log("\n=== coverage report ===");
    console.log(JSON.stringify(report, null, 1));
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/cascade-report.json", JSON.stringify(report));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
