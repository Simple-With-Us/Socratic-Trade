// test/scheduler-lease.test.ts — CAS lease unit tests.
//
// Mirrors test/risk-breaker.test.ts: temp-SQLite beforeAll sets DATABASE_URL before any import
// so getDb() binds to the test DB. Uses dynamic imports (populated in beforeAll) to avoid
// module-level side effects on the DB. Each test gets a clean lease row via beforeEach.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let lease: typeof import("../src/lib/scheduler-lease");
let getDb: typeof import("../src/lib/db").getDb;

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(
    tmpdir(),
    `agentic-scheduler-lease-${randomUUID()}.db`
  )}`;
  // Dynamic imports bind to the temp DB after the env var is set.
  lease = await import("../src/lib/scheduler-lease");
  ({ getDb } = await import("../src/lib/db"));
});

beforeEach(() => {
  // Delete only the lease row — leave other settings intact.
  getDb().prepare("DELETE FROM settings WHERE key = 'scheduler:lease'").run();
});

// Fixed base time for determinism.
const T0 = new Date("2026-01-01T00:00:00.000Z");
const t = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe("acquireLease", () => {
  it("only one of two concurrent acquirers wins on a free lease", () => {
    const r1 = lease.acquireLease("A", 1000, T0);
    const r2 = lease.acquireLease("B", 1000, T0);
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(lease.getLease(T0)?.owner).toBe("A");
  });

  it("an expired lease can be stolen by a different owner", () => {
    expect(lease.acquireLease("A", 1000, T0)).toBe(true);
    // 2 s later — past the 1 s TTL (expiresAt = T0+1000).
    const tLater = t(2000);
    expect(lease.acquireLease("B", 1000, tLater)).toBe(true);
    expect(lease.getLease(tLater)?.owner).toBe("B");
  });

  it("a non-owner cannot steal a still-live lease", () => {
    expect(lease.acquireLease("A", 5000, T0)).toBe(true);
    const tMid = t(1000); // still within 5 s TTL
    expect(lease.acquireLease("B", 5000, tMid)).toBe(false);
    expect(lease.getLease(tMid)?.owner).toBe("A");
  });

  it("the current owner can re-acquire/extend its own live lease", () => {
    expect(lease.acquireLease("A", 1000, T0)).toBe(true);
    const tHalf = t(500);
    // Re-acquire with a longer TTL (500 + 5000 = 5500 ms after T0).
    expect(lease.acquireLease("A", 5000, tHalf)).toBe(true);
    const rec = lease.getLease(tHalf);
    expect(rec?.owner).toBe("A");
    // expiresAt should be tHalf + 5000.
    expect(rec?.expiresAt).toBe(new Date(tHalf.getTime() + 5000).toISOString());
  });
});

describe("renewLease", () => {
  it("renew succeeds only for the current owner and extends expiry", () => {
    expect(lease.acquireLease("A", 1000, T0)).toBe(true);
    const tHalf = t(500);
    // Renew as A.
    expect(lease.renewLease("A", 5000, tHalf)).toBe(true);
    const rec = lease.getLease(tHalf);
    expect(rec?.expiresAt).toBe(new Date(tHalf.getTime() + 5000).toISOString());
    // B cannot renew.
    expect(lease.renewLease("B", 5000, tHalf)).toBe(false);
    // Owner + expiry unchanged.
    expect(lease.getLease(tHalf)?.owner).toBe("A");
    expect(lease.getLease(tHalf)?.expiresAt).toBe(new Date(tHalf.getTime() + 5000).toISOString());
  });

  it("renew returns false when no lease exists", () => {
    expect(lease.renewLease("A", 1000, T0)).toBe(false);
    expect(lease.getLease(T0)).toBeNull();
  });
});

describe("releaseLease", () => {
  it("release removes the lease only for the owner", () => {
    expect(lease.acquireLease("A", 5000, T0)).toBe(true);
    // Non-owner release is a no-op.
    lease.releaseLease("B");
    expect(lease.getLease(T0)?.owner).toBe("A");
    // Owner release clears the lease.
    lease.releaseLease("A");
    expect(lease.getLease(T0)).toBeNull();
    // Second release by owner does not throw.
    expect(() => lease.releaseLease("A")).not.toThrow();
  });
});

describe("getLease", () => {
  it("getLease reflects current state including age and expired flag", () => {
    // No lease → null.
    expect(lease.getLease(T0)).toBeNull();

    expect(lease.acquireLease("A", 1000, T0)).toBe(true);

    // 300 ms later — not expired.
    const rec1 = lease.getLease(t(300));
    expect(rec1?.owner).toBe("A");
    expect(rec1?.ageMs).toBe(300);
    expect(rec1?.expired).toBe(false);

    // 1500 ms later — past the 1 s TTL.
    const rec2 = lease.getLease(t(1500));
    expect(rec2?.expired).toBe(true);
    expect(rec2?.owner).toBe("A");
  });
});

describe("malformed lease value", () => {
  it("a malformed lease value is treated as absent and reclaimable", () => {
    // Insert a non-JSON value directly.
    getDb()
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('scheduler:lease', ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run("not-valid-json", T0.toISOString());

    // getLease should return null for malformed data.
    expect(lease.getLease(T0)).toBeNull();

    // acquireLease should succeed (treats malformed as absent).
    expect(lease.acquireLease("A", 1000, T0)).toBe(true);
    expect(lease.getLease(T0)?.owner).toBe("A");
  });
});
