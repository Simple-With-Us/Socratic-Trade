import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { z, ZodError } from "zod";
import { RAG_QUERY_IO_DEADLINE_MS } from "../src/lib/rag-retrieval-deadline";
import { SQLITE_BUSY_PIN_MS } from "../src/lib/sqlite-event-loop";
import {
  activeSqliteOffLoopSlotCountForTesting,
  deliverSqliteOffLoopMessageForTesting,
  postSqliteOffLoopRawForTesting,
  primeSqliteOffLoopWaiterForTesting,
  resetSqliteAllOffLoopForTesting,
  setSqliteOffLoopStartedHookForTesting,
  SQLITE_OFF_LOOP_POOL_SIZE,
  SQLITE_OFF_LOOP_TIMEOUT_MS,
  SqliteRowSchema,
  SqliteValueSchema,
  SqliteWorkerResponseSchema,
  SqliteWorkerStartedSchema,
  sqliteAllOffLoop
} from "../src/lib/rag/sqlite-all-offloop";

const CountRowSchema = z.object({ c: z.number() });

const COUNT_SQL =
  "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i < ?) SELECT COUNT(*) AS c FROM r";

let dbPath = "";

/** Sync recursive-count size that runs at least `targetMs`, cached per target. */
const durationCache = new Map<number, number>();

function iterationsTakingAtLeast(targetMs: number): number {
  const cached = durationCache.get(targetMs);
  if (cached != null) return cached;
  const syncDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const count = syncDb.prepare(COUNT_SQL);
    let iterations = 100_000;
    let syncMs = 0;
    for (;;) {
      const started = Date.now();
      count.get(iterations);
      syncMs = Date.now() - started;
      if (syncMs >= targetMs || iterations >= 8_000_000) break;
      iterations *= 2;
    }
    if (syncMs < targetMs) {
      throw new Error(`sqlite statement did not reach ${targetMs}ms (last ${syncMs}ms at ${iterations})`);
    }
    durationCache.set(targetMs, iterations);
    return iterations;
  } finally {
    syncDb.close();
  }
}

beforeAll(() => {
  dbPath = join(tmpdir(), `agentic-sqlite-all-offloop-${randomUUID()}.db`);
  const db = new Database(dbPath);
  db.close();
});

afterAll(async () => {
  setSqliteOffLoopStartedHookForTesting(null);
  await resetSqliteAllOffLoopForTesting();
});

