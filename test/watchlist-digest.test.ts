import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, getInternalSetting, setNotifyPrefs } from "../src/lib/db";
import { addToWatchlist } from "../src/lib/watchlist";
import { isWatchlistDigestDue, runWatchlistDigestIfDue } from "../src/lib/watchlist-digest";
import type { NotifyChannelResult, NotifyMessage } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-watchlist-digest-${randomUUID()}.db`)}`;
  getDb();
});

function newUser(): string {
  return `u-${randomUUID()}`;
}

// 2026-08-11 is CDT (UTC-5): 20:20Z = 15:20 CT (past the 15:15 post-close gate); 19:00Z = 14:00 CT.
const AFTER_CLOSE_UTC = Date.parse("2026-08-11T20:20:00.000Z");
const BEFORE_CLOSE_UTC = Date.parse("2026-08-11T19:00:00.000Z");
const NEXT_DAY_AFTER_CLOSE_UTC = AFTER_CLOSE_UTC + 24 * 3600_000;

const okNotify = async (): Promise<NotifyChannelResult[]> => [{ channel: "push", ok: true }];

describe("runWatchlistDigestIfDue — nothing due", () => {
  // Runs first, deliberately, against the still-pristine per-file DB (see the ordering note in
  // the file's later describe blocks) so "nothing registered yet" genuinely means nothing due.
  it("skips with reason not_due when no user is due", async () => {
    const result = await runWatchlistDigestIfDue(AFTER_CLOSE_UTC, { notifyImpl: okNotify });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not_due");
  });
});

describe("isWatchlistDigestDue", () => {
  it("is false when the user has never enabled the digest", () => {
    expect(isWatchlistDigestDue(newUser(), AFTER_CLOSE_UTC)).toBe(false);
  });

  it("is false before the 15:15 Central post-close gate even when enabled", () => {
    const userId = newUser();
    setNotifyPrefs(userId, { watchlistDigestEnabled: true });
    expect(isWatchlistDigestDue(userId, BEFORE_CLOSE_UTC)).toBe(false);
    setNotifyPrefs(userId, { watchlistDigestEnabled: false }); // don't leak a "due" user forward
  });

  it("is true at/after 15:15 Central on a day it hasn't fired yet", () => {
    const userId = newUser();
    setNotifyPrefs(userId, { watchlistDigestEnabled: true });
    expect(isWatchlistDigestDue(userId, AFTER_CLOSE_UTC)).toBe(true);
    setNotifyPrefs(userId, { watchlistDigestEnabled: false });
  });

  it("is false again once explicitly disabled", () => {
    const userId = newUser();
    setNotifyPrefs(userId, { watchlistDigestEnabled: true });
    expect(isWatchlistDigestDue(userId, AFTER_CLOSE_UTC)).toBe(true);
    setNotifyPrefs(userId, { watchlistDigestEnabled: false });
    expect(isWatchlistDigestDue(userId, AFTER_CLOSE_UTC)).toBe(false);
  });
});

describe("runWatchlistDigestIfDue — dueness + watermark + delivery", () => {
  it("sends via the injected notifyImpl, marks the watermark, and stops firing again the same Central day", async () => {
    const userId = newUser();
    setNotifyPrefs(userId, { watchlistDigestEnabled: true });
    addToWatchlist(userId, "AAPL");

    const calls: Array<{ userId: string; msg: NotifyMessage }> = [];
    const notifyImpl = async (uid: string, msg: NotifyMessage): Promise<NotifyChannelResult[]> => {
      calls.push({ userId: uid, msg });
      return [{ channel: "push", ok: true }];
    };

    const first = await runWatchlistDigestIfDue(AFTER_CLOSE_UTC, { notifyImpl });
    expect(first.status).toBe("sent");
    expect(first.usersSent).toBe(1);

    const ourCall = calls.find((c) => c.userId === userId);
    expect(ourCall).toBeDefined();
    expect(ourCall!.msg.kind).toBe("watchlist_digest");
    expect(ourCall!.msg.bodyTiers?.full).toBeTruthy();
    expect(ourCall!.msg.bodyTiers?.medium).toBeTruthy();
    expect(ourCall!.msg.bodyTiers?.brief).toBeTruthy();
    expect(ourCall!.msg.body).toBe(ourCall!.msg.bodyTiers?.full);
    expect(ourCall!.msg.title).toContain("1 symbol");

    // Watermark now holds today's Central date key.
    expect(getInternalSetting<string>(`watchlistDigest:lastSentDate:${userId}`)).toBe("2026-08-11");

    // A second run later the SAME Central day must not fire again for this user.
    const callsBefore = calls.length;
    const second = await runWatchlistDigestIfDue(AFTER_CLOSE_UTC + 3600_000, { notifyImpl });
    expect(calls.length).toBe(callsBefore); // no new call for this user
    expect(second.status).toBe("skipped");

    // The NEXT Central day, it's due again.
    const third = await runWatchlistDigestIfDue(NEXT_DAY_AFTER_CLOSE_UTC, { notifyImpl });
    expect(third.status).toBe("sent");
    expect(calls.filter((c) => c.userId === userId).length).toBe(2);
  });

  it("never sends for a registered user whose digest is disabled", async () => {
    const userId = newUser();
    addToWatchlist(userId, "MSFT"); // registers the user via listUsers(); digest stays default OFF

    const calls: string[] = [];
    const notifyImpl = async (uid: string): Promise<NotifyChannelResult[]> => {
      calls.push(uid);
      return [{ channel: "push", ok: true }];
    };

    await runWatchlistDigestIfDue(AFTER_CLOSE_UTC, { notifyImpl });
    expect(calls).not.toContain(userId);
  });

  it("captures a per-user failure without throwing and still serves the other due user", async () => {
    const badUser = newUser();
    const goodUser = newUser();
    setNotifyPrefs(badUser, { watchlistDigestEnabled: true });
    addToWatchlist(badUser, "TSLA");
    setNotifyPrefs(goodUser, { watchlistDigestEnabled: true });
    addToWatchlist(goodUser, "NVDA");

    const calls: string[] = [];
    const notifyImpl = async (uid: string): Promise<NotifyChannelResult[]> => {
      calls.push(uid);
      if (uid === badUser) throw new Error("boom: simulated delivery failure");
      return [{ channel: "push", ok: true }];
    };

    const result = await runWatchlistDigestIfDue(AFTER_CLOSE_UTC, { notifyImpl });

    // Assert on THIS test's users only — earlier tests in this file register their own users in
    // the shared per-run DB, so exact-equality on `calls` would couple this test to their
    // watermark state (run order).
    expect(calls).toContain(badUser);
    expect(calls).toContain(goodUser);
    expect(result.status).toBe("sent"); // the good user's delivery still counts
    expect(result.usersSent).toBeGreaterThanOrEqual(1);
  });

  it("skips a user whose watchlist is empty without calling notifyImpl for them", async () => {
    const userId = newUser();
    setNotifyPrefs(userId, { watchlistDigestEnabled: true });
    // Register the user via listUsers() without ever watchlisting a symbol (notification_prefs
    // itself is NOT one of listUsers()'s source tables — user_settings is).
    getDb()
      .prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', '{}', ?)")
      .run(randomUUID(), userId, new Date().toISOString());

    const calls: string[] = [];
    const notifyImpl = async (uid: string): Promise<NotifyChannelResult[]> => {
      calls.push(uid);
      return [{ channel: "push", ok: true }];
    };

    await runWatchlistDigestIfDue(AFTER_CLOSE_UTC, { notifyImpl });
    expect(calls).not.toContain(userId);
  });
});
