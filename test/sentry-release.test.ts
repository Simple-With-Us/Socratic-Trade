import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { otelResourceAttributes, resolveSentryRelease, SENTRY_SERVICE_NAME } from "../src/lib/sentry-release";

const RELEASE_ENV_KEYS = [
  "SENTRY_RELEASE",
  "APP_RELEASE_SHA",
  "SOURCE_COMMIT",
  "COOLIFY_COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA"
] as const;

const repoRoot = join(import.meta.dirname, "..");
const sha = "a".repeat(40);
const other = "b".repeat(40);

describe("resolveSentryRelease", () => {
  it("prefers SENTRY_RELEASE then APP_RELEASE_SHA and refuses short placeholders", () => {
    expect(resolveSentryRelease({ SENTRY_RELEASE: sha, APP_RELEASE_SHA: other })).toBe(sha);
    expect(resolveSentryRelease({ APP_RELEASE_SHA: "unknown", SOURCE_COMMIT: sha })).toBe(sha);
    expect(resolveSentryRelease({ SOURCE_COMMIT: sha.slice(0, 12) })).toBeUndefined();
    expect(resolveSentryRelease({})).toBeUndefined();
  });
});

describe("otelResourceAttributes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("always names the service and stamps a full SHA as sentry.release", () => {
    for (const key of RELEASE_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    expect(otelResourceAttributes()).toEqual({ "service.name": SENTRY_SERVICE_NAME });
    expect(otelResourceAttributes(sha)).toEqual({
      "service.name": SENTRY_SERVICE_NAME,
      "service.version": sha,
      "sentry.release": sha
    });
  });
});

describe("runtime Sentry inits and iOS ship carry a release / DSN injection", () => {
  it("server, edge, and browser inits pass resolveSentryRelease()", () => {
    for (const file of ["sentry.server.config.ts", "sentry.edge.config.ts", "instrumentation-client.ts"]) {
      const src = readFileSync(join(repoRoot, file), "utf8");
      expect(src).toMatch(/release:\s*resolveSentryRelease\(\)/);
    }
  });

  it("Langfuse OTel provider uses otelResourceAttributes so LLM Generation spans get a release", () => {
    const src = readFileSync(join(repoRoot, "src/lib/observability.ts"), "utf8");
    expect(src).toMatch(/resourceFromAttributes\(otelResourceAttributes\(sentryRelease\)\)/);
  });
});
