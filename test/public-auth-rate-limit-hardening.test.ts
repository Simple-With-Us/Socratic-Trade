import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";
import { rateLimit, RATE_LIMITS, resetRateLimiter } from "../src/lib/rate-limit";
import { ADMIN_OPERATION_LIMITS, resetAdminOperationInFlight } from "../src/lib/admin-operation-guard";
import { resetTuningSingleFlight } from "../src/lib/tuning-singleflight";
import { encodeSessionToken } from "../src/lib/auth/session-token";

const mocks = vi.hoisted(() => ({
  completeMcpOAuthCallback: vi.fn(),
  proposeStrategyTuning: vi.fn(),
  dryRunAutonomousWeightTuning: vi.fn(),
  getPolicy: vi.fn()
}));

vi.mock("@/lib/mcp-oauth", () => ({
  completeMcpOAuthCallback: mocks.completeMcpOAuthCallback,
  resolvePublicAppOrigin: () => "https://socratictrade.com"
}));

vi.mock("@/lib/strategy-tuning", () => ({
  proposeStrategyTuning: mocks.proposeStrategyTuning,
  dryRunAutonomousWeightTuning: mocks.dryRunAutonomousWeightTuning
}));

vi.mock("@/lib/db", () => ({
  getPolicy: mocks.getPolicy,
  // These rate-limit/single-flight tests never pass targetConnectedAccountId or hit GET/PATCH, so
  // plain no-op stubs are enough — they exist only so the route's unconditional
  // insertStrategyTuningReview call (and the optional-target ownership check) don't throw on an
  // undefined mock export.
  getActiveConnectedAccount: () => undefined,
  getConnectedAccount: () => undefined,
  getLatestOpenStrategyTuningReview: () => undefined,
  insertStrategyTuningReview: () => "mock-review-id",
  setStrategyTuningReviewStatus: () => true
}));

vi.mock("@/lib/user-write-fence", () => ({
  // These route-limit tests bypass middleware and do not exercise account recreation. Preserve the
  // already-resolved test identity without requiring a full SQLite account-generation fixture.
  resolveAuthenticatedAccountGeneration: (userId: string) => userId
}));

vi.mock("@/lib/tuning-invariants", () => ({
  validateTuningInvariants: () => ({ ok: true, violations: [] })
}));

vi.mock("@/lib/llm-request", () => ({
  ALL_LLM_REASONING_EFFORTS: []
}));

import { GET as robinhoodCallback } from "../app/api/auth/robinhood/callback/route";
import { POST as tuneStrategy } from "../app/api/strategy/tune/route";
import { GET as dryRunTuning } from "../app/api/admin/tuning-dry-run/route";

