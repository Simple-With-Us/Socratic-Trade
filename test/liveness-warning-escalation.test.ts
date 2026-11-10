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
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => ({ sendNotification: vi.fn(async () => {}) }));
vi.mock("../src/lib/notifications", () => ({ sendNotification: notifyMock.sendNotification }));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "liveness-escalation-")), "app.db")}`;
});

const TYPE = "trading_liveness_degraded";

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

type NotificationCall = [{ title: string }, { directBody: string }];
function lastNotification(): { title: string; body: string } {
  const calls = notifyMock.sendNotification.mock.calls as unknown as NotificationCall[];
  const last = calls[calls.length - 1];
  return { title: last[0].title, body: last[1].directBody };
}

describe("alertLivenessWarning escalation", () => {
  beforeEach(async () => {
    notifyMock.sendNotification.mockClear();
    await clearEpisodeKeys();
    delete process.env.ST_LIVENESS_ESCALATION_HOURS;
  });

  it("stamps the episode start on the first alert and sends a normal warning", async () => {
    const { alertLivenessWarning } = await lib();
    await alertLivenessWarning(TYPE, "degraded message");
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
    const { title } = lastNotification();
    expect(title).toMatch(/^Liveness Warning:/);
    expect(title).not.toMatch(/ESCALATED/);
    const { getInternalSetting } = await db();
    expect(getInternalSetting<string>(`livenessDegradedSince:${TYPE}`)).toBeTruthy();
  });

  it("does not escalate inside the escalation window", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    // Episode began 1h ago; cooldown key expired so the alert fires.
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(1));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(1));
    await alertLivenessWarning(TYPE, "still degraded");
    const { title, body } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
    expect(body).not.toMatch(/human intervention/);
  });

  it("escalates after the escalation window with a louder title and body", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(5));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(5));
    await alertLivenessWarning(TYPE, "still degraded");
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
    const { title, body } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
    expect(title).toMatch(/5h/);
    expect(body).toMatch(/human intervention/);
    expect(getInternalSetting<string>(`livenessEscalatedAt:${TYPE}`)).toBeTruthy();
  });

  it("does not re-escalate on every cooldown tick after escalating once", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(9));
    setInternalSetting(`livenessEscalatedAt:${TYPE}`, hoursAgoIso(1)); // escalated 1h ago
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(1));
    await alertLivenessWarning(TYPE, "still degraded");
    const { title } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
  });

  it("re-escalates after another full escalation window passes", async () => {
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(9));
    setInternalSetting(`livenessEscalatedAt:${TYPE}`, hoursAgoIso(5)); // escalated 5h ago
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(5));
    await alertLivenessWarning(TYPE, "still degraded");
    const { title } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
  });

  it("honours ST_LIVENESS_ESCALATION_HOURS", async () => {
    process.env.ST_LIVENESS_ESCALATION_HOURS = "1";
    const { alertLivenessWarning } = await lib();
    const { setInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(2));
    setInternalSetting(`livenessAlertSent:${TYPE}`, hoursAgoIso(2));
    await alertLivenessWarning(TYPE, "still degraded");
    const { title } = lastNotification();
    expect(title).toMatch(/ESCALATED/);
  });

  it("clearLivenessWarning resets the episode so the next alert starts fresh", async () => {
    const { alertLivenessWarning, clearLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(9));
    setInternalSetting(`livenessEscalatedAt:${TYPE}`, hoursAgoIso(5));
    await clearLivenessWarning(TYPE);
    expect(getInternalSetting<string>(`livenessDegradedSince:${TYPE}`)).toBeUndefined();
    expect(getInternalSetting<string>(`livenessEscalatedAt:${TYPE}`)).toBeUndefined();
    // Next alert is a fresh episode: normal title even though wall-clock time passed.
    await alertLivenessWarning(TYPE, "degraded again");
    const { title } = lastNotification();
    expect(title).not.toMatch(/ESCALATED/);
  });

  it("clearLivenessWarning is a no-op with no episode, and clears once when there is one", async () => {
    const { clearLivenessWarning } = await lib();
    const { setInternalSetting, getInternalSetting } = await db();
    // A healthy /api/health hit with nothing to clear must not write.
    expect(await clearLivenessWarning(TYPE)).toBe(false);
    setInternalSetting(`livenessDegradedSince:${TYPE}`, hoursAgoIso(9));
    expect(await clearLivenessWarning(TYPE)).toBe(true);
    expect(getInternalSetting<string>(`livenessDegradedSince:${TYPE}`)).toBeUndefined();
    expect(await clearLivenessWarning(TYPE)).toBe(false);
  });

  it("respects the 15-minute cooldown between alerts", async () => {
    const { alertLivenessWarning } = await lib();
    await alertLivenessWarning(TYPE, "first");
    await alertLivenessWarning(TYPE, "second");
    expect(notifyMock.sendNotification).toHaveBeenCalledTimes(1);
  });
});
