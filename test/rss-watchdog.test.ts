// RSS watchdog unit tests (2026-09-30 self-healing).
// Pure-function coverage: config resolution and the breach-evaluation step.
// The actual setInterval/exit path is not exercised (it calls process.exit).
import { describe, expect, it } from "vitest";

import {
  RSS_WATCHDOG_EXIT_CODE,
  evaluateRssSample,
  resolveRssWatchdogConfig,
} from "../src/lib/rss-watchdog";

const GB = 1024 * 1024 * 1024;

describe("resolveRssWatchdogConfig", () => {
  it("enables in production with generous defaults", () => {
    const c = resolveRssWatchdogConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(true);
    expect(c.limitBytes).toBe(8192 * 1024 * 1024);
    expect(c.intervalS).toBe(30);
    expect(c.breachSamples).toBe(3);
  });

  it("is disabled outside production", () => {
    const c = resolveRssWatchdogConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
  });

  it("ST_RSS_WATCHDOG=0 disables it even in production", () => {
    const c = resolveRssWatchdogConfig({
      NODE_ENV: "production",
      ST_RSS_WATCHDOG: "0",
    } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
  });

  it("honors env tuning with sane floors", () => {
    const c = resolveRssWatchdogConfig({
      NODE_ENV: "production",
      ST_RSS_LIMIT_MB: "4096",
      ST_RSS_WATCHDOG_INTERVAL_S: "10",
      ST_RSS_WATCHDOG_SAMPLES: "5",
    } as NodeJS.ProcessEnv);
    expect(c.limitBytes).toBe(4096 * 1024 * 1024);
    expect(c.intervalS).toBe(10);
    expect(c.breachSamples).toBe(5);
  });

  it("falls back on garbage env values", () => {
    const c = resolveRssWatchdogConfig({
      NODE_ENV: "production",
      ST_RSS_LIMIT_MB: "banana",
      ST_RSS_WATCHDOG_INTERVAL_S: "-3",
      ST_RSS_WATCHDOG_SAMPLES: "0",
    } as NodeJS.ProcessEnv);
    expect(c.limitBytes).toBe(8192 * 1024 * 1024);
    expect(c.intervalS).toBe(30);
    expect(c.breachSamples).toBe(3);
  });
});

describe("evaluateRssSample", () => {
  const config = resolveRssWatchdogConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv);

  it("resets the breach count when under the limit", () => {
    const r = evaluateRssSample(1 * GB, config, 2);
    expect(r.consecutiveBreaches).toBe(0);
    expect(r.shouldExit).toBe(false);
  });

  it("counts consecutive breaches and exits only at the threshold", () => {
    const over = 9 * GB;
    let r = evaluateRssSample(over, config, 0);
    expect(r).toEqual({ consecutiveBreaches: 1, shouldExit: false });
    r = evaluateRssSample(over, config, r.consecutiveBreaches);
    expect(r).toEqual({ consecutiveBreaches: 2, shouldExit: false });
    r = evaluateRssSample(over, config, r.consecutiveBreaches);
    expect(r).toEqual({ consecutiveBreaches: 3, shouldExit: true });
  });

  it("a single under-limit sample breaks the streak before exit", () => {
    const over = 9 * GB;
    let r = evaluateRssSample(over, config, 0);
    r = evaluateRssSample(over, config, r.consecutiveBreaches);
    expect(r.consecutiveBreaches).toBe(2);
    r = evaluateRssSample(1 * GB, config, r.consecutiveBreaches);
    expect(r).toEqual({ consecutiveBreaches: 0, shouldExit: false });
  });

  it("uses the documented exit code 44", () => {
    expect(RSS_WATCHDOG_EXIT_CODE).toBe(44);
  });
});