beforeEach(() => {
  vi.unstubAllEnvs();
  resetRateLimiter();
  resetAdminOperationInFlight();
  resetTuningSingleFlight();
  mocks.completeMcpOAuthCallback.mockReset().mockResolvedValue({ accessToken: "unused" });
  mocks.proposeStrategyTuning.mockReset().mockResolvedValue({ cautions: [], summary: "ok" });
  mocks.dryRunAutonomousWeightTuning.mockReset().mockResolvedValue({ wouldApply: false });
  mocks.getPolicy.mockReset().mockReturnValue({ tuning: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimiter();
  resetAdminOperationInFlight();
  resetTuningSingleFlight();
});

describe("public Robinhood OAuth callback rate limiting", () => {
  it("shares one pre-auth IP bucket across attacker-controlled state values", async () => {
    const clientIp = "203.0.113.10";
    for (let i = 0; i < RATE_LIMITS.oauth.limit; i++) {
      expect(rateLimit(`${clientIp}:auth/robinhood/callback`, RATE_LIMITS.oauth).allowed).toBe(true);
    }

    for (const state of ["attacker-state-a", "attacker-state-b"]) {
      const response = await robinhoodCallback(new NextRequest(
        `https://socratictrade.com/api/auth/robinhood/callback?code=fake&state=${state}`,
        { headers: { "cf-connecting-ip": clientIp } }
      ));
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    }
    expect(mocks.completeMcpOAuthCallback).not.toHaveBeenCalled();
  });

  it("does not trust X-Forwarded-For as a public limiter subject", async () => {
    for (let i = 0; i < RATE_LIMITS.oauth.limit; i++) {
      expect(rateLimit("unknown-ip:auth/robinhood/callback", RATE_LIMITS.oauth).allowed).toBe(true);
    }

    for (const spoofedIp of ["198.51.100.1", "198.51.100.2"]) {
      const response = await robinhoodCallback(new NextRequest(
        `https://socratictrade.com/api/auth/robinhood/callback?code=fake&state=${spoofedIp}`,
        { headers: { "x-forwarded-for": spoofedIp } }
      ));
      expect(response.status).toBe(429);
    }
    expect(mocks.completeMcpOAuthCallback).not.toHaveBeenCalled();
  });

  it("optionally binds the callback to a verified Auth.js session cookie", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    const email = "oauth-owner@example.com";
    vi.stubEnv("AUTH_SECRET", secret);
    const sessionToken = await encodeSessionToken({
      token: { email },
      secret,
      salt: "authjs.session-token",
      maxAge: 60 * 60
    });

    const response = await robinhoodCallback(new NextRequest(
      "https://socratictrade.com/api/auth/robinhood/callback?code=real-code&state=real-state",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.40",
          cookie: `authjs.session-token=${sessionToken}`
        }
      }
    ));

    expect(response.status).toBe(307);
    expect(mocks.completeMcpOAuthCallback).toHaveBeenCalledWith({
      code: "real-code",
      state: "real-state",
      expectedUserId: resolveRequestUserFromEmail(email).userId
    });
  });

  it("does not treat a client-supplied identity header as callback session binding", async () => {
    const response = await robinhoodCallback(new NextRequest(
      "https://socratictrade.com/api/auth/robinhood/callback?code=real-code&state=real-state",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.41",
          [AUTHENTICATED_EMAIL_HEADER]: "attacker@example.com"
        }
      }
    ));

    expect(response.status).toBe(307);
    expect(mocks.completeMcpOAuthCallback).toHaveBeenCalledWith({
      code: "real-code",
      state: "real-state",
      expectedUserId: undefined
    });
  });
});

