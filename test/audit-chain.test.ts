/**
 * P0-4: tamper-evident per-user audit hash chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("audit hash chain (P0-4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentic-audit-chain-"));
    process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("links successive audits and verifies cleanly", async () => {
    const { audit, verifyAuditChain, getDb } = await import("../src/lib/db");
    audit("test_a", { n: 1 }, "user-a");
    audit("test_b", { n: 2 }, "user-a");
    audit("test_c", { n: 3 }, "user-a");
    audit("test_x", { n: 9 }, "user-b");

    const a = verifyAuditChain("user-a");
    expect(a.ok).toBe(true);
    expect(a.checked).toBe(3);

    const b = verifyAuditChain("user-b");
    expect(b.ok).toBe(true);
    expect(b.checked).toBe(1);

    const rows = getDb()
      .prepare(
        `SELECT chain_hash, prev_chain_hash FROM audit_events WHERE user_id = 'user-a' ORDER BY rowid ASC`
      )
      .all() as Array<{ chain_hash: string; prev_chain_hash: string | null }>;
    expect(rows[0].prev_chain_hash).toBeNull();
    expect(rows[1].prev_chain_hash).toBe(rows[0].chain_hash);
    expect(rows[2].prev_chain_hash).toBe(rows[1].chain_hash);
  });

  it("detects payload tampering on a chained row", async () => {
    const { audit, verifyAuditChain, getDb } = await import("../src/lib/db");
    audit("test_a", { n: 1 }, "tamper-user");
    audit("test_b", { n: 2 }, "tamper-user");

    const mid = getDb()
      .prepare(
        `SELECT id FROM audit_events WHERE user_id = 'tamper-user' AND kind = 'test_b' LIMIT 1`
      )
      .get() as { id: string };
    getDb()
      .prepare(`UPDATE audit_events SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ n: 999, hacked: true }), mid.id);

    const result = verifyAuditChain("tamper-user");
    expect(result.ok).toBe(false);
    expect(result.brokenId).toBe(mid.id);
    expect(result.reason).toMatch(/chain_hash does not recompute/i);
  });
});
