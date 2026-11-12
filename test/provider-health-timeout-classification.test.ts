// ST-4608: a provider wait that expires on a keyless or global lane must be recorded as a
// transport blip, not paged as a hard "<service> connection failed".
//
// Prod: SOCRATIC-TRADE-3K / -3M logged "Nasdaq delayed screener timed out waiting for
// api.nasdaq.com." with failureClass hard. AbortError, TimeoutError, and undici
// UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT took the same path. HTTP 401/403/5xx stay
// hard. A caller-budget abort that does not name the error stays an expected limit.
// A timeout streak that outlasts HEALTH_TRANSIENT_ESCALATION_MS escalates once, same as ST-3079.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { NASDAQ_SCREENER_TIMEOUT_MESSAGE } from "../src/lib/nasdaq-screener-fetch";

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

// Suite-wide env, restored in afterAll so later files in the same worker see the originals.
const suiteEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-provider-timeout-health-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

afterAll(() => {
  restoreEnv("DATABASE_URL", suiteEnv.DATABASE_URL);
  restoreEnv("ENCRYPTION_KEY", suiteEnv.ENCRYPTION_KEY);
});

async function db() {
  return import("../src/lib/db");
}

function capturedLevels(): string[] {
  return sentry.setLevel.mock.calls.map((c) => String(c[0]));
}

function capturedTag(name: string): string | undefined {
  const hit = sentry.setTag.mock.calls.find((c) => c[0] === name);
  return hit ? String(hit[1]) : undefined;
}

async function newestErrorText(service: string): Promise<string | null> {
  const { getDb } = await db();
  const row = getDb()
    .prepare(`SELECT error_text FROM api_health_log WHERE service = ? ORDER BY ts DESC, rowid DESC LIMIT 1`)
    .get(service) as { error_text: string | null } | undefined;
  return row?.error_text ?? null;
}

async function insertAgedFailure(service: string, errorText: string, minutesAgo: number, keySource: string | null = null): Promise<void> {
  const { getDb } = await db();
  getDb()
    .prepare(
      `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
       VALUES (?, ?, ?, 0, NULL, ?, ?, NULL)`
    )
    .run(randomUUID(), service, new Date(Date.now() - minutesAgo * 60_000).toISOString(), errorText, keySource);
}

