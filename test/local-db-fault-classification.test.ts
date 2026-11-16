// A LOCAL SQLite failure must never be reported as a provider outage.
//
// Prod bug (owner-visible, 2026-08-09): hourly Pushover alerts titled "Pinecone connection failed"
// whose body was `inventory fetch: database is locked` / `inventory list: database is locked`.
// "database is locked" is SQLITE_BUSY from our OWN better-sqlite3 file; Pinecone was healthy the
// whole time. withRagApiHealth wraps the entire durable dispatch cycle (reserve -> mark started ->
// provider call -> settle), so a SQLite error raised by the LOCAL ledger writes on either side of
// the network call reached the provider-degraded lane wearing Pinecone's name.
//
// This suite pins both halves of the fix:
//   1. Classification — a local-DB error leaves the provider lane alone and records the real cause;
//      a genuine Pinecone network/HTTP error keeps the exact provider_degraded behavior it had.
//   2. The contention itself — the dispatch ledger's read-then-write transactions must open with
//      BEGIN IMMEDIATE. A deferred read-then-write transaction upgrades a WAL read snapshot, and
//      that upgrade returns SQLITE_BUSY_SNAPSHOT ("database is locked") IMMEDIATELY without SQLite
//      ever consulting `busy_timeout` (waiting cannot make a stale snapshot current) — which is why
//      the 60s busy_timeout in db.ts never absorbed it.
//
// Fault-injection note: the end-to-end case drives a REAL better-sqlite3 error out of the REAL
// settle path (the `provider_usage_outbox` table is dropped for the duration of one call, so the
// settle after a SUCCESSFUL Pinecone response raises `no such table: ...`). That is the exact
// production shape — provider answered, local ledger write failed — and it is discriminating:
// before this fix it produced a pinecone failure row plus a "Pinecone connection failed" push.
// The literal "database is locked"/SQLITE_BUSY_SNAPSHOT shapes are pinned at the classifier
// boundary instead, because holding a real write lock across the settle would also block the
// classifier's own audit write and make the assertion meaningless.
//
// Hermetic: real module graph against a temp SQLite DB; only the Pinecone SDK and the notification
// egress are stubbed.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-local-db-fault-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-local-db-fault-data-${runId}`);
  process.env.PINECONE_API_KEY = "pinecone-test-key";
  process.env.PINECONE_INDEX_NAME = "socratic-trade-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
});

const mocks = vi.hoisted(() => ({
  listIndexes: vi.fn(),
  listPaginated: vi.fn(),
  fetchRecords: vi.fn(),
  describeIndex: vi.fn(),
  sendNotification: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    const index = {
      listPaginated: mocks.listPaginated,
      fetch: mocks.fetchRecords,
      namespace: vi.fn(() => index)
    };
    return {
      listIndexes: mocks.listIndexes,
      describeIndex: mocks.describeIndex,
      Index: vi.fn(() => index)
    };
  })
}));

vi.mock("../src/lib/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/notifications")>();
  return { ...actual, sendNotification: mocks.sendNotification };
});

const PINECONE_NETWORK_ERROR =
  "PineconeConnectionError: Request failed to reach Pinecone. " +
  "request to https://socratic-trade-test.svc.pinecone.io/vectors/list failed, reason: getaddrinfo ENOTFOUND";

async function resetDb(): Promise<void> {
  const { getDb, applyVersionedMigrations, deleteInternalSetting } = await import("../src/lib/db");
  const db = getDb();
  applyVersionedMigrations(db);
  db.prepare("DELETE FROM audit_events").run();
  db.prepare("DELETE FROM api_health_log").run();
  db.prepare("DELETE FROM provider_dispatch_attempts").run();
  db.prepare("DELETE FROM provider_usage_outbox").run();
  const { LOCAL_DB_FAULT_WINDOW_KEY, LOCAL_DB_FAULT_AUDIT_HOUR_KEY } = await import("../src/lib/local-db-fault");
  deleteInternalSetting(LOCAL_DB_FAULT_WINDOW_KEY);
  deleteInternalSetting(LOCAL_DB_FAULT_AUDIT_HOUR_KEY);
  // alertRagConnectionFailure's own 1h per-lane cooldown, and alertStorageWarning's 12h one, must
  // not leak between cases.
  for (const source of ["env", "user", "none"]) {
    deleteInternalSetting(`vectorStore:connectionAlert:pinecone:${source}:local`);
  }
  deleteInternalSetting("storageAlertSent:local database contention");
}

async function auditKinds(): Promise<string[]> {
  const { getDb } = await import("../src/lib/db");
  return (getDb().prepare("SELECT kind FROM audit_events").all() as Array<{ kind: string }>).map((r) => r.kind);
}

