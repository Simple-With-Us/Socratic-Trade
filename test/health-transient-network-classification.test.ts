// A transport blip must be RECORDED, not PAGED — and a real outage must still page.
//
// Prod symptom (Sentry cluster, 2026-08-13 → 2026-09-08): a dozen issues titled
// "<service> connection failed" across a dozen unrelated integrations (OpenRouter embed/rerank,
// alpaca-account-insights, congress.trade, Massive, Usage-Monitor, congress-share, ROIC,
// nasdaq-calendar, Polymarket, Tradier, VIX/Yahoo).  Two of them paged PagerDuty (#108 roic,
// #112 congress-share).  The common thread was never a vendor: Node's `fetch()` collapses a dead
// keep-alive socket, a DNS hiccup, or an `ECONNRESET` into a bare `"fetch failed"` whose real
// reason hides on `err.cause`, and that bare string matched none of db-health's soft-failure
// shapes.  So a burst lane that fired five requests seconds apart during one upstream hiccup
// produced five consecutive HARD failures and paged as a full outage.
//
// The fix is a THIRD failure class between "expected limit" and "hard": a transport blip still
// counts toward the hard consecutive-failure streak (a provider that is genuinely unreachable
// must still page) but is captured at Sentry `warning` until the same unbroken streak has kept
// failing for the escalation window.
//
// The discriminating half of this suite is the NEGATIVE side, and it is the half that matters:
// an HTTP 500 outage must still capture at `error`, a transport streak that HAS lasted the
// window must escalate to `error`, and a transient row must NOT be excluded from the streak the
// way an expected-limit row is.  A "fix" that quieted the noise by quieting everything would be
// strictly worse than the bug it replaces.
//
// Hermetic: real module graph against a temp SQLite DB; only the Sentry SDK is stubbed.

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

// ONE database for the whole file — `logApiHealth` fires its alert as a DETACHED promise, so
// closing and reopening the connection between cases would race that promise into "The database
// connection is not open".  Tables are truncated between cases instead.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-transient-health-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

async function db() {
  return import("../src/lib/db");
}

/** Levels passed to Sentry for every capture this case produced, in order. */
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

/** Insert an aged failure row straight into the log so a streak can be older than the window. */
async function insertAgedFailure(service: string, errorText: string, minutesAgo: number): Promise<void> {
  const { getDb } = await db();
  getDb()
    .prepare(
      `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
       VALUES (?, ?, ?, 0, NULL, ?, 'env', NULL)`
    )
    .run(randomUUID(), service, new Date(Date.now() - minutesAgo * 60_000).toISOString(), errorText);
}

/** Insert an aged success so a later failure run has a real "first failure after success" boundary. */
async function insertAgedSuccess(service: string, minutesAgo: number): Promise<void> {
  const { getDb } = await db();
  getDb()
    .prepare(
      `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
       VALUES (?, ?, ?, 1, 10, NULL, 'env', NULL)`
    )
    .run(randomUUID(), service, new Date(Date.now() - minutesAgo * 60_000).toISOString());
}

/**
 * The alert is a detached promise whose first step is a dynamic `import`.  Give it real time so a
 * NEGATIVE assertion ("never captured at error") means something rather than merely being early.
 */
