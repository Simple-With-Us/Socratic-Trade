// ST-3988: App A D1/SQLITE_BUSY import rejections must not page as "congress-share connection failed".
//
// Hermetic: temp SQLite + stubbed Sentry; exercises classifier + alertConnectionFailure path.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  withScope: vi.fn(),
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
  setFingerprint: vi.fn()
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  withScope: sentry.withScope
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-peer-db-fault-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

const PROD_BODY_ERROR =
  'App A reported ok=false with 19 error(s); first: "WMT price: D1 batch error: SQLITE_BUSY: database is locked"';

beforeEach(async () => {
  vi.clearAllMocks();
  sentry.withScope.mockImplementation((cb: (scope: unknown) => void) =>
    cb({
      setLevel: sentry.setLevel,
      setTag: sentry.setTag,
      setContext: sentry.setContext,
      setFingerprint: sentry.setFingerprint
    })
  );
  process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
  const { getDb } = await import("../src/lib/db");
  for (const table of ["api_health_log", "audit_events", "settings", "notification_events"]) {
    getDb().prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 150));
  delete process.env.SENTRY_DSN;
});

describe("peer upstream DB fault classification (ST-3988)", () => {
  it("recognizes App A D1 SQLITE_BUSY import body errors on congress-share", async () => {
    const { isPeerUpstreamDbFaultMessage } = await import("../src/lib/peer-db-fault");
    const { isLocalDbFaultMessage: isLocal } = await import("../src/lib/local-db-fault");
    expect(isPeerUpstreamDbFaultMessage(PROD_BODY_ERROR, "congress-share")).toBe(true);
    expect(isLocal(PROD_BODY_ERROR, "congress-share")).toBe(false);
    expect(isLocal(PROD_BODY_ERROR)).toBe(false);
    expect(isPeerUpstreamDbFaultMessage("HTTP 401 denied", "congress-share")).toBe(false);
    expect(isPeerUpstreamDbFaultMessage(PROD_BODY_ERROR, "pinecone")).toBe(false);
  });

  it("treats peer-db rows as soft so five import rejections do not hard-STOP the lane", async () => {
    const { isSoftHealthFailure } = await import("../src/lib/db-health");
    const { formatPeerDbHealthErrorText, HEALTH_PEER_DB_CONTENTION_PREFIX } = await import("../src/lib/peer-db-fault");
    expect(isSoftHealthFailure(formatPeerDbHealthErrorText(PROD_BODY_ERROR))).toBe(true);
    expect(HEALTH_PEER_DB_CONTENTION_PREFIX.length).toBeGreaterThan(0);
  });

  it("runs peer contention alerting through logApiHealth flush (soft row, not skipped)", async () => {
    const { logApiHealth, flushApiHealthBuffer } = await import("../src/lib/db-health");
    const { formatPeerDbHealthErrorText } = await import("../src/lib/peer-db-fault");
    logApiHealth({
      service: "congress-share",
      ok: false,
      errorText: formatPeerDbHealthErrorText(PROD_BODY_ERROR),
      keySource: "env"
    });
    flushApiHealthBuffer();
    await new Promise((r) => setTimeout(r, 200));
    expect(sentry.captureMessage).toHaveBeenCalled();
    const title = String(sentry.captureMessage.mock.calls[0]?.[0] ?? "");
    expect(title).toContain("peer write contention");
    expect(title).not.toContain("connection failed");
  });

  it("alerts at Sentry warning with peer-db-contention, not connection failed", async () => {
    const { alertConnectionFailure, flushApiHealthBuffer } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    for (let i = 0; i < 5; i++) {
      getDb()
        .prepare(
          `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
           VALUES (?, 'congress-share', ?, 0, NULL, ?, 'env', NULL)`
        )
        .run(randomUUID(), new Date().toISOString(), PROD_BODY_ERROR);
    }
    await alertConnectionFailure("congress-share", "env", null, PROD_BODY_ERROR);
    await new Promise((r) => setTimeout(r, 200));
    expect(sentry.captureMessage).toHaveBeenCalled();
    const title = String(sentry.captureMessage.mock.calls[0]?.[0] ?? "");
    expect(title).toContain("peer write contention");
    expect(title).not.toContain("connection failed");
    expect(sentry.setLevel).toHaveBeenCalledWith("warning");
    expect(sentry.setTag).toHaveBeenCalledWith("health.failure_class", "peer-db-contention");

    flushApiHealthBuffer();
    const kinds = (getDb().prepare("SELECT kind FROM audit_events").all() as Array<{ kind: string }>).map(
      (r) => r.kind
    );
    expect(kinds).toContain("peer_db_contention");
    expect(kinds).not.toContain("connection_health_alert");
  });
});