async function pineconeFailureRows(): Promise<Array<{ error_text: string | null }>> {
  const { getDb } = await import("../src/lib/db");
  return getDb()
    .prepare("SELECT error_text FROM api_health_log WHERE service = 'pinecone' AND ok = 0")
    .all() as Array<{ error_text: string | null }>;
}

function providerDegradedCalls(): unknown[][] {
  return mocks.sendNotification.mock.calls.filter(
    ([event]) => (event as { type?: string } | undefined)?.type === "provider_degraded"
  );
}

/**
 * Run `work` with `provider_usage_outbox` temporarily absent, so the REAL settleProviderDispatch
 * raises a real better-sqlite3 `no such table` error. Every schema object attached to the table
 * (indexes + account write-fence triggers) is captured from sqlite_master and replayed afterwards.
 */
async function withMissingUsageOutboxTable<T>(work: () => Promise<T>): Promise<T> {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const objects = db
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'provider_usage_outbox' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  db.exec("DROP TABLE provider_usage_outbox");
  try {
    return await work();
  } finally {
    for (const object of objects) db.exec(object.sql);
  }
}

describe("local-DB fault classification", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.sendNotification.mockResolvedValue(undefined);
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade-test" }] });
    mocks.describeIndex.mockResolvedValue({ metric: "cosine", host: "socratic-trade-test.svc.pinecone.io" });
    await resetDb();
  });

  it("recognizes only our own SQLite fault shapes, never provider errors", async () => {
    const { isLocalDbFaultMessage, isLocalDbFaultError } = await import("../src/lib/local-db-fault");

    // The exact strings from the owner's Pushover screenshot.
    expect(isLocalDbFaultMessage("database is locked")).toBe(true);
    expect(isLocalDbFaultMessage("inventory fetch: database is locked")).toBe(true);
    expect(isLocalDbFaultMessage("inventory list: database is locked")).toBe(true);
    expect(isLocalDbFaultMessage("database table is locked: settings")).toBe(true);
    expect(isLocalDbFaultMessage("no such table: provider_usage_outbox")).toBe(true);
    expect(isLocalDbFaultMessage("SQLITE_BUSY: unable to write")).toBe(true);

    const congressD1 =
      'App A reported ok=false with 19 error(s); first: "WMT price: D1 batch error: SQLITE_BUSY: database is locked"';
    expect(isLocalDbFaultMessage(congressD1)).toBe(false);

    // Genuine provider failures must stay on the provider-degraded path.
    expect(isLocalDbFaultMessage(PINECONE_NETWORK_ERROR)).toBe(false);
    expect(isLocalDbFaultMessage("HTTP 429 Too Many Requests")).toBe(false);
    expect(isLocalDbFaultMessage("PineconeAuthorizationError: Invalid API key. Status: 401.")).toBe(false);
    expect(isLocalDbFaultMessage("You've reached your write unit limit for the current month (2000000). Status: 429.")).toBe(false);
    expect(isLocalDbFaultMessage("")).toBe(false);
    expect(isLocalDbFaultMessage(null)).toBe(false);

    // better-sqlite3 reports SQLITE_BUSY_SNAPSHOT — the busy_timeout-proof variant this bug's root
    // cause produced — with the bare message "database is locked" and the code on the error object.
    const snapshot = new Error("database is locked") as Error & { code: string };
    snapshot.code = "SQLITE_BUSY_SNAPSHOT";
    expect(isLocalDbFaultError(snapshot)).toBe(true);
    const codeOnly = new Error("unexpected wording") as Error & { code: string };
    codeOnly.code = "SQLITE_BUSY";
    expect(isLocalDbFaultError(codeOnly)).toBe(true);
    expect(isLocalDbFaultError(new Error(PINECONE_NETWORK_ERROR))).toBe(false);
    expect(isLocalDbFaultError(undefined)).toBe(false);
  });

  it("sees through a re-wrapping seam and reports the RAW SQLite text", async () => {
    const { isLocalDbFaultError, localDbFaultReason } = await import("../src/lib/local-db-fault");

    // vector-db.ts's managed-commit seams rethrow local receipt/finalize failures as
    // `new Error("document-…-failed", { cause: sqliteError })`. The wrapper's own message matches
    // no pattern and carries no `code`, so classifying it alone is a silent no-op — the exact trap
    // that made an earlier attempt at this fix do nothing.
    const wrapped = new Error("document-local-commit-finalize-failed", {
      cause: new Error("database is locked")
    });
    expect(isLocalDbFaultError(wrapped)).toBe(true);
    expect(localDbFaultReason(wrapped)).toBe("database is locked");

    // The `code`-only variant survives wrapping too.
    const snapshot = new Error("database is locked") as Error & { code: string };
    snapshot.code = "SQLITE_BUSY_SNAPSHOT";
    expect(localDbFaultReason(new Error("document-receipt-write-failed", { cause: snapshot }))).toBe(
      "database is locked"
    );

    // A wrapped PROVIDER failure must still read as a provider failure.
    expect(
      isLocalDbFaultError(new Error("document-receipt-write-failed", { cause: new Error(PINECONE_NETWORK_ERROR) }))
    ).toBe(false);
    expect(localDbFaultReason(new Error("document-receipt-write-failed"))).toBeNull();

    // Bounded walk: a self-referential chain terminates instead of spinning.
    const cyclic = new Error("wrapper-a") as Error & { cause?: unknown };
    const inner = new Error("wrapper-b") as Error & { cause?: unknown };
    cyclic.cause = inner;
    inner.cause = cyclic;
    expect(isLocalDbFaultError(cyclic)).toBe(false);
  });

  it("a local DB failure during vector inventory does NOT fail the pinecone lane or push provider_degraded", async () => {
    mocks.listPaginated.mockResolvedValue({ vectors: [{ id: "vec-1" }], pagination: undefined });
    mocks.fetchRecords.mockResolvedValue({
      records: { "vec-1": { id: "vec-1", metadata: { source: "sec-10k" } } }
    });

    const { inventoryVectorRecordsByMetadata } = await import("../src/lib/vector-db");
    await withMissingUsageOutboxTable(async () => {
      // Pinecone answered every call; the LOCAL ledger write after it is what raises.
      await expect(inventoryVectorRecordsByMetadata({ userId: "local" })).rejects.toThrow(/no such table/);
    });

    // The provider lane learned nothing about Pinecone, so it must record nothing against it.
    expect(await pineconeFailureRows()).toHaveLength(0);
    expect(providerDegradedCalls()).toHaveLength(0);
    // ... and the real cause is on the record.
    expect(await auditKinds()).toContain("local_db_contention");
  });

  it("a dispatch-lease-lost settle does NOT fail the pinecone lane or push provider_degraded", async () => {
    const { ProviderDispatchLeaseLostError } = await import("../src/lib/db-provider-dispatch");
    mocks.listPaginated.mockRejectedValue(new ProviderDispatchLeaseLostError("attempt-lease-lost"));

    const { inventoryVectorRecordsByMetadata } = await import("../src/lib/vector-db");
    await expect(inventoryVectorRecordsByMetadata({ userId: "local" })).rejects.toThrow(
      /Provider dispatch lease was lost before outcome persistence/
    );

    expect(await pineconeFailureRows()).toHaveLength(0);
    expect(providerDegradedCalls()).toHaveLength(0);
    expect(await auditKinds()).not.toContain("local_db_contention");
  });

  it("a real Pinecone network failure still fails the lane and pushes 'Pinecone connection failed'", async () => {
    mocks.listPaginated.mockRejectedValue(new Error(PINECONE_NETWORK_ERROR));

    const { inventoryVectorRecordsByMetadata } = await import("../src/lib/vector-db");
    await expect(inventoryVectorRecordsByMetadata({ userId: "local" })).rejects.toThrow(/PineconeConnectionError/);

    const failures = await pineconeFailureRows();
    expect(failures).toHaveLength(1);
    expect(failures[0].error_text).toContain("inventory list: ");
    expect(failures[0].error_text).toContain("PineconeConnectionError");

    const degraded = providerDegradedCalls();
    expect(degraded).toHaveLength(1);
    expect((degraded[0][0] as { title: string }).title).toBe("Pinecone connection failed");
    // A provider outage is NOT local contention.
    expect(await auditKinds()).not.toContain("local_db_contention");
  });

  it("raises ONE advisory that names local contention, not a vendor, after repeated faults", async () => {
    const { getDb } = await import("../src/lib/db");
    const { noteLocalDbFault, LOCAL_DB_FAULT_ADVISORY_THRESHOLD, LOCAL_DB_FAULT_WARNING_TYPE } =
      await import("../src/lib/local-db-fault");

    for (let i = 0; i < LOCAL_DB_FAULT_ADVISORY_THRESHOLD - 1; i++) {
      const result = await noteLocalDbFault({ lane: "pinecone", operation: "inventory fetch", message: "database is locked" });
      expect(result.advised).toBe(false);
    }
    expect((await auditKinds()).filter((kind) => kind === "storage_warning_alert")).toHaveLength(0);

    const tripping = await noteLocalDbFault({ lane: "pinecone", operation: "inventory fetch", message: "database is locked" });
    expect(tripping.advised).toBe(true);
    expect(tripping.count).toBe(LOCAL_DB_FAULT_ADVISORY_THRESHOLD);

    // alertStorageWarning's own durable receipt, written before any egress.
    const alerts = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'storage_warning_alert'")
      .all() as Array<{ payload: string }>;
    expect(alerts).toHaveLength(1);
    const payload = JSON.parse(alerts[0].payload) as { warningType: string; message: string };
    expect(payload.warningType).toBe(LOCAL_DB_FAULT_WARNING_TYPE);
    expect(payload.message).toContain("local write-lock contention");
    // alertStorageWarning builds the owner-visible title as `Storage Warning: <warningType>`; it
    // must name the real cause and never a vendor.
    const title = `Storage Warning: ${payload.warningType.replace(/_/g, " ")}`;
    expect(title.toLowerCase()).toContain("local database contention");
    expect(title.toLowerCase()).not.toContain("pinecone");
    // Never a provider-degraded push for a local fault.
    expect(providerDegradedCalls()).toHaveLength(0);

    // Still exactly one per window, however long the contention lasts.
    await noteLocalDbFault({ lane: "pinecone", operation: "inventory list", message: "database is locked" });
    const after = getDb()
      .prepare("SELECT COUNT(*) AS cnt FROM audit_events WHERE kind = 'storage_warning_alert'")
      .get() as { cnt: number };
    expect(after.cnt).toBe(1);
  });

  it("audits at most once per hour so a contention storm cannot amplify itself with writes", async () => {
    const { noteLocalDbFault } = await import("../src/lib/local-db-fault");
    for (let i = 0; i < 3; i++) {
      await noteLocalDbFault({ lane: "pinecone", operation: "inventory fetch", message: "database is locked" });
    }
    expect((await auditKinds()).filter((kind) => kind === "local_db_contention")).toHaveLength(1);
  });
});