describe("sqliteAllOffLoop", () => {
  it("lets timers run while a long sqlite statement executes", async () => {
    const syncDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const count = syncDb.prepare(COUNT_SQL);
    let iterations = 200_000;
    let syncMs = 0;
    let syncRow = { c: 0 };
    for (;;) {
      const started = Date.now();
      syncRow = count.get(iterations) as { c: number };
      syncMs = Date.now() - started;
      if (syncMs >= 40 || iterations >= 8_000_000) break;
      iterations *= 2;
    }

    let syncTicks = 0;
    const syncTimer = setInterval(() => {
      syncTicks += 1;
    }, 5);
    count.get(iterations);
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
      const rows = await sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema);
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
    expect(SqliteWorkerStartedSchema.safeParse({ id: 1, started: true }).success).toBe(true);
    expect(SqliteWorkerResponseSchema.safeParse({ id: 1, started: true }).success).toBe(true);
    expect(SqliteWorkerStartedSchema.safeParse({ id: 1, started: true, ok: true }).success).toBe(false);
    expect(SqliteWorkerResponseSchema.safeParse({ id: 1, started: true, extra: true }).success).toBe(false);
    expect(SqliteValueSchema.safeParse(new Uint8Array([1, 2])).success).toBe(true);
    expect(SqliteValueSchema.safeParse(Buffer.from([1, 2])).success).toBe(true);
    expect(SqliteValueSchema.safeParse(1n).success).toBe(true);
    expect(SqliteValueSchema.safeParse(true).success).toBe(true);
    expect(SqliteValueSchema.safeParse(null).success).toBe(true);
    expect(SqliteRowSchema.safeParse({ c: { nested: true } }).success).toBe(false);
    expect(SqliteWorkerResponseSchema.safeParse({
      id: 1,
      ok: true,
      rows: [{ c: { nested: true } }]
    }).success).toBe(false);
  });

  it("rejects a forged row that contains a non-SQLite value", async () => {
    const waiter = await primeSqliteOffLoopWaiterForTesting();
    const settled = expect(waiter.done).rejects.toThrow("invalid sqlite worker response");
    await deliverSqliteOffLoopMessageForTesting({
      id: waiter.id,
      ok: true,
      rows: [{ c: { nested: true } }]
    });
    await settled;

    const rows = await sqliteAllOffLoop("SELECT 5 AS c", [], dbPath, CountRowSchema);
    expect(rows).toEqual([{ c: 5 }]);
  });

  it("round-trips a BLOB column as Uint8Array after worker structured clone", async () => {
    const blobPath = join(tmpdir(), `agentic-sqlite-all-offloop-blob-${randomUUID()}.db`);
    const payload = Uint8Array.from([0, 1, 2, 127, 128, 255, 10, 13]);
    const writer = new Database(blobPath);
    writer.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, payload BLOB)");
    writer.prepare("INSERT INTO docs (id, payload) VALUES (1, ?)").run(Buffer.from(payload));
    writer.prepare("INSERT INTO docs (id, payload) VALUES (2, ?)").run(Buffer.alloc(0));
    writer.prepare("INSERT INTO docs (id, payload) VALUES (3, NULL)").run();
    writer.close();

    const schema = z.object({
      id: z.number(),
      payload: z.instanceof(Uint8Array).nullable()
    });
    const rows = await sqliteAllOffLoop(
      "SELECT id, payload FROM docs ORDER BY id",
      [],
      blobPath,
      schema
    );
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(Buffer.isBuffer(rows[0]?.payload)).toBe(false);
    expect(rows[0]?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(rows[0]?.payload ?? [])).toEqual(Array.from(payload));
    expect(rows[1]?.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(rows[1]?.payload ?? [1])).toEqual([]);
    expect(rows[2]?.payload).toBeNull();
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

  it("does not settle a waiter on the start notification alone", async () => {
    const waiter = await primeSqliteOffLoopWaiterForTesting();
    let settled = false;
    void waiter.done.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await deliverSqliteOffLoopMessageForTesting({ id: waiter.id, started: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    await deliverSqliteOffLoopMessageForTesting({ id: waiter.id, ok: true, rows: [{ c: 7 }] });
    await expect(waiter.done).resolves.toEqual([{ c: 7 }]);
  });
});

describe("sqlite off-loop timeout and abort", () => {
  it("terminates a wedged query without failing a query on another instance", async () => {
    expect(SQLITE_OFF_LOOP_POOL_SIZE).toBe(2);
    const iterations = iterationsTakingAtLeast(300);
    const first = sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema, { timeoutMs: 80 });
    const second = sqliteAllOffLoop("SELECT 9 AS c", [], dbPath, CountRowSchema, { timeoutMs: 5_000 });
    const firstSettled = expect(first).rejects.toThrow("sqlite off-loop query timed out");
    const secondSettled = expect(second).resolves.toEqual([{ c: 9 }]);
    await firstSettled;
    await secondSettled;

    const rows = await sqliteAllOffLoop("SELECT 8 AS c", [], dbPath, CountRowSchema);
    expect(rows).toEqual([{ c: 8 }]);
  });

  it("does not time out a queued request for time spent waiting on a slow statement", async () => {
    const iterations = iterationsTakingAtLeast(300);
    const blockers = Array.from({ length: SQLITE_OFF_LOOP_POOL_SIZE }, () =>
      sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema, { timeoutMs: 5_000 })
    );
    const blockerDone = Promise.all(blockers);
    try {
      const timeoutMs = 40;
      const startedAt = Date.now();
      const rows = await sqliteAllOffLoop("SELECT 1 AS c", [], dbPath, CountRowSchema, { timeoutMs });
      const elapsed = Date.now() - startedAt;
      expect(rows).toEqual([{ c: 1 }]);
      // Wall time past the execution budget means the request was queued. The old
      // postMessage timer would have rejected it; the start-armed timer must not.
      expect(elapsed).toBeGreaterThan(timeoutMs);
    } finally {
      await blockerDone;
    }
  });

  it("re-dispatches a queued request when the statement ahead of it times out", async () => {
    const iterations = iterationsTakingAtLeast(300);
    const wedgeTimeoutMs = 80;
    const wedges = Array.from({ length: SQLITE_OFF_LOOP_POOL_SIZE }, () =>
      sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema, { timeoutMs: wedgeTimeoutMs })
    );
    const wedgeDone = Promise.allSettled(wedges);
    try {
      const startedAt = Date.now();
      const rows = await sqliteAllOffLoop("SELECT 6 AS c", [], dbPath, CountRowSchema, { timeoutMs: 5_000 });
      const elapsed = Date.now() - startedAt;
      expect(rows).toEqual([{ c: 6 }]);
      expect(elapsed).toBeGreaterThan(wedgeTimeoutMs / 2);
    } finally {
      const results = await wedgeDone;
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(String(result.reason instanceof Error ? result.reason.message : result.reason)).toMatch(
            /sqlite off-loop query timed out/
          );
        }
      }
    }
  });

  it("rejects a queued request when its signal aborts", async () => {
    const iterations = iterationsTakingAtLeast(300);
    const blockers = Array.from({ length: SQLITE_OFF_LOOP_POOL_SIZE }, () =>
      sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema, { timeoutMs: 5_000 })
    );
    const blockerDone = Promise.all(blockers);
    const controller = new AbortController();
    const queued = sqliteAllOffLoop("SELECT 1 AS c", [], dbPath, CountRowSchema, {
      signal: controller.signal,
      timeoutMs: 5_000
    });
    const queuedSettled = expect(queued).rejects.toThrow("queued lexical aborted");
    controller.abort(new Error("queued lexical aborted"));
    try {
      await queuedSettled;
    } finally {
      await blockerDone;
    }
  });

  it("rejects when the caller aborts and a later query still succeeds", async () => {
    const iterations = iterationsTakingAtLeast(300);
    const controller = new AbortController();
    const pendingQuery = sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema, {
      signal: controller.signal,
      timeoutMs: 5_000
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("lexical aborted"));
    await expect(pendingQuery).rejects.toThrow("lexical aborted");
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

  it("keeps the execution budget strictly inside the caller abort deadline", () => {
    // Production callers omit timeoutMs, so SQLITE_OFF_LOOP_TIMEOUT_MS is the budget
    // armed when the worker reports started. createRagQueryAbort uses the full deadline.
    expect(SQLITE_OFF_LOOP_TIMEOUT_MS).toBeLessThan(RAG_QUERY_IO_DEADLINE_MS);
    expect(SQLITE_OFF_LOOP_TIMEOUT_MS).toBe(Math.floor(RAG_QUERY_IO_DEADLINE_MS / 2));
  });

  it("retires a started slot when the caller aborts before the execution timer", async () => {
    await resetSqliteAllOffLoopForTesting();
    const minMs = 600;
    const iterations = iterationsTakingAtLeast(minMs);
    let startedCount = 0;
    const bothStarted = new Promise<void>((resolve) => {
      setSqliteOffLoopStartedHookForTesting(() => {
        startedCount += 1;
        if (startedCount >= SQLITE_OFF_LOOP_POOL_SIZE) resolve();
      });
    });
    const controllers = Array.from({ length: SQLITE_OFF_LOOP_POOL_SIZE }, () => new AbortController());
    const wedges = controllers.map((controller) =>
      sqliteAllOffLoop(COUNT_SQL, [iterations], dbPath, CountRowSchema, {
        signal: controller.signal,
        // Far past the abort, so reclaim cannot be the execution timer.
        timeoutMs: 30_000
      })
    );
    const wedgeSettled = wedges.map((wedge) => expect(wedge).rejects.toThrow("lexical aborted"));
    try {
      await bothStarted;
      for (const controller of controllers) controller.abort(new Error("lexical aborted"));
      // killSlot removes the slot before abort() returns. A later query cannot
      // sit on either wedged worker.
      expect(activeSqliteOffLoopSlotCountForTesting()).toBe(0);
      await Promise.all(wedgeSettled);

      const startedAt = Date.now();
      const rows = await sqliteAllOffLoop("SELECT 4 AS c", [], dbPath, CountRowSchema, { timeoutMs: 5_000 });
      expect(rows).toEqual([{ c: 4 }]);
      expect(Date.now() - startedAt).toBeLessThan(minMs / 2);
    } finally {
      setSqliteOffLoopStartedHookForTesting(null);
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
