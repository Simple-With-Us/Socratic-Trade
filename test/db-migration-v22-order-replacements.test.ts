// ST-4661: migration v22 rebuilds order_replacements to widen the status CHECK.
// The copy used to be INSERT ... SELECT *, which only works while the physical
// column order of the source table matches the rebuilt table exactly. A real
// pre-v22 database does NOT match: migration v20 appended symbol/side/
// original_type/original_quantity/original_filled_quantity at the END via
// ALTER TABLE, while the v22 target definition interleaves them after
// original_order_id. This fixture reproduces that physical order; with
// SELECT * every value from replacement_ref_id onward lands in the wrong
// column. The migration now names every target column explicitly.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RawDatabase from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", `file:${join(tmpdir(), `agentic-v22-rebuild-${randomUUID()}.db`)}`);

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("migration v22 order_replacements rebuild (ST-4661)", () => {
  it("copies every column by name from an ALTER-appended pre-v22 layout", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const d = new RawDatabase(":memory:");
    // Pre-v20 base shape, then the v20 ALTER-appended columns at the end --
    // the physical order a deployed v21 database actually has. Stamped at the
    // baseline version so the full migration chain runs (v20 finds the columns
    // already present and skips its ALTERs; later migrations assume tables the
    // earlier chain creates, so starting mid-chain at 21 is not a real shape).
    d.exec(`
      CREATE TABLE order_replacements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        original_order_id TEXT NOT NULL,
        replacement_ref_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('cancel_requested', 'cancel_confirmed', 'replacement_submitted', 'replacement_confirmed', 'failed', 'aborted')),
        remaining_quantity REAL,
        cancel_result TEXT,
        replacement_order_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        symbol TEXT,
        side TEXT,
        original_type TEXT,
        original_quantity REAL,
        original_filled_quantity REAL
      );
      PRAGMA user_version = 1;
    `);
    d.prepare(
      `INSERT INTO order_replacements
         (id, user_id, account_number, original_order_id, replacement_ref_id, status,
          remaining_quantity, cancel_result, replacement_order_id, error, created_at,
          updated_at, symbol, side, original_type, original_quantity, original_filled_quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "row-1", "user-1", "acct-1", "orig-1", "ref-1", "cancel_confirmed",
      9.25, "cancelled-ok", "repl-9", "sentinel-error", "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z", "ZZZT", "sell", "stop", 12.5, 3.25
    );

    // Control: prove the fixture really is in ALTER-appended (non-target) physical order,
    // so this test cannot drift into passing vacuously if the fixture shape changes.
    const physicalOrder = (d.prepare("PRAGMA table_info(order_replacements)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(physicalOrder.slice(-5)).toEqual([
      "symbol",
      "side",
      "original_type",
      "original_quantity",
      "original_filled_quantity"
    ]);
    expect(physicalOrder.indexOf("symbol")).toBeGreaterThan(physicalOrder.indexOf("updated_at"));

        applyVersionedMigrations(d);

    const row = d
      .prepare(
        `SELECT id, user_id, account_number, original_order_id, symbol, side, original_type,
                original_quantity, original_filled_quantity, replacement_ref_id, status,
                remaining_quantity, cancel_result, replacement_order_id, error, created_at, updated_at
         FROM order_replacements WHERE id = ?`
      )
      .get("row-1");
    expect(row).toEqual({
      id: "row-1",
      user_id: "user-1",
      account_number: "acct-1",
      original_order_id: "orig-1",
      symbol: "ZZZT",
      side: "sell",
      original_type: "stop",
      original_quantity: 12.5,
      original_filled_quantity: 3.25,
      replacement_ref_id: "ref-1",
      status: "cancel_confirmed",
      remaining_quantity: 9.25,
      cancel_result: "cancelled-ok",
      replacement_order_id: "repl-9",
      error: "sentinel-error",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z"
    });

    // The rebuilt table carries the widened CHECK from the v22 definition.
    expect(() =>
      d
        .prepare(
          `INSERT INTO order_replacements
             (id, user_id, account_number, original_order_id, replacement_ref_id, status, created_at, updated_at)
           VALUES ('row-2', 'user-1', 'acct-1', 'orig-2', 'ref-2', 'replacement_claiming', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`
        )
        .run()
    ).not.toThrow();
    d.close();
  });
});