describe("provider dispatch ledger transactions hold the write lock from BEGIN", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // The defect this pins: `settleProviderDispatch` SELECTs before it UPDATEs. Under a deferred
  // BEGIN that read takes a WAL snapshot, and promoting it to a write once another connection has
  // committed returns SQLITE_BUSY_SNAPSHOT instantly — busy_timeout is never consulted, so the 60s
  // ceiling in db.ts could not absorb it. BEGIN IMMEDIATE removes the stale-snapshot window.
  it("reserve, markStarted and settle all use BEGIN IMMEDIATE", async () => {
    const dbModule = await import("../src/lib/db");
    const {
      reserveProviderDispatch,
      markProviderDispatchStarted,
      settleProviderDispatch
    } = await import("../src/lib/db-provider-dispatch");

    const db = dbModule.getDb();
    const realTransaction = db.transaction.bind(db);
    const modes: string[] = [];
    const spy = vi.spyOn(db, "transaction").mockImplementation(((work: (...args: unknown[]) => unknown) => {
      const tx = realTransaction(work as never) as unknown as {
        (...args: unknown[]): unknown;
        immediate: (...args: unknown[]) => unknown;
        exclusive: unknown;
        deferred: unknown;
      };
      const wrapped = ((...args: unknown[]) => {
        modes.push("deferred");
        return tx(...args);
      }) as unknown as Record<string, unknown>;
      wrapped.immediate = (...args: unknown[]) => {
        modes.push("immediate");
        return tx.immediate(...args);
      };
      wrapped.exclusive = tx.exclusive;
      wrapped.deferred = tx.deferred;
      return wrapped;
    }) as never);

    try {
      const reservation = reserveProviderDispatch({
        provider: "pinecone",
        operation: "inventory fetch",
        credentialRef: "cred-immediate-test",
        userId: "local"
      });
      expect(reservation.admitted).toBe(true);
      if (!reservation.admitted) return;
      markProviderDispatchStarted(reservation.attemptId, new Date().toISOString(), { supervise: false });
      settleProviderDispatch(reservation.attemptId, "succeeded");
    } finally {
      spy.mockRestore();
    }

    expect(modes).toEqual(["immediate", "immediate", "immediate"]);
  });

  it("still settles correctly and writes exactly one usage-outbox row", async () => {
    const { reserveProviderDispatch, markProviderDispatchStarted, settleProviderDispatch } =
      await import("../src/lib/db-provider-dispatch");
    const { getDb } = await import("../src/lib/db");

    const reservation = reserveProviderDispatch({
      provider: "pinecone",
      operation: "inventory list",
      credentialRef: "cred-settle-test",
      userId: "local"
    });
    expect(reservation.admitted).toBe(true);
    if (!reservation.admitted) return;
    markProviderDispatchStarted(reservation.attemptId, new Date().toISOString(), { supervise: false });
    settleProviderDispatch(reservation.attemptId, "succeeded");

    const row = getDb()
      .prepare("SELECT status FROM provider_dispatch_attempts WHERE id = ?")
      .get(reservation.attemptId) as { status: string };
    expect(row.status).toBe("succeeded");
    const outbox = getDb()
      .prepare("SELECT COUNT(*) AS cnt FROM provider_usage_outbox WHERE attempt_id = ?")
      .get(reservation.attemptId) as { cnt: number };
    expect(outbox.cnt).toBe(1);
  });
});
