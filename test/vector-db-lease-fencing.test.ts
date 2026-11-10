import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-vector-lease-${randomUUID()}.db`)}`;

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const index = vi.fn(() => ({ upsert }));
  return {
    upsert,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    sendNotification: vi.fn(),
    alertUsageLimitHit: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
      describeIndex: mocks.describeIndex,
      Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/notifications", () => ({ sendNotification: mocks.sendNotification }));
vi.mock("../src/lib/usage-limit-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/usage-limit-alerts")>();
  return {
    ...actual,
    alertUsageLimitHit: (...args: Parameters<typeof actual.alertUsageLimitHit>) => {
      mocks.alertUsageLimitHit(...args);
      return actual.alertUsageLimitHit(...args);
    }
  };
});

const { getDb } = await import("../src/lib/db");

beforeAll(() => {
  getDb();
});

function rows(sql: string): unknown[] {
  return getDb().prepare(sql).all();
}

function durableSnapshot() {
  return {
    // "rag-embed" is the provider-generic health lane withRagApiHealth now uses for embed calls
    // (renamed 2026-07-19 from the literal "voyage" service name — see vector-db.ts).
    health: rows("SELECT service, ok, error_text FROM api_health_log WHERE service IN ('pinecone', 'rag-embed') ORDER BY rowid"),
    audits: rows(
      "SELECT kind, payload FROM audit_events WHERE kind LIKE 'vector%' OR kind LIKE 'notify%' OR kind IN ('usage_limit_alert', 'notification.delivery') ORDER BY rowid"
    ),
    notifications: rows("SELECT type, status, payload, error FROM notification_events ORDER BY rowid"),
    settings: rows(
      "SELECT key, value FROM settings WHERE key LIKE 'vectorStore:%' OR key LIKE 'usageLimitAlert:%' ORDER BY key"
    )
  };
}

function providerUsageTruth() {
  return rows(`
    SELECT a.provider, a.operation, a.status, o.outcome
    FROM provider_dispatch_attempts a
    LEFT JOIN provider_usage_outbox o ON o.attempt_id = a.id
    ORDER BY a.created_at, a.id
  `);
}

function leaseGuard(controller: AbortController, owns: () => boolean) {
  return {
    signal: controller.signal,
    assertOwnership: () => {
      if (!owns()) throw new Error("synthetic durable lease loss");
    }
  };
}

function context() {
  return [{
    text: "Management discussed revenue growth and customer demand.",
    metadata: { symbol: "AAPL", source: "fmp-earnings-transcript", timestamp: "2026-04-20" }
  }];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-lease-test";
  process.env.VOYAGE_API_KEY = "voyage-lease-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  delete process.env.SENTRY_DSN;
  delete process.env.RAG_INGEST_MAX_TEXTS_PER_DAY;
  getDb().prepare("DELETE FROM api_health_log WHERE service IN ('pinecone', 'rag-embed')").run();
  getDb().prepare(
    "DELETE FROM audit_events WHERE kind LIKE 'vector%' OR kind LIKE 'notify%' OR kind IN ('usage_limit_alert', 'notification.delivery')"
  ).run();
  getDb().prepare("DELETE FROM notification_events").run();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'vectorStore:%' OR key LIKE 'usageLimitAlert:%'").run();
  getDb().exec("DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;");
  // Isolation for the durable embed stage (db-embed-stage.ts): a lease-loss abort AFTER a paid
  // embed deliberately leaves staged rows behind, and a later test using the same context()
  // text would replay them and never reach an embed-side abort hook.
  getDb().prepare("DELETE FROM embed_stage").run();
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.createIndex.mockResolvedValue(undefined);
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  mocks.upsert.mockResolvedValue(undefined);
  mocks.sendNotification.mockResolvedValue({});
});

