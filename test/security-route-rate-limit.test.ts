// G1 — Rate-limit /api/chat and /api/scan.
//
// Asserts a per-user burst past the configured limit returns HTTP 429 with a Retry-After header, on
// BOTH routes. The limiter fires at the very top of each handler (after resolveRequestUserId), before
// the LLM gate / market scan, so an over-limit request returns 429 without touching the DB/network.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";
import { rateLimit, RATE_LIMITS, resetRateLimiter } from "../src/lib/rate-limit";
import { POST as chatPost } from "../app/api/chat/route";
import { GET as scanGet } from "../app/api/scan/route";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-security-ratelimit-${randomUUID()}.db`)}`;
});

// Each user's bucket is per-email; use a distinct email per test so tests don't bleed into each other.
function reqWithEmail(url: string, email: string, init?: RequestInit): Request {
  return new Request(url, { ...init, headers: { ...(init?.headers ?? {}), [AUTHENTICATED_EMAIL_HEADER]: email } });
}

beforeEach(() => resetRateLimiter());
afterEach(() => resetRateLimiter());

describe("G1: /api/chat rate limit", () => {
  it("returns 429 with Retry-After once a per-user burst exceeds RATE_LIMITS.chat", async () => {
    const email = "chat-burst@example.com";
    const { limit } = RATE_LIMITS.chat;
    // Fire the full allowance. Message is missing on purpose — but the rate limiter runs BEFORE the
    // 400 "message is required" check, so each in-limit call returns 400, never consuming the LLM path.
    let sawRateLimited = false;
    for (let i = 0; i < limit + 2; i++) {
      const res = await chatPost(reqWithEmail("https://trading.example.com/api/chat", email, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}) // no message; irrelevant once rate-limited
      }));
      if (res.status === 429) {
        sawRateLimited = true;
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        break;
      }
      // Before the limit is hit, we get the 400 (message required), NOT a 429.
      expect(res.status).not.toBe(429);
    }
    expect(sawRateLimited).toBe(true);
  });

  it("isolates the limit per user (a different email is unaffected by another's burst)", async () => {
    const { limit } = RATE_LIMITS.chat;
    for (let i = 0; i < limit + 1; i++) {
      await chatPost(reqWithEmail("https://trading.example.com/api/chat", "heavy@example.com", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }));
    }
    // A fresh user's first request is not rate-limited (returns 400 for the missing message, not 429).
    const res = await chatPost(reqWithEmail("https://trading.example.com/api/chat", "fresh@example.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(res.status).not.toBe(429);
  });
});

describe("G1: /api/scan rate limit", () => {
  it("returns 429 with Retry-After once a per-user burst exceeds RATE_LIMITS.scan", async () => {
    const email = "scan-burst@example.com";
    const { limit } = RATE_LIMITS.scan;
    // Pre-saturate this user's `scan` bucket directly (avoids running the real, slow market scan on
    // every in-limit call). The handler builds the key as `${userId}:scan`, so mirror that exactly.
    const userId = resolveRequestUserFromEmail(email).userId;
    for (let i = 0; i < limit; i++) {
      expect(rateLimit(`${userId}:scan`, RATE_LIMITS.scan).allowed).toBe(true);
    }
    // The handler's own enforceRateLimit call is now the over-limit hit → 429 before any scan work.
    const res = await scanGet(reqWithEmail("https://trading.example.com/api/scan", email));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
