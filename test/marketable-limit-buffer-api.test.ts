/**
 * /api/policy validation for tuning.marketableLimitBufferBps (PR #1228 review). The field prices
 * marketable-limit entries AND extended-hours protective exits: zero/negative INVERTS the marketable
 * price (a SELL limit above the quote rests unfilled), and >500 bps (5% through the quote) is a
 * typo/units mistake — the route rejects both so a nonsense buffer can never be stored. (The exit
 * path additionally clamps already-stored values — see extendedHoursExitBufferBps.)
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mktlimit-buffer-api-${randomUUID()}.db`)}`;
});

function putTuning(tuning: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tuning })
  });
}

describe("/api/policy — tuning.marketableLimitBufferBps validation", () => {
  it("accepts and persists a sane buffer", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(putTuning({ marketableLimitBufferBps: 25 }));
    expect(response.status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).tuning?.marketableLimitBufferBps).toBe(25);
  });

  it("rejects zero, negative, non-finite, and absurd values with a clear 400", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const bad of [0, -15, 501, 10_000, "15"]) {
      const response = await PUT(putTuning({ marketableLimitBufferBps: bad }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("tuning.marketableLimitBufferBps must be greater than 0 and at most 500 (bps).");
    }
  });

  it("a STORED out-of-range value never blocks unrelated policy saves (bound applies only when the request changes the field)", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    // Seed a stored value the route would reject, as if written before the bound existed. The
    // runtime already clamps/defaults it (validatedMarketableLimitBufferBps) — validation must not
    // hold every other setting hostage to it.
    setPolicy({ ...DEFAULT_POLICY, tuning: { marketableLimitBufferBps: 10_000 } }, DEFAULT_REQUEST_USER_ID);

    const unrelated = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxDailyOrders: 7 })
      })
    );
    expect(unrelated.status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).maxDailyOrders).toBe(7);
    // The stale stored value passes through untouched (runtime clamps it at use).
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).tuning?.marketableLimitBufferBps).toBe(10_000);

    // A request that actually CHANGES the field is still bounded.
    const changing = await PUT(putTuning({ marketableLimitBufferBps: 9_999 }));
    expect(changing.status).toBe(400);
  });
});
