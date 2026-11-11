// ST-4602: DEFERRED read-then-write under WAL → SQLITE_BUSY_SNAPSHOT; BEGIN IMMEDIATE avoids it.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

function openWalDb(): { path: string; db1: Database.Database; db2: Database.Database } {
  const path = join(tmpdir(), `agentic-busy-snapshot-${randomUUID()}.db`);
  const db1 = new Database(path);
  const db2 = new Database(path);
  db1.pragma("journal_mode = WAL");
  db2.pragma("journal_mode = WAL");
  db1.exec("CREATE TABLE kv (k INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  db1.prepare("INSERT INTO kv (k, v) VALUES (1, 1)").run();
  return { path, db1, db2 };
}

describe("sqlite peer read — deferred vs immediate under WAL contention", () => {
  it("deferred read-then-write fails with SQLITE_BUSY when a peer commits between read and write", () => {
    const { db1, db2 } = openWalDb();
    try {
      const deferred = db1.transaction(() => {
        db1.prepare("SELECT v FROM kv WHERE k = 1").get();
        db2.prepare("UPDATE kv SET v = 2 WHERE k = 1").run();
        db1.prepare("INSERT INTO kv (k, v) VALUES (2, 9)").run();
      });
      expect(() => deferred()).toThrow(/database is locked/i);
    } finally {
      db1.close();
      db2.close();
    }
  });

  it("immediate read-then-write completes while a deferred upgrade would have failed", () => {
    const { db1, db2 } = openWalDb();
    try {
      db2.prepare("UPDATE kv SET v = 2 WHERE k = 1").run();
      const immediate = db1.transaction(() => {
        db1.prepare("SELECT v FROM kv WHERE k = 1").get();
        db1.prepare("INSERT INTO kv (k, v) VALUES (2, 9)").run();
      });
      expect(() => immediate.immediate()).not.toThrow();
      const rows = db1.prepare("SELECT k FROM kv ORDER BY k").all() as Array<{ k: number }>;
      expect(rows.map((row) => row.k)).toEqual([1, 2]);
    } finally {
      db1.close();
      db2.close();
    }
  });
});

describe("history-cache upsert transaction mode", () => {
  it("uses BEGIN IMMEDIATE for the EOD upsert transaction", async () => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-hc-immediate-${randomUUID()}.db`)}`;
    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "on";
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    const realTransaction = db.transaction.bind(db);
    const modes: string[] = [];
    const spy = vi.spyOn(db, "transaction").mockImplementation(((work: (...args: unknown[]) => unknown) => {
      const tx = realTransaction(work as never) as unknown as {
        (...args: unknown[]): unknown;
        immediate: (...args: unknown[]) => unknown;
      };
      const wrapped = ((...args: unknown[]) => {
        modes.push("deferred");
        return tx(...args);
      }) as unknown as Record<string, unknown>;
      wrapped.immediate = (...args: unknown[]) => {
        modes.push("immediate");
        return tx.immediate(...args);
      };
      return wrapped;
    }) as never);

    try {
      const { upsertHistoryCacheEod } = await import("../src/lib/history-cache");
      upsertHistoryCacheEod("TESTSYM", [
        { time: "2026-01-02", close: 10, open: 9, high: 11, low: 8, volume: 1000, source: "test" },
        { time: "2026-01-03", close: 11, open: 10, high: 12, low: 9, volume: 1100, source: "test" }
      ]);
      expect(modes).toEqual(["immediate"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("fetchDailyOHLC congress-read best-effort writes", () => {
  it("returns cached bars when fulfillMarketDataDemand is locked", async () => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-peer-ohlc-${randomUUID()}.db`)}`;
    process.env.MASSIVE_LOCAL_HISTORY_ENABLED = "on";
    const { latestCompletedTradingSessionEtKey } = await import("../src/lib/market-hours");
    const latest = latestCompletedTradingSessionEtKey(Date.now());
    const prior = new Date(Date.parse(`${latest}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

    const { upsertHistoryCacheEod } = await import("../src/lib/history-cache");
    upsertHistoryCacheEod("PEERBUSY", [
      { time: prior, close: 50, source: "test", fetchedAt: new Date().toISOString() },
      { time: latest, close: 51, source: "test", fetchedAt: new Date().toISOString() }
    ]);

    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const fulfillSpy = vi.spyOn(await import("../src/lib/db-settings"), "fulfillMarketDataDemand");

    try {
      fulfillSpy.mockImplementation(() => {
        throw busy;
      });

      const { fetchDailyOHLC } = await import("../src/lib/history");
      const bars = await fetchDailyOHLC("PEERBUSY", Date.now(), undefined, {
        skipAppATier: true,
        usageLabel: "congress-read"
      });
      expect(bars?.length).toBeGreaterThanOrEqual(2);
      expect(bars?.at(-1)?.close).toBe(51);
    } finally {
      fulfillSpy.mockRestore();
    }
  });
});

describe("peer read sqlite helpers", () => {
  it("isSqliteBusyErrorCode requires a sqlite busy/locked code", async () => {
    const { isSqliteBusyErrorCode } = await import("../src/lib/sqlite-peer-read");
    expect(isSqliteBusyErrorCode(new Error("database is locked"))).toBe(false);
    expect(isSqliteBusyErrorCode(Object.assign(new Error("x"), { code: "SQLITE_BUSY" }))).toBe(true);
    expect(isSqliteBusyErrorCode(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
  });

  it("peerReadRouteSqliteRetry yields and retries coded SQLITE_BUSY within the shared deadline", async () => {
    const busy = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    const { peerReadRouteSqliteRetry } = await import("../src/lib/sqlite-peer-read");
    let calls = 0;
    const result = await peerReadRouteSqliteRetry(async () => {
      calls += 1;
      if (calls < 2) throw busy;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("nested peerReadSqliteRetry shares one route deadline (no second 4s budget)", async () => {
    const busy = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    const { peerReadRouteSqliteRetry, peerReadSqliteRetry, PEER_READ_SQLITE_RETRY_BUDGET_MS } = await import(
      "../src/lib/sqlite-peer-read"
    );
    const started = Date.now();
    await expect(
      peerReadRouteSqliteRetry(async () => {
        await peerReadSqliteRetry(() => {
          throw busy;
        });
        await peerReadSqliteRetry(() => {
          throw busy;
        });
      })
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect(Date.now() - started).toBeLessThan(PEER_READ_SQLITE_RETRY_BUDGET_MS + 1500);
  });
});
