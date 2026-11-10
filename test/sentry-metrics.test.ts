import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMock = vi.hoisted(() => ({
  metrics: {
    count: vi.fn(),
    distribution: vi.fn()
  },
  logger: {
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock("@sentry/nextjs", () => sentryMock);

import {
  logError,
  logWarn,
  recordBrokerCall,
  recordEmbedFailure,
  recordRagRejection,
  recordSchedulerTick
} from "../src/lib/sentry-metrics";

describe("sentry-metrics helpers", () => {
  beforeEach(() => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    sentryMock.metrics.count.mockReset();
    sentryMock.metrics.distribution.mockReset();
    sentryMock.logger.warn.mockReset();
    sentryMock.logger.error.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records scheduler.tick and scheduler.overrun together", async () => {
    recordSchedulerTick("overrun", 75_000);
    await vi.waitFor(() => {
      expect(sentryMock.metrics.count).toHaveBeenCalledWith("scheduler.tick", 1, {
        attributes: { status: "overrun" }
      });
    });
    expect(sentryMock.metrics.count).toHaveBeenCalledWith("scheduler.overrun", 1);
    expect(sentryMock.metrics.distribution).toHaveBeenCalledWith(
      "scheduler.duration_ms",
      75_000,
      expect.objectContaining({ unit: "millisecond" })
    );
  });

  it("records broker.call duration on failure", async () => {
    recordBrokerCall("kalshi", "GET /portfolio/positions", 12, "failure");
    await vi.waitFor(() => {
      expect(sentryMock.metrics.count).toHaveBeenCalledWith("broker.call", 1, {
        attributes: { broker: "kalshi", endpoint: "GET /portfolio/positions", status: "failure" }
      });
    });
  });

  it("records rag.rejected and embed.failed", async () => {
    recordRagRejection("malformed_query_embedding", "voyage");
    recordEmbedFailure("openrouter", "embed-api-failed");
    await vi.waitFor(() => {
      expect(sentryMock.metrics.count).toHaveBeenCalledWith("rag.rejected", 1, {
        attributes: { reason: "malformed_query_embedding", provider: "voyage" }
      });
    });
    expect(sentryMock.metrics.count).toHaveBeenCalledWith("embed.failed", 1, {
      attributes: { provider: "openrouter", error_type: "embed-api-failed" }
    });
  });

  it("emits sparse structured logs without throwing", async () => {
    logWarn("rag.rejected", { provider: "voyage", reason: "malformed" });
    logError("broker.call", { broker: "alpaca", endpoint: "mcp:get_orders" });
    await vi.waitFor(() => {
      expect(sentryMock.logger.warn).toHaveBeenCalledWith("rag.rejected", {
        provider: "voyage",
        reason: "malformed"
      });
    });
    expect(sentryMock.logger.error).toHaveBeenCalledWith("broker.call", {
      broker: "alpaca",
      endpoint: "mcp:get_orders"
    });
  });

  it("does not throw when the SDK methods throw", async () => {
    sentryMock.metrics.count.mockImplementation(() => {
      throw new Error("metrics down");
    });
    expect(() => recordSchedulerTick("ok", 10)).not.toThrow();
    await Promise.resolve();
  });
});
