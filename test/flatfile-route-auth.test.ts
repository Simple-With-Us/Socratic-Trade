// GET /api/market/flatfile is session-gated. A peer APP_B_INGEST_TOKEN bearer must not
// authorize the whole-market pull, and an authenticated session must not be able to
// stampede Massive/S3.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as flatfileRoute } from "../app/api/market/flatfile/route";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";
import { RATE_LIMITS, resetRateLimiter } from "../src/lib/rate-limit";
import { fetchGroupedBarsRest } from "../src/lib/market-signals/massive";
import { fetchGroupedDailyBars } from "../src/lib/market-signals/massive-s3";

vi.mock("../src/lib/market-signals/massive", () => ({
  fetchGroupedBarsRest: vi.fn()
}));
vi.mock("../src/lib/market-signals/massive-s3", () => ({
  fetchGroupedDailyBars: vi.fn()
}));

const mockRest = vi.mocked(fetchGroupedBarsRest);
const mockS3 = vi.mocked(fetchGroupedDailyBars);

const TEST_TOKEN = "st_ingest_test_secret";
const DATE = "2026-07-30";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-flatfile-auth-${randomUUID()}.db`)}`;
  for (const key of ["APP_B_INGEST_TOKEN", "AUTH_SECRET"]) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  resetRateLimiter();
  mockRest.mockReset();
  mockS3.mockReset();
  mockRest.mockResolvedValue([{ ticker: "AAPL", close: 10 }]);
  mockS3.mockResolvedValue([{ ticker: "AAPL", close: 10 }]);
  process.env.APP_B_INGEST_TOKEN = TEST_TOKEN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sessionRequest(search = `?date=${DATE}`): Request {
  return new Request(`http://localhost/api/market/flatfile${search}`, {
    headers: {
      [AUTHENTICATED_EMAIL_HEADER]: "alice@example.com",
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.localFallback
    }
  });
}

function bearerRequest(): Request {
  return new Request(`http://localhost/api/market/flatfile?date=${DATE}`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` }
  });
}

describe("GET /api/market/flatfile auth and rate limit", () => {
  it("returns 401 without a session and does not pull Massive or S3", async () => {
    const res = await flatfileRoute(new Request(`http://localhost/api/market/flatfile?date=${DATE}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(mockRest).not.toHaveBeenCalled();
    expect(mockS3).not.toHaveBeenCalled();
  });

  it("refuses a peer APP_B_INGEST_TOKEN bearer with no session", async () => {
    const res = await flatfileRoute(bearerRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(mockRest).not.toHaveBeenCalled();
    expect(mockS3).not.toHaveBeenCalled();
  });

  it("serves a session without the peer bearer", async () => {
    const res = await flatfileRoute(sessionRequest("?date=2026-07-30&symbol=aapl"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      date: DATE,
      asset: "stocks",
      symbol: "AAPL",
      bar: { ticker: "AAPL", close: 10 }
    });
    expect(mockRest).toHaveBeenCalledTimes(1);
    expect(mockS3).not.toHaveBeenCalled();
  });

  it("returns 429 when the session is over the flatfile limit and does not pull again", async () => {
    const limit = RATE_LIMITS.flatfile.limit;
    for (let i = 0; i < limit; i++) {
      const ok = await flatfileRoute(sessionRequest());
      expect(ok.status).toBe(200);
    }
    const blocked = await flatfileRoute(sessionRequest());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ ok: false });
    expect(mockRest).toHaveBeenCalledTimes(limit);
    expect(mockS3).not.toHaveBeenCalled();
  });

  it("still rejects a bad date for a session without pulling", async () => {
    const res = await flatfileRoute(sessionRequest("?date=yesterday"));
    expect(res.status).toBe(400);
    expect(mockRest).not.toHaveBeenCalled();
    expect(mockS3).not.toHaveBeenCalled();
  });
});

describe("middleware — flatfile bearer bypass stays refused", () => {
  it("does not let an APP_B_INGEST_TOKEN bearer past the session gate", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    process.env.APP_B_INGEST_TOKEN = TEST_TOKEN;
    const { middleware } = await import("../middleware.js");
    const res = await middleware(
      new NextRequest(`https://trading.example.com/api/market/flatfile?date=${DATE}`, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` }
      })
    );
    expect(res.status).toBe(401);
  });
});
