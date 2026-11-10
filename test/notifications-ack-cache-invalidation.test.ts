import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  dashboardSnapshotCacheKey,
  getCachedDashboardSnapshot,
  resetDashboardSnapshotCacheForTests,
  setCachedDashboardSnapshot
} from "../src/lib/dashboard-snapshot-cache";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ack-cache-${randomUUID()}.db`)}`;
  process.env.AUTH_SECRET = "";
});

afterEach(() => {
  resetDashboardSnapshotCacheForTests();
});

describe("notifications ack cache invalidation", () => {
  it("clears the dashboard snapshot cache after POST /api/notifications/ack", async () => {
    const userId = "local";
    const key = dashboardSnapshotCacheKey(userId, "");
    setCachedDashboardSnapshot(key, { marker: true });
    expect(getCachedDashboardSnapshot(key)).toEqual({ marker: true });

    const { POST } = await import("../app/api/notifications/ack/route");
    const response = await POST(
      new Request("http://localhost/api/notifications/ack", {
        method: "POST",
        headers: { "content-type": "application/json", "x-authenticated-user-email": "mail@jays.services" },
        body: JSON.stringify({ ids: [] })
      })
    );
    expect(response.status).toBe(200);
    expect(getCachedDashboardSnapshot(key)).toBeUndefined();
  });
});
