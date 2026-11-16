import { afterEach, describe, expect, it } from "vitest";
import {
  assertLivePreflight,
  liveTradingEnabledByEnv,
  LivePreflightError,
  type LivePreflightInput
} from "../src/lib/preflight-live-guard";

// Pure guard — no DB, no I/O. These tests assert the post-2026-07-07 contract: a no-op on the
// broker/paper path, and ALLOW-by-default on the real-capital (broker/live) path — the historic
// ALLOW_LIVE_TRADING opt-in gate is retired, surviving only as an opt-OUT escape hatch (=false
// disables). NEVER places a trade.

const originalAllowLive = process.env.ALLOW_LIVE_TRADING;

afterEach(() => {
  if (originalAllowLive === undefined) delete process.env.ALLOW_LIVE_TRADING;
  else process.env.ALLOW_LIVE_TRADING = originalAllowLive;
});

const brokerPaper: LivePreflightInput = { mode: "broker/paper" };
const brokerLive: LivePreflightInput = { mode: "broker/live" };

describe("assertLivePreflight — default-safe no-op cases", () => {
  it("is a no-op for a broker paper sandbox (no real capital)", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight(brokerPaper)).not.toThrow();
  });
});

describe("assertLivePreflight — broker/live path allows by default (opt-out escape hatch)", () => {
  it("ALLOWS a live order by default when the env flag is unset", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight({ ...brokerLive, symbol: "AAPL", side: "buy" })).not.toThrow();
  });

  it("ALLOWS a live order when explicitly enabled (env='true')", () => {
    process.env.ALLOW_LIVE_TRADING = "true";
    expect(() => assertLivePreflight(brokerLive)).not.toThrow();
  });

  it("BLOCKS a live order ONLY when explicitly disabled (env='false')", () => {
    process.env.ALLOW_LIVE_TRADING = "false";
    expect(() => assertLivePreflight({ ...brokerLive, symbol: "AAPL", side: "buy" })).toThrow(LivePreflightError);
    expect(() => assertLivePreflight(brokerLive)).toThrow(/explicitly DISABLED/i);
  });

  it("per-call allowLive:false overrides the default-on (still blocks)", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(() => assertLivePreflight({ ...brokerLive, allowLive: false })).toThrow(LivePreflightError);
  });

  it("per-call allowLive:true forces allow even when the env escape hatch disables", () => {
    process.env.ALLOW_LIVE_TRADING = "false";
    expect(() => assertLivePreflight({ ...brokerLive, allowLive: true })).not.toThrow();
  });
});

describe("liveTradingEnabledByEnv", () => {
  it("is true unless ALLOW_LIVE_TRADING is exactly 'false'", () => {
    delete process.env.ALLOW_LIVE_TRADING;
    expect(liveTradingEnabledByEnv()).toBe(true);
    process.env.ALLOW_LIVE_TRADING = "true";
    expect(liveTradingEnabledByEnv()).toBe(true);
    process.env.ALLOW_LIVE_TRADING = "1";
    expect(liveTradingEnabledByEnv()).toBe(true);
    process.env.ALLOW_LIVE_TRADING = "false";
    expect(liveTradingEnabledByEnv()).toBe(false);
  });
});
