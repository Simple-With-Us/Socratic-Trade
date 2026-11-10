import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/** per-account-visibility (api-contract-web-ios:api-10): mobileCommandBacklog() used to count
 *  EVERY user's queued/running mobile_commands rows, not just the requesting user's — the iOS
 *  Home/Activity "N queued / M running" gauge (mobileReadiness -> commandBacklog) would then
 *  silently include another user's in-flight commands as if they were the signed-in user's own.
 *  Proves two users with distinguishable queued commands each see only their OWN count. */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-backlog-scope-${randomUUID()}.db`)}`;
});

describe("mobileCommandBacklog user scoping", () => {
  it("counts only the requesting user's queued commands, not another user's", async () => {
    const { mobileCommandBacklog, queueMobileCommand } = await import("../src/lib/mobile-api");

    const userA = `backlog-user-a-${randomUUID()}`;
    const userB = `backlog-user-b-${randomUUID()}`;

    // User A queues two commands; user B queues none.
    queueMobileCommand({ userId: userA, commandType: "watchlist.add", payload: { symbol: "AAPL" } });
    queueMobileCommand({ userId: userA, commandType: "watchlist.add", payload: { symbol: "MSFT" } });

    expect(mobileCommandBacklog(userA).queued).toBe(2);
    expect(mobileCommandBacklog(userB).queued).toBe(0);

    // User B queues one of their own — user A's count must not move.
    queueMobileCommand({ userId: userB, commandType: "watchlist.add", payload: { symbol: "NVDA" } });
    expect(mobileCommandBacklog(userB).queued).toBe(1);
    expect(mobileCommandBacklog(userA).queued).toBe(2);
  });
});