async function settleAlerts(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let sendNotification: MockInstance;

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
  // Per-test env goes through vi.stubEnv; afterEach unstubs it back to the original values.
  vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
  vi.stubEnv("RESEND_API_KEY", undefined);
  vi.stubEnv("PUSHOVER_TOKEN", undefined);
  vi.stubEnv("HEALTH_TRANSIENT_ESCALATION_MINUTES", undefined);
  const notifications = await import("../src/lib/notifications");
  sendNotification = vi.spyOn(notifications, "sendNotification").mockResolvedValue({} as never);
  const { getDb } = await db();
  for (const table of ["api_health_log", "api_health_error_patterns", "audit_events", "settings", "notification_events"]) {
    getDb().prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(async () => {
  await settleAlerts();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("provider timeout classification (ST-4608)", () => {
  it("classifies named timeouts as transient and leaves HTTP failures hard", async () => {
    const {
      isTransientHealthFailure,
      isSoftHealthFailure,
      isProviderTimeoutHealthText,
      connectionHealthFailureClass,
      HEALTH_SOFT_FAILURE_PREFIX
    } = await import("../src/lib/db-health");
    const transient = [
      NASDAQ_SCREENER_TIMEOUT_MESSAGE,
      "AbortError: The operation was aborted",
      "TimeoutError: The operation was aborted due to timeout",
      "HeadersTimeoutError [UND_ERR_HEADERS_TIMEOUT]: Headers Timeout Error",
      "BodyTimeoutError [UND_ERR_BODY_TIMEOUT]: Body Timeout Error",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "Alpaca broker call timed out",
      "Timed out waiting for alpaca.getAccount after 16000+8000ms."
    ];
    for (const text of transient) {
      expect(isTransientHealthFailure(text), text).toBe(true);
      expect(isSoftHealthFailure(text), text).toBe(false);
      expect(connectionHealthFailureClass(text), text).toBe("transient-network");
    }
    for (const text of ["HTTP 401 Unauthorized", "HTTP 403 not entitled", "HTTP 500", "HTTP 502 Bad Gateway"]) {
      expect(isTransientHealthFailure(text), text).toBe(false);
      expect(isSoftHealthFailure(text), text).toBe(false);
      expect(connectionHealthFailureClass(text), text).toBeNull();
    }
    expect(isTransientHealthFailure("HTTP 500 timed out waiting for upstream")).toBe(false);
    // A provider status without the "HTTP" prefix (embed/rerank format) stays hard too.
    for (const text of [
      "Embedding API failed (isOpenRouter=true): 503 upstream timed out waiting for model",
      "Rerank API failed: 500 timed out waiting for worker"
    ]) {
      expect(isProviderTimeoutHealthText(text), text).toBe(false);
      expect(isTransientHealthFailure(text), text).toBe(false);
      expect(isSoftHealthFailure(text), text).toBe(false);
    }
    // An explicit soft stamp wins over a named timeout: legacy rows stay soft.
    for (const text of [
      `${HEALTH_SOFT_FAILURE_PREFIX}TimeoutError: The operation was aborted due to timeout`,
      `${HEALTH_SOFT_FAILURE_PREFIX}AbortError: The operation was aborted`,
      `${HEALTH_SOFT_FAILURE_PREFIX}${NASDAQ_SCREENER_TIMEOUT_MESSAGE}`
    ]) {
      expect(isSoftHealthFailure(text), text).toBe(true);
    }
    // Caller-budget aborts that do not name the error stay soft: the message-only
    // AbortSignal.timeout() text and the /api/quote cascade's own abort reasons.
    for (const text of ["The operation was aborted due to timeout", "cascade budget elapsed", "yahoo floor ready"]) {
      expect(isProviderTimeoutHealthText(text), text).toBe(false);
      expect(isSoftHealthFailure(text), text).toBe(true);
      expect(isTransientHealthFailure(text), text).toBe(false);
    }
    expect(isSoftHealthFailure("HTTP 429 timed out waiting for quota")).toBe(true);
    expect(isTransientHealthFailure("HTTP 429 timed out waiting for quota")).toBe(false);
    expect(isSoftHealthFailure("This operation was aborted")).toBe(true);
    expect(isTransientHealthFailure("This operation was aborted")).toBe(false);
    expect(connectionHealthFailureClass("strategy RAG retrieval timed out")).toBe("timeout");
    // ST-4607: ingest embed timeouts stay timeout/soft after describeNetworkError prefixes TimeoutError.
    const embedTimeout = "embed documents: TimeoutError embed provider timed out";
    expect(isSoftHealthFailure(embedTimeout)).toBe(true);
    expect(isTransientHealthFailure(embedTimeout)).toBe(false);
    expect(connectionHealthFailureClass(embedTimeout)).toBe("timeout");
  });

  it("records a keyless timeout burst as warning with the short transient cooldown and no operator push", async () => {
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES, HEALTH_TRANSIENT_FAILURE_PREFIX } =
      await import("../src/lib/db-health");
    const { getInternalSetting } = await import("../src/lib/db");
    const service = "nasdaq-delayed-screener";
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: NASDAQ_SCREENER_TIMEOUT_MESSAGE, soft: true });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    expect(capturedLevels()).toEqual(["warning"]);
    expect(capturedTag("health.failure_class")).toBe("transient-network");
    expect(capturedTag("health.service")).toBe(service);
    expect(capturedTag("health.key_source")).toBe("none");
    expect(sentry.captureMessage).toHaveBeenCalledWith(`${service} connection failed`);
    expect(await newestErrorText(service)).toBe(`${HEALTH_TRANSIENT_FAILURE_PREFIX}${NASDAQ_SCREENER_TIMEOUT_MESSAGE}`);
    expect(getLaneHealth(service, null).reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(getLaneHealth(service, null).transientStreak).toBe(true);
    expect(getInternalSetting<string>(`healthAlertSent:${service}:none:transient`)).toBeTruthy();
    expect(getInternalSetting<string>(`healthAlertSent:${service}:none`)).toBeFalsy();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("escalates a sustained timeout streak to error once", async () => {
    const { logApiHealth, HEALTH_TRANSIENT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    const service = "congress-nasdaq-screener";
    const { getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await import("../src/lib/db-health");
    for (let i = 0; i < 4; i++) {
      await insertAgedFailure(service, `${HEALTH_TRANSIENT_FAILURE_PREFIX}${NASDAQ_SCREENER_TIMEOUT_MESSAGE}`, 60 + i);
    }
    logApiHealth({ service, ok: false, errorText: NASDAQ_SCREENER_TIMEOUT_MESSAGE });
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    // Control: the triggering row was classified as a timeout blip, so the five-row run is
    // entirely transient. Under the old classifier it was hard and the error came from that.
    expect(await newestErrorText(service)).toBe(`${HEALTH_TRANSIENT_FAILURE_PREFIX}${NASDAQ_SCREENER_TIMEOUT_MESSAGE}`);
    const lane = getLaneHealth(service, null);
    expect(lane.reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(lane.transientStreak).toBe(true);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(capturedLevels()).toEqual(["error"]);
    expect(capturedTag("health.failure_class")).toBe("hard");
    expect(sendNotification).toHaveBeenCalled();
  });

  it("does not escalate the same transient streak before the escalation window", async () => {
    // Control for the test above: the same five transient rows, but recent, stay a warning.
    // So the error there comes from the age of the streak, not from the rows being hard.
    const { logApiHealth, getLaneHealth, HEALTH_TRANSIENT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    const service = "congress-nasdaq-screener-recent";
    for (let i = 0; i < 4; i++) {
      await insertAgedFailure(service, `${HEALTH_TRANSIENT_FAILURE_PREFIX}${NASDAQ_SCREENER_TIMEOUT_MESSAGE}`, 1);
    }
    logApiHealth({ service, ok: false, errorText: NASDAQ_SCREENER_TIMEOUT_MESSAGE });
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    expect(getLaneHealth(service, null).transientStreak).toBe(true);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(capturedLevels()).toEqual(["warning"]);
    expect(capturedTag("health.failure_class")).toBe("transient-network");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("keeps quote-cascade and AbortSignal.timeout budget cancels soft so they never page", async () => {
    const { logApiHealth, getLaneHealth, HEALTH_SOFT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    for (const errorText of ["cascade budget elapsed", "yahoo floor ready", "The operation was aborted due to timeout"]) {
      const service = `quote-budget-${randomUUID().slice(0, 8)}`;
      // One recent success keeps the "no success ever" heuristic from stopping a soft lane.
      // The five failures are written with keySource "env". Reading null would miss them
      // and report stoppedWorking false even if these rows were hard.
      logApiHealth({ service, ok: true, keySource: "env" });
      for (let i = 0; i < 5; i++) {
        logApiHealth({ service, ok: false, errorText, keySource: "env" });
      }
      await settleAlerts();
      expect(await newestErrorText(service), errorText).toBe(`${HEALTH_SOFT_FAILURE_PREFIX}${errorText}`);
      const lane = getLaneHealth(service, "env");
      expect(lane.lastFailureTs, errorText).toBeTruthy();
      expect(lane.reason, errorText).toBeNull();
      expect(lane.stoppedWorking, errorText).toBe(false);
    }
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("keeps HTTP 401 and HTTP 500 hard on a global lane", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    for (const errorText of ["HTTP 401 Unauthorized", "HTTP 500"]) {
      vi.clearAllMocks();
      sentry.withScope.mockImplementation((cb: (scope: unknown) => void) =>
        cb({
          setLevel: sentry.setLevel,
          setTag: sentry.setTag,
          setContext: sentry.setContext,
          setFingerprint: sentry.setFingerprint
        })
      );
      const service = `hard-${errorText.slice(5, 8)}-${randomUUID().slice(0, 8)}`;
      for (let i = 0; i < 5; i++) {
        logApiHealth({ service, ok: false, errorText, keySource: "env" });
      }
      await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
      await settleAlerts();
      expect(capturedLevels(), errorText).toEqual(["error"]);
      expect(capturedTag("health.failure_class"), errorText).toBe("hard");
    }
  });

  it("keeps a per-user credential failure hard, and treats that lane's timeouts as transient", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    const userId = "user-timeout";
    const timeoutLane = `finnhub-user-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({
        service: timeoutLane,
        ok: false,
        errorText: "TimeoutError: The operation was aborted due to timeout",
        keySource: "user",
        userId
      });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toEqual(["warning"]);
    expect(capturedTag("health.failure_class")).toBe("transient-network");
    expect(capturedTag("health.key_source")).toBe("user");
    expect(sendNotification).not.toHaveBeenCalled();

    vi.clearAllMocks();
    sentry.withScope.mockImplementation((cb: (scope: unknown) => void) =>
      cb({
        setLevel: sentry.setLevel,
        setTag: sentry.setTag,
        setContext: sentry.setContext,
        setFingerprint: sentry.setFingerprint
      })
    );
    const authLane = `alpaca-user-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({
        service: authLane,
        ok: false,
        errorText: "HTTP 401 Unauthorized",
        keySource: "user",
        userId
      });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toEqual(["warning"]);
    expect(capturedTag("health.failure_class")).toBe("hard");
    expect(sendNotification).toHaveBeenCalled();
  });
});