async function settleAlerts(ms = 250): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
  delete process.env.RESEND_API_KEY;
  delete process.env.PUSHOVER_TOKEN;
  delete process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES;
  const { getDb } = await db();
  for (const table of ["api_health_log", "api_health_error_patterns", "audit_events", "settings", "notification_events"]) {
    getDb().prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(async () => {
  await settleAlerts();
  delete process.env.SENTRY_DSN;
  delete process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES;
});

describe("transport-blip classification", () => {
  it("recognizes the Node/undici shapes that hide behind a bare 'fetch failed'", async () => {
    const { isTransientHealthFailure } = await import("../src/lib/db-health");
    for (const text of [
      "fetch failed",
      "TypeError: fetch failed (cause: SocketError: other side closed UND_ERR_SOCKET)",
      "getaddrinfo EAI_AGAIN api.example.test",
      "connect ECONNREFUSED 10.0.0.1:443",
      "read ECONNRESET",
      "connect ETIMEDOUT",
      "getaddrinfo ENOTFOUND api.example.test",
      "socket hang up"
    ]) {
      expect(isTransientHealthFailure(text), text).toBe(true);
    }
  });

  it("leaves provider-side and auth failures hard", async () => {
    const { isTransientHealthFailure } = await import("../src/lib/db-health");
    for (const text of [
      "HTTP 500",
      "HTTP 502 Bad Gateway",
      "HTTP 401 Unauthorized",
      "HTTP 403 not entitled",
      "Invalid API key",
      ""
    ]) {
      expect(isTransientHealthFailure(text), text).toBe(false);
    }
  });

  it("never reclassifies an expected limit, a caller abort, or our own SQLite fault", async () => {
    const { isTransientHealthFailure, HEALTH_SOFT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    // Soft wins: a 429 keeps its existing "does not count toward the streak at all" treatment
    // rather than being promoted into it.
    expect(isTransientHealthFailure(`${HEALTH_SOFT_FAILURE_PREFIX}HTTP 429`)).toBe(false);
    expect(isTransientHealthFailure("HTTP 429 too many requests")).toBe(false);
    expect(isTransientHealthFailure("This operation was aborted")).toBe(false);
    // "database is locked" is SQLITE_BUSY from our own file — never a vendor's transport.
    expect(isTransientHealthFailure("inventory fetch: database is locked")).toBe(false);
  });

  // `isTransientNetworkErrorText` is the shared source of truth: db-health classifies an
  // already-stringified `error_text` row with it, and vector-db's `alertRagConnectionFailure`
  // uses it to keep a dead socket off `error` level on the RAG lanes (SOCRATIC-TRADE-1X / -22).
  it("shares one transport classifier between the health store and the RAG lane", async () => {
    const { isTransientNetworkErrorText, isTransientNetworkError } = await import("../src/lib/network-errors");
    for (const text of [
      "embed documents: TypeError: fetch failed",
      "embed documents: read ECONNRESET",
      "rerank: getaddrinfo EAI_AGAIN openrouter.ai",
      "rerank: getaddrinfo ENOTFOUND openrouter.ai",
      "embed documents: connect ETIMEDOUT 104.18.0.1:443",
      "embed documents: socket hang up",
      "embed documents: SocketError: other side closed"
    ]) {
      expect(isTransientNetworkErrorText(text), text).toBe(true);
    }
    for (const text of [
      "embed documents: HTTP 400 invalid input",
      "embed documents: HTTP 401 Unauthorized",
      "HTTP 500 fetch failed while upstream said ECONNRESET",
      "HTTP 502 Bad Gateway: socket hang up in body",
      "congress-share: HTTP 401 Unauthorized fetch failed",
      "",
      null,
      undefined
    ]) {
      expect(isTransientNetworkErrorText(text), String(text)).toBe(false);
    }
    // The error-object classifier must agree with the text one, `cause` included.
    const socket = new TypeError("fetch failed");
    (socket as Error & { cause?: Error }).cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    expect(isTransientNetworkError(socket)).toBe(true);
    expect(isTransientNetworkError(new Error("HTTP 500"))).toBe(false);
  });

  it("reads the escalation window from env without treating a blank var as zero", async () => {
    const { transientEscalationWindowMs, HEALTH_TRANSIENT_ESCALATION_MS } = await import("../src/lib/db-health");
    expect(transientEscalationWindowMs({})).toBe(HEALTH_TRANSIENT_ESCALATION_MS);
    // `Number("")` is 0 — a blank var must NOT silently mean "escalate every blip immediately".
    expect(transientEscalationWindowMs({ HEALTH_TRANSIENT_ESCALATION_MINUTES: "" })).toBe(HEALTH_TRANSIENT_ESCALATION_MS);
    expect(transientEscalationWindowMs({ HEALTH_TRANSIENT_ESCALATION_MINUTES: "   " })).toBe(HEALTH_TRANSIENT_ESCALATION_MS);
    expect(transientEscalationWindowMs({ HEALTH_TRANSIENT_ESCALATION_MINUTES: "nonsense" })).toBe(HEALTH_TRANSIENT_ESCALATION_MS);
    expect(transientEscalationWindowMs({ HEALTH_TRANSIENT_ESCALATION_MINUTES: "-5" })).toBe(HEALTH_TRANSIENT_ESCALATION_MS);
    expect(transientEscalationWindowMs({ HEALTH_TRANSIENT_ESCALATION_MINUTES: "0" })).toBe(0);
    expect(transientEscalationWindowMs({ HEALTH_TRANSIENT_ESCALATION_MINUTES: "2" })).toBe(120_000);
  });

  it("keeps a transport blip counting toward the hard streak", async () => {
    // The whole safety argument rests on this: unlike an expected limit, a blip is still a
    // candidate outage, so it must NOT read as soft.
    const { isSoftHealthFailure, HEALTH_TRANSIENT_FAILURE_PREFIX } = await import("../src/lib/db-health");
    expect(isSoftHealthFailure(`${HEALTH_TRANSIENT_FAILURE_PREFIX}fetch failed`)).toBe(false);
    expect(isSoftHealthFailure("fetch failed")).toBe(false);
  });
});

describe("retry shaping", () => {
  it("bounds jitter to +/- 30% of the linear backoff and never returns a negative delay", async () => {
    const { jitteredBackoffMs, TRANSIENT_RETRY_JITTER_RATIO } = await import("../src/lib/network-errors");
    expect(TRANSIENT_RETRY_JITTER_RATIO).toBe(0.3);
    // Injected rng pins the bounds instead of asserting on a range.
    expect(jitteredBackoffMs(600, 0, () => 0)).toBe(420);
    expect(jitteredBackoffMs(600, 0, () => 1)).toBe(780);
    expect(jitteredBackoffMs(600, 1, () => 0.5)).toBe(1200);
    expect(jitteredBackoffMs(0, 3)).toBe(0);
    for (let i = 0; i < 200; i++) {
      const delay = jitteredBackoffMs(600, 0);
      expect(delay).toBeGreaterThanOrEqual(420);
      expect(delay).toBeLessThanOrEqual(780);
    }
  });

  it("replays read-only methods only, unless a caller opts a query-shaped POST in", async () => {
    const { isIdempotentRequest } = await import("../src/lib/network-errors");
    expect(isIdempotentRequest(undefined)).toBe(true); // fetch() defaults to GET
    expect(isIdempotentRequest({})).toBe(true);
    expect(isIdempotentRequest({ method: "get" })).toBe(true);
    expect(isIdempotentRequest({ method: "HEAD" })).toBe(true);
    expect(isIdempotentRequest({ method: "POST" })).toBe(false);
    expect(isIdempotentRequest({ method: "PUT" })).toBe(false);
    expect(isIdempotentRequest({ method: "DELETE" })).toBe(false);
  });
});

describe("blip vs outage at the alert gate", () => {
  it("captures a burst of transport blips at warning and stamps the failure class", async () => {
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES, HEALTH_TRANSIENT_FAILURE_PREFIX } =
      await import("../src/lib/db-health");
    const service = `blip-lane-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    expect(capturedLevels()).toContain("warning");
    expect(capturedLevels()).not.toContain("error");
    expect(capturedTag("health.failure_class")).toBe("transient-network");
    expect(await newestErrorText(service)).toMatch(
      new RegExp(`^${HEALTH_TRANSIENT_FAILURE_PREFIX.replace(/[[\]]/g, "\\$&")}`)
    );
    // Still a hard streak: the lane reads as stopped, the circuit breaker still trips, Admin
    // Connections still paints it red.  Only the PAGE is withheld.
    expect(getLaneHealth(service, "env").reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
  });

  it("escalates to error once the same streak has been failing past the window", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    const service = `outage-lane-${randomUUID().slice(0, 8)}`;
    // Four rows already an hour old: this is not a hiccup, the lane has been down all along.
    for (let i = 0; i < 4; i++) {
      await insertAgedFailure(service, "[transient-network] TypeError: fetch failed", 60 + i);
    }
    logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    expect(capturedLevels()).toContain("error");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });

  it("honours HEALTH_TRANSIENT_ESCALATION_MINUTES=0 as 'never hold a blip back'", async () => {
    process.env.HEALTH_TRANSIENT_ESCALATION_MINUTES = "0";
    const { logApiHealth } = await import("../src/lib/db-health");
    const service = `knob-lane-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "read ECONNRESET", keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("error");
  });

  it("still captures a real provider outage at error immediately", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    const service = `hard-lane-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "HTTP 502", keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    expect(capturedLevels()).toContain("error");
    expect(capturedLevels()).not.toContain("warning");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });

  it("still captures an auth outage at error — a 401 streak is not a transport blip", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    const service = `auth-lane-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "HTTP 401 Unauthorized", keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("error");
  });

  it("keeps a durable hard classification when FIFO drops the hard row", async () => {
    const { logApiHealth, getLaneHealth, hardStreakStartSettingKey, HEALTH_REASON_CONSECUTIVE_FAILURES } =
      await import("../src/lib/db-health");
    const { getDb } = await db();
    const service = `fifo-hard-${randomUUID().slice(0, 8)}`;
    const ancient = new Date(Date.now() - 45 * 60_000).toISOString();
    const key = hardStreakStartSettingKey(service, "env", null);
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(
        key,
        JSON.stringify({ startedTs: ancient, entirelyTransient: false }),
        new Date().toISOString()
      );
    // Retained log is all transport blips — without durable class this would look entirely-transient.
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    }
    const lane = getLaneHealth(service, "env");
    expect(lane.reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(lane.transientStreak).toBe(false);
    expect(lane.streakStartedTs).toBe(ancient);
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("error");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });

    it("keeps streakStartedTs from a durable setting when FIFO would advance it", async () => {
    // Codex P1: HEALTH_LOG_LANE_CAP FIFO can drop the true start; durable settings must win.
    const {
      logApiHealth,
      getLaneHealth,
      hardStreakStartSettingKey,
      HEALTH_HARD_STREAK_START_PREFIX
    } = await import("../src/lib/db-health");
    const { getDb } = await db();
    const service = `fifo-streak-${randomUUID().slice(0, 8)}`;
    const ancient = new Date(Date.now() - 45 * 60_000).toISOString();
    const key = hardStreakStartSettingKey(service, "env", null);
    expect(key.startsWith(HEALTH_HARD_STREAK_START_PREFIX)).toBe(true);
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(ancient), new Date().toISOString());
    // Retained log only has recent failures — walk would claim a ~2-minute start.
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    }
    const lane = getLaneHealth(service, "env");
    expect(lane.streakStartedTs).toBe(ancient);
    // Past the default 10-minute window → escalates to error (not stuck in warning forever).
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("error");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });

    it("does not treat a run as entirely-transient when a hard failure sits outside last-5", async () => {
    // Codex P2: transientStreak used to look at last-5 only. An HTTP 401 that aged past the
    // sample, followed by five socket errors, must still page as hard — not warning.
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await import("../src/lib/db-health");
    const service = `mixed-run-${randomUUID().slice(0, 8)}`;
    await insertAgedSuccess(service, 90);
    await insertAgedFailure(service, "HTTP 401 Unauthorized", 80);
    for (let i = 0; i < 4; i++) {
      await insertAgedFailure(service, "TypeError: fetch failed", 10 - i);
    }
    logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();

    const lane = getLaneHealth(service, "env");
    expect(lane.reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(lane.transientStreak).toBe(false);
    expect(capturedLevels()).toContain("error");
    expect(capturedLevels()).not.toContain("warning");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });

  it("does not alert at all before the streak — one blip is silent", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    const service = `single-blip-${randomUUID().slice(0, 8)}`;
    logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    await settleAlerts();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("rejects explicit HTTP-status errors even when the body contains transport phrases", async () => {
    const { isTransientNetworkErrorText, isTransientNetworkError } = await import("../src/lib/network-errors");
    expect(isTransientNetworkErrorText("HTTP 500 internal: fetch failed")).toBe(false);
    expect(isTransientNetworkErrorText("HTTP 401 Unauthorized — ECONNRESET in body")).toBe(false);
    expect(isTransientNetworkError(new Error("HTTP 502 Bad Gateway socket hang up"))).toBe(false);
  });

  it("anchors streakStartedTs to the full consecutive failure run, not only last-5", async () => {
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES, HEALTH_TRANSIENT_FAILURE_PREFIX } =
      await import("../src/lib/db-health");
    const service = `busy-lane-${randomUUID().slice(0, 8)}`;
    // Success first (50m ago), then a long unbroken hard-failure run from ~45m ago through now.
    // On a busy lane the last-5 sample is always recent; the escalation clock must still start at
    // the first failure after that success.
    await insertAgedSuccess(service, 50);
    await insertAgedFailure(service, `${HEALTH_TRANSIENT_FAILURE_PREFIX}TypeError: fetch failed`, 45);
    for (let i = 0; i < 8; i++) {
      await insertAgedFailure(service, `${HEALTH_TRANSIENT_FAILURE_PREFIX}TypeError: fetch failed`, 40 - i);
    }
    // Five more "recent" failures so last-5 is the newest sample only.
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    }
    const lane = getLaneHealth(service, "env");
    expect(lane.reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(lane.streakStartedTs).toBeTruthy();
    const ageMs = Date.now() - Date.parse(lane.streakStartedTs!);
    // Must reflect the ~45-minute-old start of the run, not the oldest of the last five (~seconds).
    expect(ageMs).toBeGreaterThan(30 * 60_000);
  });

  it("keeps PineconeBadRequestError hard even when body mentions ECONNRESET", async () => {
    const { isTransientNetworkError, isTransientNetworkErrorText, isPineconeHttpResponseError } =
      await import("../src/lib/network-errors");
    const err = new Error("Index dimension mismatch; prior attempt saw ECONNRESET in logs");
    err.name = "PineconeBadRequestError";
    expect(isPineconeHttpResponseError(err)).toBe(true);
    expect(isTransientNetworkError(err)).toBe(false);
    // Flattened describeNetworkError form used by ragErrorMessage / health rows.
    expect(
      isTransientNetworkErrorText(`PineconeBadRequestError Index dimension mismatch; prior attempt saw ECONNRESET in logs`)
    ).toBe(false);
  });

    it("classifies PineconeConnectionError when nested cause is fetch failed", async () => {
    const { isTransientNetworkError, describeNetworkError } = await import("../src/lib/network-errors");
    const inner = new TypeError("fetch failed");
    (inner as NodeJS.ErrnoException).code = "UND_ERR_SOCKET";
    const outer = new Error("Request failed to reach Pinecone: Unable to complete REST request");
    outer.name = "PineconeConnectionError";
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(describeNetworkError(outer)).toMatch(/fetch failed/i);
    expect(isTransientNetworkError(outer)).toBe(true);
    // Display-only outer message alone must not be required — classifier walks causes.
    expect(isTransientNetworkError(outer)).toBe(true);
  });

    it("rejects RAG status-without-HTTP formats as non-transient", async () => {
    const { isTransientNetworkErrorText } = await import("../src/lib/network-errors");
    // vector-db throws `Embedding/Rerank API failed …: ${status} ${body}` — no "HTTP" prefix.
    for (const text of [
      "Embedding API failed (isOpenRouter=false): 400 {\"error\":\"bad request\"}",
      "Rerank API failed (isOpenRouter=true): 502 Bad Gateway",
      "Embedding API failed (isOpenRouter=false): 500 fetch failed while upstream said ECONNRESET",
      "some provider API error: 401 Unauthorized"
    ]) {
      expect(isTransientNetworkErrorText(text), text).toBe(false);
    }
    // Real transport strings with no status present stay transient —
    // including Node/undici shapes that mention a destination port after a colon
    // (`ECONNREFUSED 127.0.0.1:443`); the RAG guard must not mistake that port for HTTP status.
    expect(isTransientNetworkErrorText("embed documents: fetch failed")).toBe(true);
    expect(isTransientNetworkErrorText("read ECONNRESET")).toBe(true);
    expect(isTransientNetworkErrorText("TypeError: fetch failed")).toBe(true);
    expect(isTransientNetworkErrorText("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
    expect(
      isTransientNetworkErrorText("TypeError: fetch failed (cause: Error: connect ECONNREFUSED 127.0.0.1:443)")
    ).toBe(true);
    // Non-RAG "API error: 401" is not a transport blip either (no TRANSIENT_NETWORK_TEXT match).
    expect(isTransientNetworkErrorText("some provider API error: 401 Unauthorized")).toBe(false);
  });

  it("sets streakStartedTs for a short hard-failure run (<5) without consecutive-failures STOPPED", async () => {
    // Sparse RAG lanes may never fill last-5; streakStartedTs must still land so
    // alertRagConnectionFailure can escalate by wall-clock before five rows accumulate.
    const { logApiHealth, getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await import("../src/lib/db-health");
    const service = `sparse-lane-${randomUUID().slice(0, 8)}`;
    await insertAgedSuccess(service, 30);
    await insertAgedFailure(service, "TypeError: fetch failed", 20);
    await insertAgedFailure(service, "TypeError: fetch failed", 10);
    logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    const lane = getLaneHealth(service, "env");
    expect(lane.reason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    expect(lane.streakStartedTs).toBeTruthy();
    const ageMs = Date.now() - Date.parse(lane.streakStartedTs!);
    // Anchored at the ~20-minute-old start of the hard run, not null / not "now".
    expect(ageMs).toBeGreaterThan(15 * 60_000);
    expect(ageMs).toBeLessThan(25 * 60_000);
  });

  it("arms transient cooldown until streakStart+window, not now+window", async () => {
    const { logApiHealth, HEALTH_TRANSIENT_FAILURE_PREFIX, transientEscalationWindowMs } =
      await import("../src/lib/db-health");
    const { getInternalSetting } = await import("../src/lib/db");
    const service = `cooldown-anchor-${randomUUID().slice(0, 8)}`;
    const windowMs = transientEscalationWindowMs();
    // Four aged blips starting ~4 minutes ago + one fresh → streak tip holds, streakStarted ~4m ago.
    // cooldownUntil must be streakStart+window (≈ now+(window-4m)), not now+window.
    await insertAgedFailure(service, `${HEALTH_TRANSIENT_FAILURE_PREFIX}TypeError: fetch failed`, 4);
    for (let i = 0; i < 3; i++) {
      await insertAgedFailure(service, `${HEALTH_TRANSIENT_FAILURE_PREFIX}TypeError: fetch failed`, 3 - i * 0.5);
    }
    const beforeAlert = Date.now();
    logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("warning");

    const until = getInternalSetting<string>(`healthAlertSent:${service}:env:transient`);
    expect(until).toBeTruthy();
    const untilMs = Date.parse(until!);
    // Old bug: Date.now()+window. Fixed: streakStart(~4m ago)+window ≈ now+(window-4m).
    // Allow a few seconds of test slack either side of the 4-minute offset.
    expect(untilMs).toBeLessThan(beforeAlert + windowMs - 3 * 60_000);
    expect(untilMs).toBeGreaterThan(beforeAlert + windowMs - 5 * 60_000);
  });

  it("lets a hard failure page after a transient-blip warning (separate cooldown keys)", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    const service = `blip-then-hard-${randomUUID().slice(0, 8)}`;
    // Five transport blips → warning on the :transient cooldown key.
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "TypeError: fetch failed", keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("warning");
    expect(capturedLevels()).not.toContain("error");

    vi.clearAllMocks();
    sentry.withScope.mockImplementation((cb: (scope: unknown) => void) =>
      cb({
        setLevel: sentry.setLevel,
        setTag: sentry.setTag,
        setContext: sentry.setContext,
        setFingerprint: sentry.setFingerprint
      })
    );

    // Immediately shift to a definitive hard outage.  Shared cooldown would suppress this; the
    // hard key must still fire at error.
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service, ok: false, errorText: "HTTP 500 upstream exploded", keySource: "env" });
    }
    await vi.waitFor(() => expect(sentry.captureMessage).toHaveBeenCalled(), { timeout: 5000 });
    await settleAlerts();
    expect(capturedLevels()).toContain("error");
    expect(capturedTag("health.failure_class")).toBe("hard");
  });

});
