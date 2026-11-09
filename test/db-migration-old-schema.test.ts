// Regression for the 2026-07-02 production boot crash ("no such column: client_turn_id",
// Sentry issue a595484d8c4b4f02ad5e9d27ace6eb16): PR #333 added client_turn_id to chat_turns
// via a versioned migration but ALSO added the column + idx_chat_turns_user_client to the
// BASELINE DDL in migrate(). The baseline exec runs before applyVersionedMigrations, so on a
// pre-existing DB the CREATE TABLE was a no-op and the baseline CREATE INDEX referenced a
// column that did not exist yet — getDb() threw during instrumentation load on every boot.
// CI never caught it because CI starts from a fresh DB, where the baseline CREATE TABLE
// includes the column. This test boots getDb() against a simulated PRE-#333 database.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dbPath = join(tmpdir(), `agentic-old-schema-migration-${randomUUID()}.db`);

beforeAll(() => {
  // Recreate the exact chat_turns shape a pre-#333 deployment had on disk
  // (model exists — added by the earlier chat_turns_model migration — but
  // client_turn_id does not).
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE chat_turns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL,
      citations TEXT NOT NULL DEFAULT '[]',
      intent TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_chat_turns_user ON chat_turns (user_id, created_at);

    -- Pre-managed-commit shape: the table already exists, but migration-era columns such as
    -- lease_expires_at do not. Baseline DDL must not create an index on those columns before the
    -- ordered migrations have a chance to add them.
    CREATE TABLE vector_ingest_commits (
      id TEXT PRIMARY KEY,
      tenant_scope TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL,
      accession TEXT NOT NULL,
      content_version TEXT NOT NULL,
      parser_revision TEXT NOT NULL,
      embed_revision TEXT NOT NULL,
      expected_vectors INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_at TEXT
    );

    -- ST-4540: pre-delivery-receipt embed_stage. The baseline DDL is a no-op for this table, so a
    -- baseline "CREATE INDEX ... ON embed_stage (delivered_at)" would abort every boot with
    -- "no such column: delivered_at" — same failure mode as the chat_turns crash above.
    CREATE TABLE embed_stage (
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      revision TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      chunk_id TEXT NOT NULL DEFAULT '',
      user_scope TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, model, revision)
    );
    CREATE INDEX idx_embed_stage_created ON embed_stage (created_at);
  `);
  raw
    .prepare(
      "INSERT INTO chat_turns (id, user_id, role, text, created_at) VALUES (?, ?, 'user', 'pre-migration turn', ?)"
    )
    .run(randomUUID(), "legacy-user", new Date().toISOString());
  raw
    .prepare(
      "INSERT INTO embed_stage (content_hash, model, revision, dims, vector, created_at) VALUES (?, ?, ?, 1, ?, ?)"
    )
    .run("legacy-stage", "m", "1", Buffer.from([1, 2, 3, 4]), new Date().toISOString());
  raw.close();
  process.env.DATABASE_URL = `file:${dbPath}`;
});

describe("migrating a pre-existing (pre-#333) database", () => {
  it("getDb() boots without throwing and versioned migrations add client_turn_id + its index", async () => {
    const { getDb } = await import("../src/lib/db");
    // The crash was thrown from right here (baseline CREATE INDEX on a missing column).
    const db = getDb();

    const cols = (db.prepare("PRAGMA table_info(chat_turns)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(cols).toContain("client_turn_id");

    const indexes = (db.prepare("PRAGMA index_list(chat_turns)").all() as Array<{ name: string }>).map(
      (i) => i.name
    );
    expect(indexes).toContain("idx_chat_turns_user_client");

    const vectorCols = (db.prepare("PRAGMA table_info(vector_ingest_commits)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(vectorCols).toEqual(expect.arrayContaining([
      "document_key",
      "retrieval_metadata_version",
      "attempt_token",
      "lease_expires_at",
      "provider_authority",
      "ledger_authority",
      "vector_namespace"
    ]));

    // Pre-existing rows survive the migration untouched.
    const legacy = db
      .prepare("SELECT text, client_turn_id FROM chat_turns WHERE user_id = ?")
      .get("legacy-user") as { text: string; client_turn_id: string | null };
    expect(legacy.text).toBe("pre-migration turn");
    expect(legacy.client_turn_id).toBeNull();

    // ST-4540: the delivery/quarantine columns are added, the delivered index is created only
    // AFTER they exist, and pre-migration rows default to "never proven delivered" — the
    // conservative reading that keeps them out of every deleter.
    const stageCols = (db.prepare("PRAGMA table_info(embed_stage)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(stageCols).toEqual(
      expect.arrayContaining(["delivered_at", "delivered_store", "quarantined_at", "quarantine_reason"])
    );
    const stageIndexes = (db.prepare("PRAGMA index_list(embed_stage)").all() as Array<{ name: string }>).map(
      (i) => i.name
    );
    expect(stageIndexes).toContain("idx_embed_stage_delivered");
    const legacyStage = db
      .prepare("SELECT delivered_at, quarantined_at FROM embed_stage WHERE content_hash = ?")
      .get("legacy-stage") as { delivered_at: string | null; quarantined_at: string | null };
    expect(legacyStage.delivered_at).toBeNull();
    expect(legacyStage.quarantined_at).toBeNull();
  });
});
