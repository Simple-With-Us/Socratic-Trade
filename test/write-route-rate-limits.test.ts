import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMITS, resetRateLimiter } from "../src/lib/rate-limit";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-write-rate-limits-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetRateLimiter();
});

const authHeaders = {
  "x-authenticated-user-email": "ratelimit-owner@example.com",
  "x-authenticated-identity-source": "authjs-session",
  "content-type": "application/json"
};

describe("write-route rate limits (ST-4658)", () => {
  it("POST /api/keys returns 429 after the settings-write bound", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../app/api/keys/route");
    const limit = RATE_LIMITS.settingsWrite.limit;
    let lastStatus = 0;
    for (let i = 0; i < limit; i++) {
      const res = await POST(new NextRequest("http://localhost/api/keys", {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ service: "openai", apiKey: "sk-test-1234567890abcdef" })
      }));
      lastStatus = res.status;
      expect(lastStatus).toBe(200);
    }
    const blocked = await POST(new NextRequest("http://localhost/api/keys", {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ service: "openai", apiKey: "sk-test-1234567890abcdef" })
    }));
    expect(blocked.status).toBe(429);
  });

  it("DELETE /api/keys returns 429 after the settings-write bound", async () => {
    const { NextRequest } = await import("next/server");
    const { DELETE } = await import("../app/api/keys/route");
    const limit = RATE_LIMITS.settingsWrite.limit;
    for (let i = 0; i < limit; i++) {
      const res = await DELETE(new NextRequest("http://localhost/api/keys?service=openai", { method: "DELETE", headers: authHeaders }));
      expect(res.status).toBe(200);
    }
    const blocked = await DELETE(new NextRequest("http://localhost/api/keys?service=openai", { method: "DELETE", headers: authHeaders }));
    expect(blocked.status).toBe(429);
  });

  it("PUT /api/policy returns 429 after the settings-write bound", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const limit = RATE_LIMITS.settingsWrite.limit;
    const put = () => PUT(new Request("http://localhost/api/policy", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tuning: { volTargeting: false } })
    }));
    for (let i = 0; i < limit; i++) {
      expect((await put()).status).toBe(200);
    }
    expect((await put()).status).toBe(429);
  });

  it("POST /api/notifications/test returns 429 after the notification-test bound", async () => {
    const { POST } = await import("../app/api/notifications/test/route");
    const limit = RATE_LIMITS.notificationTest.limit;
    const post = () => POST(new Request("http://localhost/api/notifications/test", { method: "POST" }));
    for (let i = 0; i < limit; i++) {
      expect((await post()).status).toBe(200);
    }
    expect((await post()).status).toBe(429);
  });
});
