import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { resetSqliteAllOffLoopForTesting, sqliteAllOffLoop } from "../src/lib/rag/sqlite-all-offloop";

function countSql(iterations: number): string {
  return `WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i < ${iterations}) SELECT COUNT(*) AS c FROM r`;
}

let dbPath = "";

beforeAll(() => {
  dbPath = join(tmpdir(), `agentic-sqlite-all-offloop-${randomUUID()}.db`);
  const db = new Database(dbPath);
  db.close();
});

afterAll(async () => {
  await resetSqliteAllOffLoopForTesting();
});

describe("sqliteAllOffLoop", () => {
  it("lets timers run while a long sqlite statement executes", async () => {
    const syncDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    let iterations = 200_000;
    let sql = countSql(iterations);
    let syncMs = 0;
    let syncRow = { c: 0 };
    for (;;) {
      const started = Date.now();
      syncRow = syncDb.prepare(sql).get() as { c: number };
      syncMs = Date.now() - started;
      if (syncMs >= 40 || iterations >= 8_000_000) break;
      iterations *= 2;
      sql = countSql(iterations);
    }

    let syncTicks = 0;
    const syncTimer = setInterval(() => {
      syncTicks += 1;
    }, 5);
    syncDb.prepare(sql).get();
    clearInterval(syncTimer);
    syncDb.close();
    expect(syncRow.c).toBe(iterations);
    expect(syncMs).toBeGreaterThan(20);
    expect(syncTicks).toBe(0);

    let offloopTicks = 0;
    const offloopTimer = setInterval(() => {
      offloopTicks += 1;
    }, 5);
    try {
      const rows = await sqliteAllOffLoop<{ c: number }>(sql, [], dbPath);
      expect(rows[0]?.c).toBe(iterations);
      expect(offloopTicks).toBeGreaterThan(0);
    } finally {
      clearInterval(offloopTimer);
    }
  });
});

describe("serving retrieval path", () => {
  it("awaits searchCorpusWideLexicalCandidatesOffLoop instead of the sync FTS .all()", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/vector-db.ts"), "utf8");
    expect(src).toContain("searchCorpusWideLexicalCandidatesOffLoop");
    expect(src).not.toMatch(/lexicalCandidates = searchCorpusWideLexicalCandidates\(/);
  });
});
