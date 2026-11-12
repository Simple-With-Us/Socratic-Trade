// SOCRATIC-TRADE-2S / ST-4614: trading-liveness Sentry must not re-capture on every
// /api/health poll — only on state transition or at most hourly while unchanged.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  withScope: vi.fn((fn: (scope: unknown) => void) => {
    fn({
      setLevel: vi.fn(),
      setTag: vi.fn(),
      setContext: vi.fn(),
      setFingerprint: vi.fn()
    });
  })
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  withScope: sentry.withScope
}));

const notifyMock = vi.hoisted(() => ({ sendNotification: vi.fn(async () => {}) }));
vi.mock("../src/lib/notifications", () => ({ sendNotification: notifyMock.sendNotification }));

const priorDatabaseUrl = process.env.DATABASE_URL;
const priorSentryDsn = process.env.SENTRY_DSN;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `liveness-sentry-dedupe-${randomUUID()}.db`)}`;
  process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
});

afterAll(() => {
  if (priorDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = priorDatabaseUrl;
  }
  if (priorSentryDsn === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = priorSentryDsn;
  }
});

const TYPE = "trading_liveness_degraded";

async function lib() {
  return await import("../src/lib/db-health");
}
async function db() {
  return await import("../src/lib/db");
}
async function clearLivenessKeys() {
  const { getDb } = await db();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'liveness%'").run();
}

describe("evaluateLivenessSentryCapture", () => {
  it("captures on first sight and on signature change", async () => {
    const { evaluateLivenessSentryCapture } = await lib();
    expect(
      evaluateLivenessSentryCapture({
        stateSignature: "acct:stale_last_completed_run",
        previousSignature: undefined,
        lastSentAtIso: undefined,
        dueForEscalation: false
      })
    ).toBe(true);
    expect(
      evaluateLivenessSentryCapture({
        stateSignature: "acct:consecutive_failures",
        previousSignature: "acct:stale_last_completed_run",
        lastSentAtIso: new Date().toISOString(),
        dueForEscalation: false
      })
    ).toBe(true);
  });

  it("suppresses repeats inside the hourly window for an unchanged signature", async () => {
    const { evaluateLivenessSentryCapture } = await lib();
    const sent = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(
      evaluateLivenessSentryCapture({
        stateSignature: "acct:stale_last_completed_run",
        previousSignature: "acct:stale_last_completed_run",
        lastSentAtIso: sent,
        dueForEscalation: false
      })
    ).toBe(false);
  });

  it("re-sends after an hour when the signature is unchanged", async () => {
    const { evaluateLivenessSentryCapture } = await lib();
    const sent = new Date(Date.now() - 61 * 60_000).toISOString();
    expect(
      evaluateLivenessSentryCapture({
        stateSignature: "acct:stale_last_completed_run",
        previousSignature: "acct:stale_last_completed_run",
        lastSentAtIso: sent,
        dueForEscalation: false
      })
    ).toBe(true);
  });

  it("captures when escalation is due even inside the hourly window", async () => {
    const { evaluateLivenessSentryCapture } = await lib();
    expect(
      evaluateLivenessSentryCapture({
        stateSignature: "acct:stale_last_completed_run",
        previousSignature: "acct:stale_last_completed_run",
        lastSentAtIso: new Date().toISOString(),
        dueForEscalation: true
      })
    ).toBe(true);
  });
});

describe("alertLivenessWarning Sentry dedupe", () => {
  beforeEach(async () => {
    notifyMock.sendNotification.mockClear();
    sentry.captureMessage.mockClear();
    await clearLivenessKeys();
    delete process.env.ST_LIVENESS_ESCALATION_HOURS;
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
  });

  it("captures once per unchanged signature across rapid health polls", async () => {
    const { alertLivenessWarning } = await lib();
    const sig = "broker-acct-1:stale_last_completed_run";
    await alertLivenessWarning(TYPE, "Trading liveness is degraded: detail A", sig);
    await alertLivenessWarning(TYPE, "Trading liveness is degraded: detail B", sig);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("captures again when the degraded account set or reasons change", async () => {
    const { alertLivenessWarning } = await lib();
    await alertLivenessWarning(TYPE, "msg 1", "acct-a:stale_last_completed_run");
    await alertLivenessWarning(TYPE, "msg 2", "acct-a:stale_last_completed_run,consecutive_failures");
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
  });

  it("uses a stable api-health fingerprint on capture", async () => {
    const { alertLivenessWarning } = await lib();
    const fingerprints: string[][] = [];
    const contexts: Record<string, unknown>[] = [];
    sentry.withScope.mockImplementation((fn: (scope: unknown) => void) => {
      const scope = {
        setLevel: vi.fn(),
        setTag: vi.fn(),
        setContext: (_name: string, ctx: Record<string, unknown>) => {
          contexts.push(ctx);
        },
        setFingerprint: (fp: string[]) => {
          fingerprints.push(fp);
        }
      };
      fn(scope);
    });
    await alertLivenessWarning(TYPE, "Sandbox label and secret detail", "acct:stale_last_completed_run");
    expect(fingerprints).toEqual([["api-health", "trading-liveness", TYPE]]);
    expect(contexts[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(contexts[0])).not.toContain("Sandbox");
  });

  it("does not stamp Sentry dedupe keys when SENTRY_DSN is absent", async () => {
    delete process.env.SENTRY_DSN;
    const { alertLivenessWarning } = await lib();
    const { getInternalSetting } = await db();
    const sig = "acct:stale_last_completed_run";
    await alertLivenessWarning(TYPE, "degraded", sig);
    expect(getInternalSetting<string>(`livenessSentrySignature:${TYPE}`)).toBeUndefined();
    expect(getInternalSetting<string>(`livenessSentrySentAt:${TYPE}`)).toBeUndefined();
  });

  it("delivers escalated admin push even inside the 15-minute admin cooldown", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, new Date(Date.now() - 5 * 3_600_000).toISOString());
    setInternalSetting(`livenessAlertSent:${TYPE}`, new Date().toISOString());
    setInternalSetting(`livenessSentrySignature:${TYPE}`, "same:sig");
    setInternalSetting(`livenessSentrySentAt:${TYPE}`, new Date().toISOString());
    await alertLivenessWarning(TYPE, "still degraded", "same:sig");
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
    const lastCall = notifyMock.sendNotification.mock.calls[0];
    expect((lastCall[0] as { title: string }).title).toMatch(/ESCALATED/);
  });

  it("fires admin again when the admin cooldown timestamp is corrupt", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(`livenessAlertSent:${TYPE}`, "not-a-timestamp");
    await alertLivenessWarning(TYPE, "degraded", "sig-a");
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("resets Sentry episode keys on recovery so the next degrade is a transition", async () => {
    const { alertLivenessWarning, clearLivenessWarning } = await lib();
    const sig = "acct:stale_last_completed_run";
    await alertLivenessWarning(TYPE, "degraded", sig);
    await clearLivenessWarning(TYPE);
    await alertLivenessWarning(TYPE, "degraded again", sig);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
  });
});

describe("tradingLivenessSentryStateSignature", () => {
  it("keys by hashed account id and sorted reason codes only", async () => {
    const { tradingLivenessSentryStateSignature, livenessDedupeToken } = await import(
      "../src/lib/trading-liveness"
    );
    const sig = tradingLivenessSentryStateSignature(
      [
        {
          userId: "u1",
          connectedAccountId: "ca-1",
          label: "Sandbox",
          lastCompletedRunAt: null,
          lastCompletedRunAgeSeconds: 99_999,
          consecutiveFailedRuns: 0,
          consecutiveHaltEligibleFailures: 0,
          latestFailedRunSummary: null,
          latestFailedRunAt: null,
          marketOpen: true,
          degraded: true,
          degradedReasons: ["stale_last_completed_run"]
        }
      ],
      false,
      0
    );
    expect(sig).toBe(`${livenessDedupeToken("ca-1")}:stale_last_completed_run`);
  });
});

describe("runFailureLivenessSentrySignature", () => {
  it("separates accounts and streak growth", async () => {
    const { runFailureLivenessSentrySignature } = await import("../src/lib/trading-liveness");
    const a = runFailureLivenessSentrySignature("u1", "acct-a", "streak", 3);
    const b = runFailureLivenessSentrySignature("u1", "acct-b", "streak", 3);
    const c = runFailureLivenessSentrySignature("u1", "acct-a", "streak", 4);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
