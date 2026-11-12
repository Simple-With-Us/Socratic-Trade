/**
 * ST-4607: provider-side embed timeouts on the ingest ("embed documents") lane are timeouts, not hard
 * OpenRouter integration outages.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRagEmbedProviderTimeout,
  isRagEmbedProviderTimeoutText,
  RAG_EMBED_PROVIDER_TIMEOUT_MESSAGE
} from "../src/lib/rag/embed-resilience";
import { pinRagQualityFlagsOff } from "./rag-test-env";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const index = vi.fn(() => ({ upsert, query }));
  const tags: Array<Record<string, string>> = [];
  const levels: string[] = [];
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    captureMessage: vi.fn(),
    tags,
    levels,
    withScope: vi.fn((callback: (scope: {
      setLevel: (level: string) => void;
      setTag: (key: string, value: string) => void;
      setContext: (key: string, value: unknown) => void;
      setFingerprint: (value: string[]) => void;
    }) => void) => {
      const tag: Record<string, string> = {};
      mocks.tags.push(tag);
      callback({
        setLevel: (level) => {
          levels.push(level);
        },
        setTag: (key, value) => {
          tag[key] = value;
        },
        setContext: () => undefined,
        setFingerprint: () => undefined
      });
    })
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
    return { embed: mocks.embed, rerank: mocks.rerank };
  })
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  withScope: mocks.withScope
}));

function providerTimeout(): Error {
  return Object.assign(new Error(RAG_EMBED_PROVIDER_TIMEOUT_MESSAGE), { name: "TimeoutError" });
}

function econnrefused(): Error {
  const error = new Error("connect ECONNREFUSED 127.0.0.1:443");
  (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
  return error;
}

function messages(): string[] {
  return mocks.captureMessage.mock.calls.map((call) => String(call[0]));
}

async function insertAgedEmbedTimeoutFailure(minutesAgo: number): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  getDb().prepare(
    `INSERT INTO api_health_log (service, ok, latency_ms, error_text, key_source, user_id, ts)
     VALUES ('rag-embed', 0, 1, ?, 'user', 'local', ?)`
  ).run(`embed documents: ${RAG_EMBED_PROVIDER_TIMEOUT_MESSAGE}`, ts);
}

beforeEach(() => {
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  mocks.tags.length = 0;
  mocks.levels.length = 0;
  const cooldown = (globalThis as { __socraticRagSentryLastSentAt?: Map<string, number> }).__socraticRagSentryLastSentAt;
  cooldown?.clear();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `rag-ingest-timeout-${randomUUID()}.db`)}`;
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.OPENROUTER_API_KEY = "sk-or-test-not-mock";
  process.env.RAG_EMBED_PROVIDER = "openrouter";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.SENTRY_DSN = "https://public@sentry.example/1";
  process.env.EMBED_CIRCUIT_BREAKER = "0";
  process.env.RAG_VECTOR_READ_BACKEND = "pinecone";
  process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "0";
  delete process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES;
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ dimension: 3, metric: "cosine" });
  mocks.upsert.mockResolvedValue({});
  mocks.query.mockResolvedValue({ matches: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ingest embed provider timeout (ST-4607)", () => {
  it("recognizes provider timeout text and keeps ECONNREFUSED out of that class", () => {
    expect(isRagEmbedProviderTimeout(providerTimeout())).toBe(true);
    expect(isRagEmbedProviderTimeoutText(`embed documents: ${RAG_EMBED_PROVIDER_TIMEOUT_MESSAGE}`)).toBe(true);
    expect(isRagEmbedProviderTimeoutText("embed documents: UND_ERR_CONNECT_TIMEOUT connect timeout")).toBe(true);
    expect(isRagEmbedProviderTimeout(econnrefused())).toBe(false);
    expect(isRagEmbedProviderTimeoutText("embed documents: connect ECONNREFUSED")).toBe(false);
  });

  it("does not file a provider embed timeout as connection failed or hard", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previousNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "development";
    vi.stubGlobal("fetch", async () => {
      throw providerTimeout();
    });
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
    const notifications = await import("../src/lib/notifications");
    const send = vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);
    await vi.waitFor(() => {
      expect(messages()).toContain("RAG embed timed out");
    });
    expect(messages().some((message) => /connection failed/i.test(message))).toBe(false);
    expect(mocks.levels.every((level) => level === "warning")).toBe(true);
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "timeout")).toBe(true);
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "hard")).toBe(false);
    expect(send.mock.calls.some((call) => JSON.stringify(call).includes("connection failed"))).toBe(false);

    const { getDb } = await import("../src/lib/db");
    const { connectionHealthFailureClass, isSoftHealthFailure } = await import("../src/lib/db-health");
    const row = getDb().prepare(
      `SELECT error_text FROM api_health_log WHERE service = 'rag-embed' AND ok = 0 ORDER BY rowid DESC LIMIT 1`
    ).get() as { error_text: string } | undefined;
    expect(row?.error_text).toBeTruthy();
    expect(isSoftHealthFailure(row?.error_text)).toBe(true);
    expect(connectionHealthFailureClass(row?.error_text)).toBe("timeout");
    env.NODE_ENV = previousNodeEnv;
  });

  it("escalates to error after the timeout streak outlasts the escalation window", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previousNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "development";
    process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES = "0";
    await insertAgedEmbedTimeoutFailure(15);
    vi.stubGlobal("fetch", async () => {
      throw providerTimeout();
    });
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
  const notifications = await import("../src/lib/notifications");
    const send = vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: "MSFT 8-K details", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);
    await vi.waitFor(() => {
      expect(mocks.levels).toContain("error");
    });
    expect(messages()).toContain("RAG embed timed out");
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "timeout")).toBe(true);
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "hard")).toBe(false);
    expect(send).toHaveBeenCalled();
    env.NODE_ENV = previousNodeEnv;
  });

  it("still classifies ECONNREFUSED on embed documents as a hard connection failure", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previousNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "development";
    process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES = "0";
    vi.stubGlobal("fetch", async () => {
      throw econnrefused();
    });
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
    const notifications = await import("../src/lib/notifications");
    vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
    ]);
    await vi.waitFor(() => {
      expect(messages().some((message) => /connection failed/i.test(message))).toBe(true);
    });
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "hard")).toBe(true);
    expect(messages()).not.toContain("RAG embed timed out");
    env.NODE_ENV = previousNodeEnv;
  });

  it("does not start another embed attempt after TimeoutError or caller abort", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previousNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "development";
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "2";
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
    let embedFetches = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/embeddings")) {
        embedFetches += 1;
        throw providerTimeout();
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const { storeContexts } = await import("../src/lib/vector-db");
      await storeContexts([
        { text: "AAPL 8-K details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18" } }
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(embedFetches).toBe(1);
      const retryLogs = warn.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("retrying"));
      expect(retryLogs).toEqual([]);
    } finally {
      warn.mockRestore();
      env.NODE_ENV = previousNodeEnv;
    }
  });
});
