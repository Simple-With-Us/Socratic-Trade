import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../middleware";

const repoRoot = join(import.meta.dirname, "..");

describe("Sentry browser tunnel", () => {
  it("enables tunnelRoute /monitoring in next.config.mjs", () => {
    const src = readFileSync(join(repoRoot, "next.config.mjs"), "utf8");
    expect(src).toMatch(/tunnelRoute:\s*"\/monitoring"/);
    expect(src).not.toMatch(/\/\/\s*tunnelRoute:\s*"\/monitoring"/);
  });

  it("excludes /monitoring from the middleware matcher", () => {
    const matcher = config.matcher;
    expect(Array.isArray(matcher)).toBe(true);
    expect(matcher[0]).toContain("monitoring");
    expect(matcher[0]).toMatch(/\(\?\!.*monitoring/);
  });

  it("defaults Session Replay to 10% session / 100% error with Feedback on", () => {
    const src = readFileSync(join(repoRoot, "instrumentation-client.ts"), "utf8");
    expect(src).toMatch(/NEXT_PUBLIC_SENTRY_REPLAY_ENABLED/);
    expect(src).toContain("replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false");
    expect(src).toContain('NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0.1"');
    expect(src).toContain('NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "1.0"');
    expect(src).toMatch(/feedbackIntegration\(/);
    expect(src).toMatch(/NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED/);
  });

  it("lists /monitoring as a public prefix so auth cannot 401 the tunnel", () => {
    const src = readFileSync(join(repoRoot, "middleware.ts"), "utf8");
    expect(src).toMatch(/"\/monitoring"/);
  });
});

describe("iOS SentryTelemetry DSN source", () => {
  it("reads SENTRY_DSN from Info.plist only and has no hardcoded ingest fallback", () => {
    const swift = readFileSync(join(repoRoot, "ios/SocraticTrade/SentryTelemetry.swift"), "utf8");
    expect(swift).toMatch(/plistString\("SENTRY_DSN"\)/);
    expect(swift).not.toMatch(/ingest\.us\.sentry\.io/);
    expect(swift).toMatch(/sessionReplay\.maskAllText = true/);
    // sentry-cocoa 9 replaced profilesSampleRate with configureProfiling.
    expect(swift).toMatch(/configureProfiling = \{[^}]*sessionSampleRate = 0\.1/);
    expect(swift).toMatch(/attachScreenshot = false/);
    const plist = readFileSync(join(repoRoot, "ios/SocraticTrade/Info.plist"), "utf8");
    expect(plist).toMatch(/<key>SENTRY_DSN<\/key>/);
  });
});
