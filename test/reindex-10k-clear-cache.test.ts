import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `reindex-10k-clear-cache-${randomUUID()}.db`)}`;
});

async function load() {
  const db = await import("../src/lib/db");
  const route = await import("../app/api/admin/reindex-10k/route");
  return { db, route };
}

function authenticatedAdminRequest(body: string): Request {
  return new Request("https://socratictrade.com/api/admin/reindex-10k", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });
}

describe("reindex-10k clearCache behavior", () => {
  beforeEach(async () => {
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    const { db } = await load();
    db.getDb().prepare("DELETE FROM ingested_accessions").run();
    db.getDb().prepare("DELETE FROM sec_filings").run();
    db.getDb().prepare("DELETE FROM document_chunks").run();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears only the latest 10 accessions per form type and preserves older ones", async () => {
    const { db, route } = await load();
    const ticker = "AAPL";

    // Insert 12 completed 10-K filings into ingested_accessions and sec_filings
    for (let i = 1; i <= 12; i++) {
      const accession = `acc-10k-${i.toString().padStart(3, "0")}`;
      const filedAt = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(); // i days ago (older files first/larger i is older)
      
      db.getDb().prepare(
        "INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count) VALUES (?, ?, ?, ?, ?)"
      ).run(accession, "10-K", ticker, filedAt, 5);

      db.getDb().prepare(`
        INSERT INTO sec_filings (accession, CIK, ticker, form, filed_at, accepted_at, status, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'complete', 5, ?, ?)
      `).run(accession, "0000320193", ticker, "10-K", filedAt, filedAt, filedAt, filedAt);

      // Insert matching document chunks
      db.getDb().prepare(
        "INSERT INTO document_chunks (content_hash, symbol, source, chunk_id, created_at) VALUES (?, ?, 'sec-edgar', ?, ?)"
      ).run(`hash-10k-${i}`, ticker, `${ticker}:${accession}:10-K#c001`, filedAt);
    }

    // Insert 12 completed 10-Q filings into ingested_accessions and sec_filings
    for (let i = 1; i <= 12; i++) {
      const accession = `acc-10q-${i.toString().padStart(3, "0")}`;
      const filedAt = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString();
      
      db.getDb().prepare(
        "INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count) VALUES (?, ?, ?, ?, ?)"
      ).run(accession, "10-Q", ticker, filedAt, 5);

      db.getDb().prepare(`
        INSERT INTO sec_filings (accession, CIK, ticker, form, filed_at, accepted_at, status, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'complete', 5, ?, ?)
      `).run(accession, "0000320193", ticker, "10-Q", filedAt, filedAt, filedAt, filedAt);

      // Insert matching document chunks
      db.getDb().prepare(
        "INSERT INTO document_chunks (content_hash, symbol, source, chunk_id, created_at) VALUES (?, ?, 'sec-edgar', ?, ?)"
      ).run(`hash-10q-${i}`, ticker, `${ticker}:${accession}:10-Q#c001`, filedAt);
    }

    // Mock requireAdmin to return null (authorized)
    const requireAdminSpy = vi.spyOn(await import("../src/lib/auth/admin"), "requireAdmin")
      .mockReturnValue(null as any);

    // Mock the refreshFilingBodies logic so we don't hit real SEC/Voyage APIs
    const refreshSpy = vi.spyOn(await import("../src/lib/web-sources/sec-filings"), "refreshFilingBodies")
      .mockResolvedValue({ attempted: 0, ingested: 0, skipped: 0, deferredForBudget: 0, errors: [] });

    // Call reindex endpoint with clearCache: true
    const response = await route.POST(authenticatedAdminRequest(JSON.stringify({
      symbols: [ticker],
      clearCache: true
    })));

    expect(response.status).toBe(200);

    // Verify latest 10 10-Ks are deleted from ingested_accessions
    // In our loop, i=1 to 10 are the newest 10 (since filedAt is closer to now).
    // i=11 and 12 are older.
    for (let i = 1; i <= 10; i++) {
      const accession = `acc-10k-${i.toString().padStart(3, "0")}`;
      const count = db.getDb().prepare("SELECT COUNT(*) as count FROM ingested_accessions WHERE accession = ?").get(accession) as { count: number };
      expect(count.count).toBe(0);
    }
    // Older 2 should still exist
    for (let i = 11; i <= 12; i++) {
      const accession = `acc-10k-${i.toString().padStart(3, "0")}`;
      const count = db.getDb().prepare("SELECT COUNT(*) as count FROM ingested_accessions WHERE accession = ?").get(accession) as { count: number };
      expect(count.count).toBe(1);
    }

    // Verify latest 10 10-Ks are downgraded to 'discovered' in sec_filings
    for (let i = 1; i <= 10; i++) {
      const accession = `acc-10k-${i.toString().padStart(3, "0")}`;
      const status = db.getDb().prepare("SELECT status FROM sec_filings WHERE accession = ?").get(accession) as { status: string };
      expect(status.status).toBe("discovered");
    }
    // Older 2 should remain 'complete'
    for (let i = 11; i <= 12; i++) {
      const accession = `acc-10k-${i.toString().padStart(3, "0")}`;
      const status = db.getDb().prepare("SELECT status FROM sec_filings WHERE accession = ?").get(accession) as { status: string };
      expect(status.status).toBe("complete");
    }

    // Verify latest 10 10-Q latest are deleted and older 2 remain
    for (let i = 1; i <= 10; i++) {
      const accession = `acc-10q-${i.toString().padStart(3, "0")}`;
      const count = db.getDb().prepare("SELECT COUNT(*) as count FROM ingested_accessions WHERE accession = ?").get(accession) as { count: number };
      expect(count.count).toBe(0);
    }
    for (let i = 11; i <= 12; i++) {
      const accession = `acc-10q-${i.toString().padStart(3, "0")}`;
      const count = db.getDb().prepare("SELECT COUNT(*) as count FROM ingested_accessions WHERE accession = ?").get(accession) as { count: number };
      expect(count.count).toBe(1);
    }

    // Verify document_chunks for latest 10 are deleted and older 2 remain
    for (let i = 1; i <= 10; i++) {
      const hash = `hash-10k-${i}`;
      const count = db.getDb().prepare("SELECT COUNT(*) as count FROM document_chunks WHERE content_hash = ?").get(hash) as { count: number };
      expect(count.count).toBe(0);
    }
    for (let i = 11; i <= 12; i++) {
      const hash = `hash-10k-${i}`;
      const count = db.getDb().prepare("SELECT COUNT(*) as count FROM document_chunks WHERE content_hash = ?").get(hash) as { count: number };
      expect(count.count).toBe(1);
    }

    refreshSpy.mockRestore();
    requireAdminSpy.mockRestore();
  });
});
