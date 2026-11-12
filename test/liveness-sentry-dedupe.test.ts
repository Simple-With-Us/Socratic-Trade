// SOCRATIC-TRADE-2S / ST-4614: trading-liveness Sentry must not re-capture on every
// /api/health poll — only on state transition or at most hourly while unchanged.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "liveness-sentry-dedupe-")), "app.db")}`;
  process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
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
    sentry.withScope.mockImplementation((fn: (scope: unknown) => void) => {
      const scope = {
        setLevel: vi.fn(),
        setTag: vi.fn(),
        setContext: vi.fn(),
        setFingerprint: (fp: string[]) => {
          fingerprints.push(fp);
        }
      };
      fn(scope);
    });
    await alertLivenessWarning(TYPE, "volatile body", "acct:stale_last_completed_run");
    expect(fingerprints).toEqual([["api-health", "trading-liveness", TYPE]]);
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
  it("keys by account id and sorted reason codes only", async () => {
    const { tradingLivenessSentryStateSignature } = await import("../src/lib/trading-liveness");
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
    expect(sig).toBe("ca-1:stale_last_completed_run");
  });
});
