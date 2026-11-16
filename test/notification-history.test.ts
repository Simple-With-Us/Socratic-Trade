import { describe, expect, it } from "vitest";
import type { NotificationEvent } from "../src/lib/types";
import {
  buildNotificationHistory,
  inScopeNotificationEvents,
  unreadNotificationCount
} from "../src/lib/notification-history";

function event(overrides: Partial<NotificationEvent> & { id: string }): NotificationEvent {
  return {
    createdAt: "2026-08-18T12:00:00.000Z",
    type: "run_failed",
    title: "Strategy run failed",
    status: "sent",
    payload: { summary: "Green Team could not finish." },
    ...overrides
  };
}

describe("notification history", () => {
  it("formats title and body, maps acknowledgedAt to read, and omits raw payload", () => {
    const items = buildNotificationHistory({
      notifications: [
        event({
          id: "unread-1",
          connectedAccountId: "acct-1"
        }),
        event({
          id: "read-1",
          createdAt: "2026-08-18T11:00:00.000Z",
          type: "fill",
          title: "Filled AAPL",
          acknowledgedAt: "2026-08-18T11:05:00.000Z",
          payload: { fill: { symbol: "AAPL", side: "buy", status: "filled", source: "live" } }
        })
      ],
      connectedAccounts: [
        {
          id: "acct-1",
          userId: "user-1",
          broker: "alpaca",
          environment: "paper",
          label: "Alpaca Paper",
          isActive: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      symbolMetaBySymbol: { AAPL: { companyName: "Apple" } }
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "unread-1",
      title: "Strategy Run Failed",
      read: false,
      accountLabel: "Alpaca Paper"
    });
    expect(items[0]?.body).toMatch(/Green Team could not finish/);
    expect(items[0]?.channel).toBe("Push");
    expect(items[1]).toMatchObject({
      id: "read-1",
      title: "Bought AAPL",
      read: true
    });
    expect(JSON.stringify(items)).not.toContain("webhook");
  });

  it("keeps other-account rows out of the unread badge for the active account", () => {
    const events = [
      event({ id: "mine", connectedAccountId: "acct-1" }),
      event({ id: "theirs", connectedAccountId: "acct-2" }),
      event({ id: "shared" }),
      event({ id: "acked", connectedAccountId: "acct-1", acknowledgedAt: "2026-08-18T12:01:00.000Z" })
    ];

    expect(inScopeNotificationEvents(events, "acct-1").map((row) => row.id)).toEqual(["mine", "shared", "acked"]);
    expect(unreadNotificationCount(events, "acct-1")).toBe(2);
    expect(unreadNotificationCount(events)).toBe(3);
  });

  it("caps history at the recency window and newest first", () => {
    const notifications = Array.from({ length: 3 }, (_, index) =>
      event({
        id: `evt-${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 18, index)).toISOString()
      })
    );
    const items = buildNotificationHistory({ notifications, limit: 2 });
    expect(items.map((item) => item.id)).toEqual(["evt-2", "evt-1"]);
  });
});