describe("vector-store durable lease fencing", () => {
  it("emits no business rows after listIndexes lease loss while retaining provider usage truth", async () => {
    let owns = true;
    const controller = new AbortController();
    mocks.listIndexes.mockImplementationOnce(async () => {
      owns = false;
      controller.abort(new Error("lease lost during listIndexes"));
      return { indexes: [{ name: "socratic-trade" }] };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual({ health: [], audits: [], notifications: [], settings: [] });
    expect(mocks.createIndex).not.toHaveBeenCalled();
    expect(mocks.describeIndex).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.alertUsageLimitHit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(providerUsageTruth()).toEqual([{
      provider: "pinecone",
      operation: "listIndexes",
      status: "succeeded",
      outcome: "succeeded"
    }]);
    warn.mockRestore();
  });

  it("does not append health/audit/settings after ownership is lost during createIndex", async () => {
    let owns = true;
    const controller = new AbortController();
    let atLoss = durableSnapshot();
    mocks.listIndexes.mockResolvedValueOnce({ indexes: [] });
    mocks.createIndex.mockImplementationOnce(async () => {
      atLoss = durableSnapshot();
      owns = false;
      controller.abort(new Error("lease lost during createIndex"));
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual(atLoss);
    expect(mocks.createIndex).toHaveBeenCalledTimes(1);
    expect(mocks.describeIndex).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("awaits a delayed index-failure notification and writes nothing after ownership moves", async () => {
    let owns = true;
    const controller = new AbortController();
    let atLoss = durableSnapshot();
    mocks.listIndexes.mockRejectedValueOnce(new Error("Pinecone HTTP 503"));
    mocks.sendNotification.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      atLoss = durableSnapshot();
      owns = false;
      controller.abort(new Error("lease lost during index-failure notification"));
      return {};
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual(atLoss);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.alertUsageLimitHit).not.toHaveBeenCalled();
    expect(mocks.describeIndex).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("awaits a delayed budget notification and writes nothing after ownership moves", async () => {
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    let owns = true;
    const controller = new AbortController();
    let atLoss = durableSnapshot();
    mocks.sendNotification.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      atLoss = durableSnapshot();
      owns = false;
      controller.abort(new Error("lease lost during budget notification"));
      return {};
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts([...context(), ...context()], "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual(atLoss);
    expect(mocks.alertUsageLimitHit).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.listIndexes).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("awaits a delayed missing-client notification and writes nothing after ownership moves", async () => {
    delete process.env.PINECONE_API_KEY;
    let owns = true;
    const controller = new AbortController();
    let atLoss = durableSnapshot();
    mocks.sendNotification.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      atLoss = durableSnapshot();
      owns = false;
      controller.abort(new Error("lease lost during missing-client notification"));
      return {};
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual(atLoss);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.alertUsageLimitHit).not.toHaveBeenCalled();
    expect(mocks.listIndexes).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("cancels the index-ready wait without late ledgers or provider work", async () => {
    process.env.PINECONE_INDEX_READY_WAIT_MS = "10000";
    let owns = true;
    const controller = new AbortController();
    mocks.listIndexes.mockResolvedValueOnce({ indexes: [] });
    mocks.createIndex.mockImplementationOnce(async () => {
      setTimeout(() => {
        owns = false;
        controller.abort(new Error("lease lost during index-ready wait"));
      }, 0);
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);
    const afterLoss = durableSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(durableSnapshot()).toEqual(afterLoss);
    expect(mocks.describeIndex).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not cache a lease-aborted describeIndex and lets the successor initialize cleanly", async () => {
    let owns = true;
    const controller = new AbortController();
    let atLoss = durableSnapshot();
    mocks.describeIndex.mockImplementationOnce(async () => {
      atLoss = durableSnapshot();
      owns = false;
      controller.abort(new Error("lease lost during describeIndex"));
      return { metric: "euclidean" };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual(atLoss);
    expect(warn).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();

    const successor = new AbortController();
    mocks.describeIndex.mockResolvedValueOnce({ metric: "cosine" });
    const result = await storeContexts(context(), "local", {
      leaseGuard: leaseGuard(successor, () => true)
    });

    expect(result).toMatchObject({ indexed: 1 });
    expect(mocks.listIndexes).toHaveBeenCalledTimes(2);
    expect(mocks.describeIndex).toHaveBeenCalledTimes(2);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not append durable rows after ownership is lost inside Pinecone upsert", async () => {
    let owns = true;
    const controller = new AbortController();
    let atLoss = durableSnapshot();
    mocks.upsert.mockImplementationOnce(async () => {
      atLoss = durableSnapshot();
      owns = false;
      controller.abort(new Error("lease lost during upsert"));
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(durableSnapshot()).toEqual(atLoss);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.alertUsageLimitHit).not.toHaveBeenCalled();
  });

  it("retains a succeeded Voyage attempt when ownership moves before business telemetry", async () => {
    let owns = true;
    const controller = new AbortController();
    mocks.embed.mockImplementationOnce(async () => {
      owns = false;
      controller.abort(new Error("lease lost after Voyage response"));
      return { data: [{ embedding: [0.1, 0.2] }] };
    });
    const { storeContexts } = await import("../src/lib/vector-db");

    await expect(storeContexts(context(), "local", {
      leaseGuard: leaseGuard(controller, () => owns)
    })).rejects.toThrow(/lease/i);

    expect(providerUsageTruth()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "voyage",
        operation: "embed document",
        status: "succeeded",
        outcome: "succeeded"
      })
    ]));
    expect(rows("SELECT service FROM api_health_log WHERE service = 'rag-embed'")).toEqual([]);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
