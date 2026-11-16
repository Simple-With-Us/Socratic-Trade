import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-ledger-authority-${randomUUID()}.db`)}`;

// Regression suite for the 2026-07-15 production RAG outage: a deployment upgrading with
// pre-authority ("legacy_committed") chunk_occurrences rows could never mint its first managed
// vector ledger authority — managedVectorLedgerAuthority() counted those rows as blocking
// evidence and threw on EVERY retrieval and ingest, so no commit could ever record an authority.
// Legacy rows live in the provider's default namespace and carry no ledger_authority, so they
// must not block first-mint; managed-era evidence without a recoverable authority still must.

const MANAGED_VECTOR_LEDGER_SETTING = "vectorStore:managedLedgerAuthority";

let db: typeof import("../src/lib/db");
let vectorDb: typeof import("../src/lib/vector-db");

function insertOccurrence(receiptState: "legacy_committed" | "committed" | "pending"): void {
  db.getDb().prepare(`
    INSERT INTO chunk_occurrences (
      vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at,
      tenant_scope, content_version, commit_id, receipt_state, created_at
    ) VALUES (?, ?, 'AAPL', 'sec', 'acc-1', 'body', 0, ?, 'legacy', 'legacy', ?, ?, ?)
  `).run(
    `vec-${randomUUID()}`,
    `hash-${randomUUID()}`,
    new Date().toISOString(),
    receiptState === "legacy_committed" ? null : `commit-${randomUUID()}`,
    receiptState,
    new Date().toISOString()
  );
}

function clearLedgerState(): void {
  const database = db.getDb();
  database.prepare("DELETE FROM chunk_occurrences").run();
  database.prepare("DELETE FROM vector_ingest_commits").run();
  database.prepare("DELETE FROM vector_private_namespace_manifests").run();
  database.prepare("DELETE FROM settings WHERE key = ?").run(MANAGED_VECTOR_LEDGER_SETTING);
}

function storedAuthority(): string | undefined {
  const row = db.getDb().prepare("SELECT value FROM settings WHERE key = ?")
    .get(MANAGED_VECTOR_LEDGER_SETTING) as { value?: string } | undefined;
  return row?.value ? (JSON.parse(row.value) as string) : undefined;
}

beforeAll(async () => {
  db = await import("../src/lib/db");
  vectorDb = await import("../src/lib/vector-db");
});

afterEach(() => {
  clearLedgerState();
  vi.unstubAllEnvs();
});

describe("managedVectorLedgerAuthority legacy bootstrap", () => {
  it("mints a fresh authority on an empty ledger and keeps it stable", () => {
    const first = vectorDb.managedVectorLedgerAuthority();
    expect(first).toMatch(/^ledger:v1:/);
    expect(vectorDb.managedVectorLedgerAuthority()).toBe(first);
    expect(storedAuthority()).toBe(first);
  });

  it("mints on a legacy-only ledger (pre-authority chunk_occurrences rows) — 2026-07-15 outage regression", () => {
    insertOccurrence("legacy_committed");
    insertOccurrence("legacy_committed");
    // NODE_ENV=test masks throws with a sentinel; stub production to prove the real path mints.
    vi.stubEnv("NODE_ENV", "production");
    const authority = vectorDb.managedVectorLedgerAuthority();
    expect(authority).toMatch(/^ledger:v1:/);
    expect(authority).not.toBe("ledger:v1:test-only-authority");
    expect(storedAuthority()).toBe(authority);
  });

  it("still fails closed when managed-era occurrence evidence exists without any authority", () => {
    insertOccurrence("committed");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => vectorDb.managedVectorLedgerAuthority())
      .toThrow("Managed vector ledger authority is missing while vector evidence exists.");
    expect(storedAuthority()).toBeUndefined();
  });

  it("still fails closed when a commit row exists without any recorded authority", () => {
    db.getDb().prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key, content_version,
        parser_revision, embed_revision, expected_vectors, state, created_at, updated_at
      ) VALUES (?, 'shared', 'local', 'sec', 'acc-2', 'doc-2', 'v1', 'p1', 'e1', 1, 'pending', ?, ?)
    `).run(`commit-${randomUUID()}`, new Date().toISOString(), new Date().toISOString());
    vi.stubEnv("NODE_ENV", "production");
    expect(() => vectorDb.managedVectorLedgerAuthority())
      .toThrow("Managed vector ledger authority is missing while vector evidence exists.");
  });

  it("recovers the authority recorded on committed evidence instead of minting", () => {
    const recorded = `ledger:v1:${randomUUID()}`;
    db.getDb().prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key, content_version,
        parser_revision, embed_revision, expected_vectors, ledger_authority, state,
        created_at, updated_at
      ) VALUES (?, 'shared', 'local', 'sec', 'acc-3', 'doc-3', 'v1', 'p1', 'e1', 1, ?, 'committed', ?, ?)
    `).run(`commit-${randomUUID()}`, recorded, new Date().toISOString(), new Date().toISOString());
    vi.stubEnv("NODE_ENV", "production");
    expect(vectorDb.managedVectorLedgerAuthority()).toBe(recorded);
    expect(storedAuthority()).toBe(recorded);
  });

  it("legacy rows alongside recorded managed evidence do not disturb recovery", () => {
    const recorded = `ledger:v1:${randomUUID()}`;
    insertOccurrence("legacy_committed");
    db.getDb().prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key, content_version,
        parser_revision, embed_revision, expected_vectors, ledger_authority, state,
        created_at, updated_at
      ) VALUES (?, 'shared', 'local', 'sec', 'acc-4', 'doc-4', 'v1', 'p1', 'e1', 1, ?, 'committed', ?, ?)
    `).run(`commit-${randomUUID()}`, recorded, new Date().toISOString(), new Date().toISOString());
    vi.stubEnv("NODE_ENV", "production");
    expect(vectorDb.managedVectorLedgerAuthority()).toBe(recorded);
  });

  it("a persisted authority conflicting with recorded evidence still fails closed", () => {
    const now = new Date().toISOString();
    db.getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(MANAGED_VECTOR_LEDGER_SETTING, JSON.stringify(`ledger:v1:${randomUUID()}`), now);
    db.getDb().prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key, content_version,
        parser_revision, embed_revision, expected_vectors, ledger_authority, state,
        created_at, updated_at
      ) VALUES (?, 'shared', 'local', 'sec', 'acc-5', 'doc-5', 'v1', 'p1', 'e1', 1, ?, 'committed', ?, ?)
    `).run(`commit-${randomUUID()}`, `ledger:v1:${randomUUID()}`, now, now);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => vectorDb.managedVectorLedgerAuthority())
      .toThrow("Managed vector ledger authority conflicts with persisted vector evidence.");
  });
});
