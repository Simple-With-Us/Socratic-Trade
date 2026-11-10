import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * The health route AWAITS the trading-liveness summary.
 *
 * ST-4561: the summary's `audit_events` halt-cause sweep moved off the serving event loop, so
 * `getTradingLivenessSummary` is a Promise now.  Without the await the route would project the
 * PROMISE into the payload: `toPublicTradingLiveness` reads `summary.accounts`, which is
 * undefined on a Promise, so the projection throws, the route's catch answers with the all-zero
 * "no accounts" projection, and the monitor loses the fleet-dark signal.
 *
 * The stub hands back a DEFERRED promise, so the route has to wait for it.  The control
 * assertion is the projected counts: they can only come from the RESOLVED object, so removing
 * the await from the route fails this test.
 */

// DATABASE_URL is process-wide, so the value this file puts there is restored exactly when the
// suite ends.  Leaving it pointed at a temp database that the next suite cannot open breaks
// every later test in the same process.
const priorDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-liveness-await-${randomUUID()}.db`)}`;
});

afterAll(() => {
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
});

const HEALTH_URL = "http://localhost/api/health";

type Summary = import("../src/lib/trading-liveness").TradingLivenessSummary;

function summaryFixture(): Summary {
  return {
    staleMinutes: 0,
    maxConsecutiveFailures: 0,
    marketOpen: false,
    degraded: false,
    accounts: [
      {
        userId: "user-a",
        connectedAccountId: "acct-a",
        label: "Paper A",
        lastCompletedRunAt: null,
        lastCompletedRunAgeSeconds: null,
        consecutiveFailedRuns: 0,
        consecutiveHaltEligibleFailures: 0,
        strategyAuthority: "decide",
        marketOpen: false,
        degraded: false,
        degradedReasons: []
      },
      {
        userId: "user-a",
        connectedAccountId: "acct-b",
        label: "Paper B",
        lastCompletedRunAt: null,
        lastCompletedRunAgeSeconds: null,
        consecutiveFailedRuns: 0,
        consecutiveHaltEligibleFailures: 0,
        strategyAuthority: "propose",
        marketOpen: false,
        degraded: false,
        degradedReasons: []
      }
    ],
    darkness: {
      eligibleAccounts: 5,
      activeAccounts: 0,
      fleetActiveAccounts: 0,
      eligibleDeliberatelyIdle: 5,
      fullyDark: true,
      darkAccountLabels: ["Paper A"]
    }
  } as unknown as Summary;
}

describe("/api/health awaits the trading-liveness summary", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("projects the resolved summary, not the promise", async () => {
    const cache = await import("../src/lib/health-probe-cache");
    const healthRoute = await import("../app/api/health/route");

    const original = cache.healthProbeDeps.getTradingLivenessSummary;
    let release: (value: Summary) => void = () => undefined;
    const deferred = new Promise<Summary>((resolve) => {
      release = resolve;
    });
    cache.healthProbeDeps.getTradingLivenessSummary = (() => deferred) as typeof original;
    restore = () => {
      cache.healthProbeDeps.getTradingLivenessSummary = original;
    };

    const pending = healthRoute.GET(new Request(HEALTH_URL));
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    // The route must still be waiting for the summary: it has not answered yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    release(summaryFixture());

    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json();
    const liveness = body.checks.tradingLiveness;

    // The control assertion: these numbers exist only in the resolved object.
    expect(liveness.activeAccounts).toBe(2);
    expect(liveness.autopilotAccounts).toBe(1);
    expect(liveness.runningAskFirstAccounts).toBe(1);
    expect(liveness.autonomyEligibleAccounts).toBe(5);
    expect(liveness.autonomyFullyDark).toBe(true);
    expect(liveness.degraded).toBe(1);
    expect(body.checks.tradingLivenessDegraded).toBe(true);
  });
});
