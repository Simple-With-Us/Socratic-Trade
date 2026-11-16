import fs from "node:fs";
import path from "node:path";
import { blockingUniverseValidationIssues, validateSecUniverseManifest } from "../../src/lib/rag/universe-manifest";

const manifestPath = path.resolve(process.argv[2] ?? "data/rag-universe-manifest.json");
const raw = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw) as unknown;
const allIssues = validateSecUniverseManifest(manifest);
const warnings = allIssues.filter((issue) => issue.severity === "warning");
const issues = blockingUniverseValidationIssues(allIssues);

for (const warning of warnings) {
  console.warn(`⚠ ${warning.code} ${warning.path}: ${warning.message}`);
}

if (issues.length === 0) {
  console.log(`SEC/RAG universe acceptance: PASS (${manifestPath})${warnings.length > 0 ? ` — ${warnings.length} warning(s)` : ""}`);
} else {
  console.error(`SEC/RAG universe acceptance: FAIL (${issues.length} issue(s), ${manifestPath})`);
  for (const issue of issues.slice(0, 100)) {
    console.error(`- ${issue.code} ${issue.path}: ${issue.message}`);
  }
  if (issues.length > 100) console.error(`- ... ${issues.length - 100} additional issue(s)`);
  process.exitCode = 1;
}
