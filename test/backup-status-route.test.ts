import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../app/api/admin/backup-status/route";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";
import { setLitestreamRemoteInventoryCache } from "../src/lib/litestream-remote-inventory";

// Covers app/admin/backups/ — the admin-only route backing the new per-tier backup status
// panel. Read-only projection of the same src/lib/runtime-health.ts signals /api/health
// exposes publicly, reshaped for the UI. See test/runtime-health.test.ts for the underlying
// assessLitestreamTierFreshness unit coverage and test/connection-health-routing.test.ts for
// the /api/health wiring coverage.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-backup-status-${randomUUID()}.db`)}`;
});

function reqWithEmail(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) {
    headers[AUTHENTICATED_EMAIL_HEADER] = email;
    headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
  }
  return new Request("https://socratictrade.com/api/admin/backup-status", { method: "GET", headers });
}

describe("/api/admin/backup-status", () => {
  afterEach(() => {
    delete process.env.ADMIN_USER_EMAILS;
    delete process.env.DB_BOOTSTRAP;
    delete process.env.LITESTREAM_SOCKET_PATH;
    delete process.env.LITESTREAM_STATE_PATH;
  });

  it("denies a non-admin caller", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const res = await GET(reqWithEmail("someone-else@example.com"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("denies an unauthenticated caller", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const res = await GET(reqWithEmail());
    expect(res.status).toBe(403);
  });

  it("reports every tier as not-observable, with a reason, when litestream isn't running", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const stateRoot = mkdtempSync(join(tmpdir(), "backup-status-route-missing-"));
    try {
      process.env.LITESTREAM_SOCKET_PATH = join(stateRoot, "missing.sock");
      process.env.LITESTREAM_STATE_PATH = join(stateRoot, "not-created");

      const res = await GET(reqWithEmail("admin@example.com"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.overall).toMatchObject({ state: "unknown", source: "none", degraded: false });
      expect(body.tiers).toHaveLength(5);
      for (const tier of body.tiers) {
        // Never a bare "unknown": the panel must be able to say WHY it cannot see a level.
        expect(tier.state).toBe("not-observable");
        expect(typeof tier.reason).toBe("string");
        expect(tier.detail.length).toBeGreaterThan(0);
      }
      expect(body.tiersDegraded).toBe(false);
      expect(body.coverage).toMatchObject({ observed: 0, notObservable: 5, total: 5 });
      expect(typeof body.statePath).toBe("string");
      expect(Number.isFinite(Date.parse(body.asOf))).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // The production shape: level 0 read locally and healthy, levels 1/2/3/9 read from the
  // scheduler's replica inventory, with level 2 wedged. Before 2026-08-12 this panel could
  // only ever have shown five "unknown" cards here.
  it("surfaces a wedged remote level while level 0 stays healthy, and labels each tier's source", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const stateRoot = mkdtempSync(join(tmpdir(), "backup-status-route-degraded-"));
    try {
      const now = Date.now();
      const dir = join(stateRoot, "ltx", "0");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "0000000000037ce0-0000000000037ce0.ltx");
      writeFileSync(file, "ltx");
      utimesSync(file, new Date(now - 30_000), new Date(now - 30_000));

      setLitestreamRemoteInventoryCache({
        collectedAt: new Date(now - 5 * 60_000).toISOString(),
        status: "ok",
        levels: {
          "1": { level: 1, newestAt: new Date(now - 3 * 3_600_000).toISOString(), newestTxid: "000000000002324c", fileCount: 5635 },
          "2": { level: 2, newestAt: new Date(now - 4 * 24 * 3_600_000).toISOString(), newestTxid: "000000000000e5ad", fileCount: 171 },
          "3": { level: 3, newestAt: new Date(now - 2 * 3_600_000).toISOString(), newestTxid: "000000000002324c", fileCount: 15 },
          "9": { level: 9, newestAt: new Date(now - 10 * 3_600_000).toISOString(), newestTxid: "0000000000030586", fileCount: 8 }
        },
        levelErrors: {},
        skippedReason: null
      });

      process.env.LITESTREAM_SOCKET_PATH = join(stateRoot, "missing.sock");
      process.env.LITESTREAM_STATE_PATH = stateRoot;

      const res = await GET(reqWithEmail("admin@example.com"));
      expect(res.status).toBe(200);
      const body = await res.json();

      const byTier = Object.fromEntries(body.tiers.map((t: { tier: string }) => [t.tier, t]));
      expect(byTier["0"]).toMatchObject({ state: "known", source: "local-ltx", degraded: false });
      expect(byTier["1"]).toMatchObject({ state: "known", source: "remote-inventory", degraded: false });
      expect(byTier["2"]).toMatchObject({ state: "known", source: "remote-inventory", degraded: true });
      expect(byTier["3"]).toMatchObject({ state: "known", source: "remote-inventory", degraded: false });
      expect(byTier["9"]).toMatchObject({ state: "known", source: "remote-inventory", degraded: false });
      expect(body.tiersDegraded).toBe(true);
      expect(body.coverage).toMatchObject({ observed: 5, notObservable: 0, remoteInventoryState: "ok" });
    } finally {
      setLitestreamRemoteInventoryCache(null);
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
