import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const POLICY_MODULES = [
  "src/lib/sqlite-storage-hygiene.ts",
  "src/lib/audit-prune.ts",
  "src/lib/db-task-journal.ts",
  "src/lib/db-fills.ts",
  "src/lib/db-embed-stage.ts",
  "src/lib/db-economic-events.ts",
  "src/lib/headline-first-seen.ts",
  "src/lib/db-health.ts"
] as const;

const AGE_PREDICATES = [
  /created_at\s*<\s*\?/,
  /started_at\s*<\s*\?/,
  /last_seen\s*<\s*\?/,
  /event_date\s*<\s*\?/,
  /\bts\s*<\s*\?/
];

function deleteStatements(source: string): string[] {
  const matches: string[] = [];
  const re = /DELETE\s+FROM[\s\S]*?;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

/** embed_stage may DELETE by key after Pinecone delivery — not TTL. */
function isAllowedEmbedStageDelete(stmt: string): boolean {
  if (!stmt.includes("embed_stage")) return false;
  if (stmt.includes("content_hash = ?") && stmt.includes("model = ?")) return true;
  if (stmt.includes("content_hash IN")) return true;
  return false;
}

describe("forever retention — no age-based DELETE in policy modules", () => {
  for (const rel of POLICY_MODULES) {
    it(`${rel} has no TTL DELETE SQL`, () => {
      const source = readFileSync(join(ROOT, rel), "utf8");
      const deletes = deleteStatements(source);
      for (const stmt of deletes) {
        if (rel.endsWith("db-embed-stage.ts") && isAllowedEmbedStageDelete(stmt)) continue;
        if (rel.endsWith("db-health.ts") && stmt.includes("settings")) continue;
        for (const pattern of AGE_PREDICATES) {
          expect(stmt).not.toMatch(pattern);
        }
      }
    });
  }

  it("audit-prune.ts contains no DELETE FROM at all", () => {
    const source = readFileSync(join(ROOT, "src/lib/audit-prune.ts"), "utf8");
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("db-health.ts never trims api_health_log (no cap DELETE)", () => {
    const source = readFileSync(join(ROOT, "src/lib/db-health.ts"), "utf8");
    expect(source).not.toMatch(/\bDELETE\s+FROM\s+api_health_log\b/i);
    expect(source).not.toMatch(/deleteCap|HEALTH_LOG_LANE_CAP\s*-\s*\d/);
  });
});
