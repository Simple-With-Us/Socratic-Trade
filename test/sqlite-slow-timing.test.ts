import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { installSlowSqliteTiming } from "../src/lib/sqlite-slow-timing";

function open(opts: { thresholdMs: number }) {
  const lines: string[] = [];
  const db = new Database(":memory:");
  let clock = 0;
  // A function that advances the fake clock stands in for a slow native call.
  db.function("slow", (ms: unknown) => {
    clock += Number(ms);
    return 1;
  });
  installSlowSqliteTiming(db, {
    thresholdMs: opts.thresholdMs,
    warn: (l) => lines.push(l),
    walBytes: () => 4096,
    now: () => clock
  });
  return { db, lines, tick: (ms: number) => { clock += ms; } };
}

describe("installSlowSqliteTiming (ST-4542)", () => {
  it("logs a slow statement with sql text and wal size, never bind values", () => {
    const { db, lines } = open({ thresholdMs: 1000 });
    db.exec("CREATE TABLE t (id TEXT, v INTEGER)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run("secret-token-123", 1);
    const row = db.prepare("SELECT slow(?) AS s FROM t WHERE id = ?").get(2500, "secret-token-123") as { s: number };
    expect(row.s).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[slow-sqlite] get held the event loop 2500ms");
    expect(lines[0]).toContain("walBytes=4096");
    expect(lines[0]).toContain("SELECT slow(?) AS s FROM t WHERE id = ?");
    expect(lines[0]).not.toContain("secret-token-123");
  });

  it("stays silent under the threshold and leaves results and errors unchanged", () => {
    const { db, lines } = open({ thresholdMs: 1000 });
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    expect(insert.run("a").changes).toBe(1);
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "a" }]);
    expect(() => db.prepare("INSERT INTO nope VALUES (1)")).toThrow(/no such table/);
    expect(lines).toHaveLength(0);
  });

  it("times a whole transaction, including variants, and rethrows its error", () => {
    const { db, lines, tick } = open({ thresholdMs: 1000 });
    db.exec("CREATE TABLE t (v INTEGER)");
    const work = db.transaction((n: number) => {
      tick(1500);
      return db.prepare("INSERT INTO t VALUES (?)").run(n).changes;
    });
    expect(work(1)).toBe(1);
    expect(work.immediate(2)).toBe(1);
    expect(lines.some((l) => l.includes("transaction held"))).toBe(true);
    expect(lines.some((l) => l.includes("transaction.immediate held"))).toBe(true);
    const boom = db.transaction(() => {
      tick(1200);
      throw new Error("boom");
    });
    expect(() => boom()).toThrow("boom");
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
  });

  it("tells two anonymous inline transactions apart by their first SQL", () => {
    const { db, lines, tick } = open({ thresholdMs: 1000 });
    db.exec("CREATE TABLE a (v INTEGER); CREATE TABLE b (v INTEGER)");
    db.transaction(() => {
      db.prepare("INSERT INTO a VALUES (1)").run();
      tick(1500);
    })();
    db.transaction(() => {
      db.prepare("INSERT INTO b VALUES (1)").run();
      tick(1500);
    })();
    const tx = lines.filter((l) => l.includes("transaction held"));
    expect(tx).toHaveLength(2);
    expect(tx[0]).toContain("INSERT INTO a");
    expect(tx[1]).toContain("INSERT INTO b");
  });

  it("times the lazy next() steps of iterate(), and keeps iteration intact (ST-4542)", () => {
    const { db, lines } = open({ thresholdMs: 1000 });
    db.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1),(2),(3)");
    const seen: number[] = [];
    // slow() runs while SQLite steps the row, i.e. inside next(), not inside iterate().
    for (const row of db.prepare("SELECT v, slow(1500) AS s FROM t").iterate() as Iterable<{ v: number }>) {
      seen.push(row.v);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(lines.some((l) => /iterate\.next held the event loop \d{4,}ms/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("SELECT v, slow(1500) AS s FROM t"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[slow-sqlite] iterate held"))).toBe(false);
  });

  it("rate-limits repeats of the same statement", () => {
    const { db, lines, tick } = open({ thresholdMs: 1000 });
    const stmt = db.prepare("SELECT slow(?) AS s");
    stmt.get(1500);
    stmt.get(1500);
    expect(lines).toHaveLength(1);
    tick(11_000);
    stmt.get(1500);
    expect(lines).toHaveLength(2);
  });
});
