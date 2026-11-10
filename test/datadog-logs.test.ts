import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDatadogLog,
  emitDatadogRequestError,
  flushDatadogLogs,
  startDatadogLogShipping
} from "../src/lib/datadog-logs";

const DD_ENV_KEYS = [
  "DD_API_KEY",
  "DATADOG_API_KEY",
  "DD_SITE",
  "DD_SERVICE",
  "DD_ENV",
  "DD_VERSION",
  "DD_LOGS_ENABLED",
  "DD_LOGS_MIN_LEVEL",
  "DD_HOSTNAME"
] as const;

const saved = new Map<string, string | undefined>();

function clearDatadogEnv() {
  for (const key of DD_ENV_KEYS) delete process.env[key];
}

const originalWarn = console.warn;
const originalError = console.error;

function resetLogGlobals() {
  globalThis.__tradingDatadogLogsStarted = undefined;
  globalThis.__tradingDatadogLogQueue = undefined;
  globalThis.__tradingDatadogConsoleWrapped = undefined;
  if (globalThis.__tradingDatadogLogTimer) {
    clearTimeout(globalThis.__tradingDatadogLogTimer);
    globalThis.__tradingDatadogLogTimer = undefined;
  }
  console.warn = originalWarn;
  console.error = originalError;
}

beforeEach(() => {
  saved.clear();
  for (const key of DD_ENV_KEYS) saved.set(key, process.env[key]);
  clearDatadogEnv();
  resetLogGlobals();
});

afterEach(() => {
  resetLogGlobals();
  clearDatadogEnv();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("datadog log shipping", () => {
  it("is a no-op without an API key and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    emitDatadogLog("error", "should not ship");
    await flushDatadogLogs();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(globalThis.__tradingDatadogLogQueue).toBeUndefined();
  });

  it("posts a redacted warn/error batch to the us5 HTTP intake", async () => {
    process.env.DD_API_KEY = "unit-test-dd-key";
    process.env.DD_SERVICE = "socratic-trade";
    process.env.DD_ENV = "test";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    emitDatadogLog("error", "broker rejected", { apiKey: "sk-should-redact", path: "/api/orders" });
    await flushDatadogLogs();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    expect((init.headers as Record<string, string>)["DD-API-KEY"]).toBe("unit-test-dd-key");
    const body = JSON.parse(String(init.body)) as Array<{ message: string; status: string; service: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("error");
    expect(body[0].service).toBe("socratic-trade");
    expect(body[0].message).toContain("broker rejected");
    expect(body[0].message).toContain("[redacted]");
    expect(body[0].message).not.toContain("sk-should-redact");
  });

  it("skips /api/live and /api/health request errors so probes stay quiet", async () => {
    process.env.DD_API_KEY = "unit-test-dd-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    emitDatadogRequestError(new Error("live probe"), { path: "/api/live", method: "GET" });
    emitDatadogRequestError(new Error("health probe"), { path: "/api/health", method: "GET" });
    await flushDatadogLogs();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps console.warn/error without throwing when intake fails", async () => {
    process.env.DD_API_KEY = "unit-test-dd-key";
    const fetchMock = vi.fn().mockRejectedValue(new Error("intake down"));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    startDatadogLogShipping();
    expect(() => console.warn("wrapped warn")).not.toThrow();
    expect(() => console.error("wrapped error")).not.toThrow();
    await flushDatadogLogs();
    expect(warn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });
});
