import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyVersionedMigrations } from "../src/lib/db";

// ST-4635: usage-monitor replay pages rag_usage by (created_at, id).  Without an index that
// leads with created_at, prod scanned 1.37M rows and sorted them for every page (11.7-15.9s
// event-loop holds).  Migration 103 adds idx_rag_usage_created_id.
const CURSOR_PAGE =
  "SELECT id, created_at AS createdAt FROM rag_usage WHERE 1=1 AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT 1";
const WINDOW_LAST =
  "SELECT id, created_at AS createdAt FROM rag_usage WHERE created_at >= ? AND created_at < ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at DESC, id DESC LIMIT 1";

function plan(db: Database.Database, sql: string, params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(" | ");
}

describe("rag_usage cursor index (migration 103)", () => {
  it("turns the replay cursor scans into index seeks", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE rag_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        operation TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'voyage',
        model TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        batch_count INTEGER NOT NULL DEFAULT 1,
        cost_est_usd REAL,
        counts_toward_ingest INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_rag_usage_user ON rag_usage (user_id, created_at);
      CREATE INDEX idx_rag_usage_op ON rag_usage (operation, created_at);
    `);
    const cursor = ["2026-11-16T00:00:00.000Z", "2026-11-16T00:00:00.000Z", "id"];
    expect(plan(db, CURSOR_PAGE, cursor)).toMatch(/SCAN rag_usage/);

    db.pragma("user_version = 102");
    applyVersionedMigrations(db);

    expect(Number(db.pragma("user_version", { simple: true }))).toBeGreaterThanOrEqual(103);
    expect(plan(db, CURSOR_PAGE, cursor)).toMatch(/SEARCH rag_usage USING COVERING INDEX idx_rag_usage_created_id/);
    expect(plan(db, WINDOW_LAST, ["2026-11-15T00:00:00.000Z", "2026-11-17T00:00:00.000Z", ...cursor]))
      .toMatch(/SEARCH rag_usage USING COVERING INDEX idx_rag_usage_created_id/);
    db.close();
  });
});