describe("paid strategy tuning rate limiting", () => {
  it("returns 429 before paid work and remains isolated per user", async () => {
    const limitedEmail = "tuning-burst@example.com";
    const limitedUserId = resolveRequestUserFromEmail(limitedEmail).userId;
    for (let i = 0; i < RATE_LIMITS.strategyTuning.limit; i++) {
      expect(rateLimit(`${limitedUserId}:strategy/tune`, RATE_LIMITS.strategyTuning).allowed).toBe(true);
    }

    const limited = await tuneStrategy(new Request("https://socratictrade.com/api/strategy/tune", {
      method: "POST",
      headers: { [AUTHENTICATED_EMAIL_HEADER]: limitedEmail, "content-type": "application/json" },
      body: "{}"
    }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      ok: false,
      code: "rate_limited",
      operation: "strategy-tune",
      retryAfterSeconds: expect.any(Number),
      error: expect.any(String)
    });
    expect(mocks.proposeStrategyTuning).not.toHaveBeenCalled();

    const fresh = await tuneStrategy(new Request("https://socratictrade.com/api/strategy/tune", {
      method: "POST",
      headers: { [AUTHENTICATED_EMAIL_HEADER]: "fresh-tuning@example.com", "content-type": "application/json" },
      body: "{}"
    }));
    expect(fresh.status).toBe(200);
    expect(mocks.proposeStrategyTuning).toHaveBeenCalledTimes(1);
  });

  it("allows only one in-flight tuning review per user and releases the guard in finally", async () => {
    let resolveFirst!: (value: { cautions: string[]; summary: string }) => void;
    const firstDeferred = new Promise<{ cautions: string[]; summary: string }>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.proposeStrategyTuning
      .mockImplementationOnce(() => firstDeferred)
      .mockResolvedValue({ cautions: [], summary: "ok" });

    const requestFor = (email: string) => new Request("https://socratictrade.com/api/strategy/tune", {
      method: "POST",
      headers: { [AUTHENTICATED_EMAIL_HEADER]: email, "content-type": "application/json" },
      body: "{}"
    });

    const first = tuneStrategy(requestFor("same-user@example.com"));
    await vi.waitFor(() => expect(mocks.proposeStrategyTuning).toHaveBeenCalledTimes(1));

    const overlapping = await tuneStrategy(requestFor("same-user@example.com"));
    expect(overlapping.status).toBe(409);
    expect(await overlapping.json()).toMatchObject({
      ok: false,
      code: "operation_in_flight",
      operation: "strategy-tune",
      activeOperation: "strategy-tune",
      error: "strategy_tuning_in_progress",
      message: "A strategy tuning review is already in progress."
    });
    expect(mocks.proposeStrategyTuning).toHaveBeenCalledTimes(1);

    const otherUser = await tuneStrategy(requestFor("other-user@example.com"));
    expect(otherUser.status).toBe(200);
    expect(mocks.proposeStrategyTuning).toHaveBeenCalledTimes(2);

    resolveFirst({ cautions: [], summary: "first complete" });
    expect((await first).status).toBe(200);

    const afterRelease = await tuneStrategy(requestFor("same-user@example.com"));
    expect(afterRelease.status).toBe(200);
    expect(mocks.proposeStrategyTuning).toHaveBeenCalledTimes(3);
  });

  it("mutually excludes public tuning and the admin dry run for the same user", async () => {
    const email = "cross-route-tuning@example.com";
    vi.stubEnv("ADMIN_USER_EMAILS", email);
    const publicRequest = () => new Request("https://socratictrade.com/api/strategy/tune", {
      method: "POST",
      headers: { [AUTHENTICATED_EMAIL_HEADER]: email, "content-type": "application/json" },
      body: "{}"
    });
    const adminRequest = () => new Request("https://socratictrade.com/api/admin/tuning-dry-run", {
      headers: {
        [AUTHENTICATED_EMAIL_HEADER]: email,
        [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
      }
    });

    let resolveDryRun!: (value: { wouldApply: boolean }) => void;
    const dryRunDeferred = new Promise<{ wouldApply: boolean }>((resolve) => {
      resolveDryRun = resolve;
    });
    mocks.dryRunAutonomousWeightTuning.mockImplementationOnce(() => dryRunDeferred);

    const dryRun = dryRunTuning(adminRequest());
    await vi.waitFor(() => expect(mocks.dryRunAutonomousWeightTuning).toHaveBeenCalledTimes(1));

    for (let i = 0; i < RATE_LIMITS.strategyTuning.limit + 2; i += 1) {
      const publicBlocked = await tuneStrategy(publicRequest());
      expect(publicBlocked.status).toBe(409);
      expect(await publicBlocked.json()).toMatchObject({
        ok: false,
        code: "operation_in_flight",
        operation: "strategy-tune",
        activeOperation: "tuning-dry-run",
        error: "strategy_tuning_in_progress",
        message: "A strategy tuning review is already in progress."
      });
    }
    expect(mocks.proposeStrategyTuning).not.toHaveBeenCalled();

    resolveDryRun({ wouldApply: false });
    expect((await dryRun).status).toBe(200);

    let resolvePublic!: (value: { cautions: string[]; summary: string }) => void;
    const publicDeferred = new Promise<{ cautions: string[]; summary: string }>((resolve) => {
      resolvePublic = resolve;
    });
    mocks.proposeStrategyTuning.mockImplementationOnce(() => publicDeferred);

    const publicTune = tuneStrategy(publicRequest());
    await vi.waitFor(() => expect(mocks.proposeStrategyTuning).toHaveBeenCalledTimes(1));

    const adminBlocked = await dryRunTuning(adminRequest());
    expect(adminBlocked.status).toBe(409);
    expect(await adminBlocked.json()).toMatchObject({
      ok: false,
      code: "operation_in_flight",
      operation: "tuning-dry-run",
      activeOperation: "strategy-tune",
      error: expect.any(String)
    });
    expect(mocks.dryRunAutonomousWeightTuning).toHaveBeenCalledTimes(1);

    resolvePublic({ cautions: [], summary: "public complete" });
    expect((await publicTune).status).toBe(200);

    // The initial accepted public call spent one hit; neither the many public 409s while the dry
    // run was active nor the rejected admin call above spent either route's remaining budget.
    for (let i = 1; i < RATE_LIMITS.strategyTuning.limit; i += 1) {
      expect((await tuneStrategy(publicRequest())).status).toBe(200);
    }
    expect((await tuneStrategy(publicRequest())).status).toBe(429);

    for (let i = 1; i < ADMIN_OPERATION_LIMITS["tuning-dry-run"].limit; i += 1) {
      expect((await dryRunTuning(adminRequest())).status).toBe(200);
    }
    expect((await dryRunTuning(adminRequest())).status).toBe(429);
  });
});
