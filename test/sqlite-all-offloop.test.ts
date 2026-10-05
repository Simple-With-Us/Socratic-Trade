import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { z, ZodError } from "zod";
import {
  deliverSqliteOffLoopMessageForTesting,
  postSqliteOffLoopRawForTesting,
  primeSqliteOffLoopWaiterForTesting,
  resetSqliteAllOffLoopForTesting,
  SqliteWorkerResponseSchema,
  sqliteAllOffLoop
} from "../src/lib/rag/sqlite-all-offloop";

const CountRowSchema = z.object({ c: z.number() });

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
      const rows = await sqliteAllOffLoop(sql, [], dbPath, CountRowSchema);
      expect(rows[0]?.c).toBe(iterations);
      expect(offloopTicks).toBeGreaterThan(0);
    } finally {
      clearInterval(offloopTimer);
    }
  });
});

describe("sqlite off-loop validation", () => {
  it("rejects a row that does not match the row schema", async () => {
    const schema = z.object({ c: z.string() });
    await expect(sqliteAllOffLoop("SELECT 1 AS c", [], dbPath, schema)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects a sqlite statement failure without dropping the worker", async () => {
    await expect(
      sqliteAllOffLoop("SELECT * FROM definitely_missing", [], dbPath, z.object({ x: z.number() }))
    ).rejects.toThrow(/no such table/i);
    const rows = await sqliteAllOffLoop("SELECT 2 AS c", [], dbPath, CountRowSchema);
    expect(rows).toEqual([{ c: 2 }]);
  });

  it("parses only a strict worker response", () => {
    expect(SqliteWorkerResponseSchema.safeParse({ id: 1, ok: true, rows: [{ c: 1 }] }).success).toBe(true);
    expect(SqliteWorkerResponseSchema.safeParse({
      id: 1,
      ok: false,
      error: { message: "database is locked", code: "SQLITE_BUSY" }
    }).success).toBe(true);
    expect(SqliteWorkerResponseSchema.safeParse({ id: 1, ok: true, rows: [], extra: true }).success).toBe(false);
    expect(SqliteWorkerResponseSchema.safeParse({
      id: 1,
      ok: false,
      error: { message: "x", code: "E", extra: 1 }
    }).success).toBe(false);
    expect(SqliteWorkerResponseSchema.safeParse({ id: 1.5, ok: true, rows: [] }).success).toBe(false);
  });

  it("rejects an invalid worker request and uses -1 when the id is not a safe integer", async () => {
    const emptyPath = await postSqliteOffLoopRawForTesting({
      id: 2_000_000_001,
      dbPath: "",
      sql: "SELECT 1",
      params: []
    });
    expect(emptyPath).toEqual({
      id: 2_000_000_001,
      ok: false,
      error: { message: "invalid sqlite worker request", code: "INVALID_REQUEST" }
    });

    const nameless = await postSqliteOffLoopRawForTesting({ hello: "nope" });
    expect(nameless).toEqual({
      id: -1,
      ok: false,
      error: { message: "invalid sqlite worker request", code: "INVALID_REQUEST" }
    });

    const rows = await sqliteAllOffLoop("SELECT 3 AS c", [], dbPath, CountRowSchema);
    expect(rows).toEqual([{ c: 3 }]);
  });

  it("rejects only the waiter whose response fails validation", async () => {
    const bad = await primeSqliteOffLoopWaiterForTesting();
    const other = await primeSqliteOffLoopWaiterForTesting();
    const badSettled = expect(bad.done).rejects.toThrow("invalid sqlite worker response");
    const otherSettled = expect(other.done).resolves.toEqual([{ c: 4 }]);

    await deliverSqliteOffLoopMessageForTesting({ ok: true, rows: [] });
    await deliverSqliteOffLoopMessageForTesting({
      id: -1,
      ok: false,
      error: { message: "invalid sqlite worker request", code: "INVALID_REQUEST" }
    });
    await deliverSqliteOffLoopMessageForTesting({ id: bad.id, ok: true, rows: "not-an-array" });
    await deliverSqliteOffLoopMessageForTesting({ id: other.id, ok: true, rows: [{ c: 4 }] });

    await badSettled;
    await otherSettled;
  });
});

describe("serving retrieval path", () => {
  it("awaits searchCorpusWideLexicalCandidatesOffLoop instead of the sync FTS .all()", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/vector-db.ts"), "utf8");
    expect(src).toContain("searchCorpusWideLexicalCandidatesOffLoop");
    expect(src).not.toMatch(/lexicalCandidates = searchCorpusWideLexicalCandidates\(/);
  });
});
