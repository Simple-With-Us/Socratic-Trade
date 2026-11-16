// Liveness-warning escalation (2026-09-30 self-healing): a degradation nobody
// acts on must get LOUDER over time, not just repeat.  alertLivenessWarning
// stamps the episode start, escalates after ST_LIVENESS_ESCALATION_HOURS
// (default 4h), and clearLivenessWarning resets the episode on recovery.
//
// Isolated temp DB per the repo convention (DATABASE_URL=file:<tmpdir>/...).
// sendNotification is mocked so no test pings a real channel; Sentry capture
// no-ops without SENTRY_DSN.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const notifyMock = vi.hoisted(() => ({ sendNotification: vi.fn(async () => {}) }));
vi.mock("../src/lib/notifications", () => ({ sendNotification: notifyMock.sendNotification }));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "liveness-escalation-")), "app.db")}`;
});

const TYPE = "trading_liveness_degraded";
const ACCT_A = "acct-a";
const ACCT_B = "acct-b";
const LABEL_A = "Alpaca Paper";
const LABEL_B = "Tradier Sandbox";

function accountSinceKey(accountKey: string): string {
  return `livenessDegradedSince:${TYPE}:${accountKey}`;
}

async function lib() {
  return await import("../src/lib/db-health");
}
async function db() {
  return await import("../src/lib/db");
}
async function clearEpisodeKeys() {
  const { getDb } = await db();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'liveness%'").run();
}
function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

type SendNotificationFn = (
  notification: { title: string },
  options: { directBody: string }
) => Promise<void>;
const sendNotificationMock = notifyMock.sendNotification as MockInstance<SendNotificationFn>;

function lastNotification(): { title: string; body: string } {
  const last = sendNotificationMock.mock.calls.at(-1);
  expect(last).toBeDefined();
  const [notification, options] = last!;
  return { title: notification.title, body: options.directBody };
}

describe("alertLivenessWarning escalation", () => {
  beforeEach(async () => {
    notifyMock.sendNotification.mockClear();
    await clearEpisodeKeys();
    delete process.env.ST_LIVENESS_ESCALATION_HOURS;
  });

  it("stamps the episode start on the first alert and sends a normal warning", async () => {
    const { alertLivenessWarning } = await lib();
    await alertLivenessWarning(TYPE, "degraded message", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
    const { title } = lastNotification();
    expect(title).toMatch(/^Liveness Warning:/);
    expect(title).not.toMatch(/ESCALATED/);
    const { getInternalSetting } = await db();
    expect(getInternalSetting<string>(accountSinceKey(ACCT_A))).toBeTruthy();
  });

  it("does not escalate inside the escalation window", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    // Episode began 1h ago; cooldown key expired so the alert fires.
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(1));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(1));
    await alertLivenessWarning(TYPE, "still degraded", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    const { title, body } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
    expect(body).not.toMatch(/human intervention/);
  });

  it("escalates after the escalation window with a louder title and body", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(5));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(5));
    await alertLivenessWarning(TYPE, "still degraded", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
    const { title, body } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
    expect(title).toMatch(/5h/);
    expect(title).toMatch(LABEL_A);
    expect(body).toMatch(/human intervention/);
    expect(getInternalSetting<string>(`livenessEscalatedAt:${TYPE}`)).toBeTruthy();
  });

  it("does not re-escalate on every cooldown tick after escalating once", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(9));
    setInternalSetting(`livenessEscalatedAt:${TYPE}`, hoursAgoIso(1)); // escalated 1h ago
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(1));
    await alertLivenessWarning(TYPE, "still degraded", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    const { title } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
  });

  it("re-escalates after another full escalation window passes", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(9));
    setInternalSetting(`livenessEscalatedAt:${TYPE}`, hoursAgoIso(5)); // escalated 5h ago
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(5));
    await alertLivenessWarning(TYPE, "still degraded", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    const { title } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
  });

  it("honours ST_LIVENESS_ESCALATION_HOURS", async () => {
    process.env.ST_LIVENESS_ESCALATION_HOURS = "1";
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(2));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(2));
    await alertLivenessWarning(TYPE, "still degraded", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    const { title } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
  });

  it("clearLivenessWarning resets the episode so the next alert starts fresh", async () => {
    const { alertLivenessWarning, clearLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(9));
    setInternalSetting(`livenessEscalatedAt:${TYPE}`, hoursAgoIso(5));
    await clearLivenessWarning(TYPE);
    expect(getInternalSetting<string>(accountSinceKey(ACCT_A))).toBeUndefined();
    expect(getInternalSetting<string>(`livenessEscalatedAt:${TYPE}`)).toBeUndefined();
    // Next alert is a fresh episode: normal title even though wall-clock time passed.
    await alertLivenessWarning(TYPE, "degraded again", {
      account: { accountKey: ACCT_A, accountLabel: LABEL_A }
    });
    const { title } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
  });

  it("clearLivenessWarning is a no-op with no episode, and clears once when there is one", async () => {
    const { clearLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    // A healthy /api/health hit with nothing to clear must not write.
    expect(await clearLivenessWarning(TYPE)).toBe(false);
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(9));
    expect(await clearLivenessWarning(TYPE)).toBe(true);
    expect(getInternalSetting<string>(accountSinceKey(ACCT_A))).toBeUndefined();
    expect(await clearLivenessWarning(TYPE)).toBe(false);
  });

  it("respects the 15-minute cooldown between alerts", async () => {
    const { alertLivenessWarning } = await lib();
    await alertLivenessWarning(TYPE, "first", { account: { accountKey: ACCT_A, accountLabel: LABEL_A } });
    await alertLivenessWarning(TYPE, "second", { account: { accountKey: ACCT_A, accountLabel: LABEL_A } });
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("escalates using the oldest account episode and names that account", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), { since: hoursAgoIso(5), label: LABEL_A });
    setInternalSetting(accountSinceKey(ACCT_B), hoursAgoIso(0.1));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(5));
    await alertLivenessWarning(TYPE, "still degraded", {
      accounts: [
        { accountKey: ACCT_A, accountLabel: LABEL_A },
        { accountKey: ACCT_B, accountLabel: LABEL_B }
      ]
    });
    const { title } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
    expect(title).toMatch(LABEL_A);
    expect(title).not.toMatch(LABEL_B);
    expect(title).toMatch(/5h/);
  });

  it("clearing one account episode leaves others intact", async () => {
    const { clearLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    setInternalSetting(accountSinceKey(ACCT_A), hoursAgoIso(5));
    setInternalSetting(accountSinceKey(ACCT_B), hoursAgoIso(1));
    expect(await clearLivenessWarning(TYPE, ACCT_A)).toBe(true);
    expect(getInternalSetting<string>(accountSinceKey(ACCT_A))).toBeUndefined();
    expect(getInternalSetting<string>(accountSinceKey(ACCT_B))).toBeTruthy();
  });

  it("discards a legacy global episode key instead of paging immediately on upgrade", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(76));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(76));
    await alertLivenessWarning(TYPE, "new account degraded", {
      account: { accountKey: ACCT_B, accountLabel: LABEL_B }
    });
    const { title } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
    expect(getInternalSetting<string>(`livenessDegradedSince:${TYPE}`)).toBeUndefined();
    expect(readSince(getInternalSetting(accountSinceKey(ACCT_B)))).toBeTruthy();
  });

  it("pages when the fleet is fully dark via the synthetic episode account", async () => {
    const { TRADING_LIVENESS_FLEET_DARK_ACCOUNT_KEY } = await import("../src/lib/trading-liveness");
    const { alertLivenessWarning } = await lib();
    const fleetKey = `livenessDegradedSince:${TYPE}:${TRADING_LIVENESS_FLEET_DARK_ACCOUNT_KEY}`;
    await alertLivenessWarning(TYPE, "fleet is fully dark", {
      accounts: [
        { accountKey: TRADING_LIVENESS_FLEET_DARK_ACCOUNT_KEY, accountLabel: "Fleet fully dark" }
      ]
    });
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
    const { title } = lastNotification();
    expect(title).toMatch(/^Liveness Warning:/);
    const { getInternalSetting } = await db();
    expect(getInternalSetting<string>(fleetKey)).toBeTruthy();
  });
});

function readSince(stored: unknown): string | undefined {
  if (typeof stored === "string") return stored;
  if (stored && typeof stored === "object" && "since" in stored) {
    return (stored as { since: string }).since;
  }
  return undefined;
}
