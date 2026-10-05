import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { z, ZodError } from "zod";
import { SQLITE_BUSY_PIN_MS } from "../src/lib/sqlite-event-loop";
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

describe("sqlite off-loop connection", () => {
  it("uses the serving busy pin and read pragmas", async () => {
    const busy = await sqliteAllOffLoop("PRAGMA busy_timeout", [], dbPath, z.object({ timeout: z.number() }));
    const cache = await sqliteAllOffLoop("PRAGMA cache_size", [], dbPath, z.object({ cache_size: z.number() }));
    const mmap = await sqliteAllOffLoop("PRAGMA mmap_size", [], dbPath, z.object({ mmap_size: z.number() }));
    expect(busy).toEqual([{ timeout: SQLITE_BUSY_PIN_MS }]);
    expect(cache).toEqual([{ cache_size: -20_000 }]);
    expect(mmap).toEqual([{ mmap_size: 268_435_456 }]);
    expect(SQLITE_BUSY_PIN_MS).toBe(100);
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

const SLOW_COUNT_SQL =
  "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i < ?) SELECT COUNT(*) AS c FROM r";

describe("sqlite off-loop timeout and abort", () => {
  it("terminates a wedged query so a later query can run on a fresh worker", async () => {
    const first = sqliteAllOffLoop(SLOW_COUNT_SQL, [8_000_000], dbPath, CountRowSchema, { timeoutMs: 200 });
    const second = sqliteAllOffLoop(SLOW_COUNT_SQL, [8_000_000], dbPath, CountRowSchema, { timeoutMs: 10_000 });
    const firstSettled = expect(first).rejects.toThrow("sqlite off-loop query timed out");
    const secondSettled = expect(second).rejects.toThrow("sqlite off-loop worker terminated after query timeout");
    await firstSettled;
    await secondSettled;

    // Overlaps the dying worker's exit when terminate waits out the native call.
    const rows = await sqliteAllOffLoop(SLOW_COUNT_SQL, [8_000_000], dbPath, CountRowSchema, { timeoutMs: 10_000 });
    expect(rows).toEqual([{ c: 8_000_000 }]);
  });

  it("rejects when the caller aborts and a later query still succeeds", async () => {
    const controller = new AbortController();
    const pending = sqliteAllOffLoop(SLOW_COUNT_SQL, [8_000_000], dbPath, CountRowSchema, {
      signal: controller.signal,
      timeoutMs: 10_000
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("lexical aborted"));
    await expect(pending).rejects.toThrow("lexical aborted");
    await resetSqliteAllOffLoopForTesting();
    const rows = await sqliteAllOffLoop("SELECT 1 AS c", [], dbPath, CountRowSchema);
    expect(rows).toEqual([{ c: 1 }]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    await expect(
      sqliteAllOffLoop("SELECT 1 AS c", [], dbPath, CountRowSchema, { signal: controller.signal })
    ).rejects.toThrow("already aborted");
  });
});

describe("serving retrieval path", () => {
  it("awaits searchCorpusWideLexicalCandidatesOffLoop instead of the sync FTS .all()", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/vector-db.ts"), "utf8");
    expect(src).toContain("searchCorpusWideLexicalCandidatesOffLoop");
    expect(src).not.toMatch(/lexicalCandidates = searchCorpusWideLexicalCandidates\(/);
  });
});
