/**
 * ST-4601: a strategy-run retrieval deadline is a caller timeout, not an OpenRouter or
 * Qdrant outage. A real socket reset stays a hard connection failure once the blip window
 * has elapsed.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markDeadlineTimeout } from "../src/lib/inflight-deadline";
import {
  STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE,
  isStrategyRagRetrievalTimeout
} from "../src/lib/rag-retrieval-deadline";
import { pinRagQualityFlagsOff } from "./rag-test-env";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const index = vi.fn(() => ({ query, upsert: vi.fn() }));
  const tags: Array<Record<string, string>> = [];
  const fingerprints: string[][] = [];
  const levels: string[] = [];
  return {
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    rerank: vi.fn(),
    captureMessage: vi.fn(),
    tags,
    fingerprints,
    levels,
    withScope: vi.fn((callback: (scope: {
      setLevel: (level: string) => void;
      setTag: (key: string, value: string) => void;
      setContext: (key: string, value: unknown) => void;
      setFingerprint: (value: string[]) => void;
    }) => void) => {
      const tag: Record<string, string> = {};
      tags.push(tag);
      callback({
        setLevel: (level) => {
          levels.push(level);
        },
        setTag: (key, value) => {
          tag[key] = value;
        },
        setContext: () => undefined,
        setFingerprint: (value) => {
          fingerprints.push(value);
        }
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

function deadlineError(): Error {
  return markDeadlineTimeout(new Error(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE));
}

function econnreset(): Error {
  const error = new Error("read ECONNRESET");
  (error as Error & { cause?: { code: string } }).cause = { code: "ECONNRESET" };
  return error;
}

function messages(): string[] {
  return mocks.captureMessage.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  mocks.tags.length = 0;
  mocks.fingerprints.length = 0;
  mocks.levels.length = 0;
  const cooldown = (globalThis as { __socraticRagSentryLastSentAt?: Map<string, number> }).__socraticRagSentryLastSentAt;
  cooldown?.clear();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `rag-deadline-${randomUUID()}.db`)}`;
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.OPENROUTER_API_KEY = "sk-or-test-not-mock";
  process.env.RAG_EMBED_PROVIDER = "openrouter";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.SENTRY_DSN = "https://public@sentry.example/1";
  process.env.EMBED_CIRCUIT_BREAKER = "0";
  process.env.RAG_VECTOR_READ_BACKEND = "pinecone";
  delete process.env.QDRANT_URL;
  delete process.env.QDRANT_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  delete process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES;
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ dimension: 3, metric: "cosine" });
  mocks.query.mockResolvedValue({ matches: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("strategy RAG deadline classification (ST-4601)", () => {
  it("recognizes a wrapped deadline and keeps a socket reset out of that class", async () => {
    const { connectionHealthFailureClass, isSoftHealthFailure, HEALTH_CALLER_TIMEOUT_PREFIX } = await import("../src/lib/db-health");
    expect(isStrategyRagRetrievalTimeout(deadlineError())).toBe(true);
    expect(isStrategyRagRetrievalTimeout(new Error(`Error ${STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE}`))).toBe(true);
    expect(isStrategyRagRetrievalTimeout(econnreset())).toBe(false);
    expect(connectionHealthFailureClass(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE)).toBe("timeout");
    expect(connectionHealthFailureClass(`${HEALTH_CALLER_TIMEOUT_PREFIX}${STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE}`)).toBe("timeout");
    expect(isSoftHealthFailure(`${HEALTH_CALLER_TIMEOUT_PREFIX}${STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE}`)).toBe(true);
    expect(connectionHealthFailureClass("read ECONNRESET")).not.toBe("timeout");
    expect(isSoftHealthFailure("read ECONNRESET")).toBe(false);
  });

  it("does not file a deadline abort as a connection failure or a hard outage", async () => {
    mocks.embed.mockRejectedValue(deadlineError());
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
    const notifications = await import("../src/lib/notifications");
    const send = vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("AAPL catalysts", "AAPL", 2, "local");
    expect(chunks).toEqual([]);
    await vi.waitFor(() => {
      expect(messages().some((message) => message === "RAG retrieval timed out")).toBe(true);
    });
    expect(messages().some((message) => /connection failed/i.test(message))).toBe(false);
    expect(messages().some((message) => message === "RAG retrieval failed")).toBe(false);
    expect(mocks.levels.every((level) => level === "warning")).toBe(true);
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "hard")).toBe(false);
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "timeout")).toBe(true);
    expect(mocks.fingerprints).toContainEqual(["rag", "retrieval-timeout"]);
    expect(send.mock.calls.some((call) => JSON.stringify(call).includes("connection failed"))).toBe(false);

    const { getDb } = await import("../src/lib/db");
    const { isSoftHealthFailure, connectionHealthFailureClass } = await import("../src/lib/db-health");
    const row = getDb().prepare(
      `SELECT error_text FROM api_health_log WHERE service = 'rag-embed' AND ok = 0 ORDER BY rowid DESC LIMIT 1`
    ).get() as { error_text: string } | undefined;
    expect(row?.error_text).toBeTruthy();
    expect(isSoftHealthFailure(row?.error_text)).toBe(true);
    expect(connectionHealthFailureClass(row?.error_text)).toBe("timeout");
  });

  it("does not start another embed attempt after the caller aborts", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previousNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "development";
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "2";
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
    const caller = new AbortController();
    let embedFetches = 0;
    const started = Date.now();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/embeddings")) {
        embedFetches += 1;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        caller.abort(deadlineError());
        expect(init?.signal?.aborted).toBe(true);
        throw econnreset();
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const { retrieveContextDetailed } = await import("../src/lib/vector-db");
      const chunks = await retrieveContextDetailed("AAPL catalysts", "AAPL", 2, "local", { signal: caller.signal });
      expect(chunks).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(embedFetches).toBe(1);
      expect(caller.signal.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      const retryLogs = warn.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("retrying"));
      expect(retryLogs).toEqual([]);
    } finally {
      warn.mockRestore();
      env.NODE_ENV = previousNodeEnv;
    }
  });

  it("still classifies a fresh ECONNRESET as a hard connection failure outside the blip window", async () => {
    process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES = "0";
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "0";
    mocks.embed.mockRejectedValue(econnreset());
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "sk-or-test-not-mock", "test fixture");
    upsertUserApiKey("local", "pinecone", "pinecone-test", "test fixture");
    const notifications = await import("../src/lib/notifications");
    vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    await retrieveContextDetailed("AAPL catalysts", "AAPL", 2, "local");
    await vi.waitFor(() => {
      expect(messages().some((message) => /connection failed/i.test(message))).toBe(true);
    });
    const hard = mocks.tags.find((tag) => tag["health.failure_class"] === "hard");
    expect(hard).toBeTruthy();
    expect(mocks.tags.some((tag) => tag["health.failure_class"] === "timeout")).toBe(false);
    expect(messages().some((message) => message === "RAG retrieval timed out")).toBe(false);
    expect(mocks.levels).toContain("error");
  });
});
