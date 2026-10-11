/**
 * Runtime Sentry release identity.  Matches `scripts/sentry-build-release.cjs`
 * so health, the bundler plugin, and OTel resource attributes name the same SHA.
 * Short / placeholder identities are refused so a 7-char Coolify fallback cannot
 * fork a parallel release from the 40-char health SHA.
 */

const SHA_KEYS = [
  "SENTRY_RELEASE",
  "APP_RELEASE_SHA",
  "SOURCE_COMMIT",
  "COOLIFY_COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA"
] as const;

export const SENTRY_SERVICE_NAME = "socratic-trade";

export function resolveSentryRelease(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  for (const key of SHA_KEYS) {
    const value = env[key]?.trim();
    if (!value || !/^[0-9a-f]{7,64}$/i.test(value)) continue;
    return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  return undefined;
}

/** Resource attributes for the Langfuse OTel provider so those spans carry a release. */
export function otelResourceAttributes(
  release: string | undefined = resolveSentryRelease()
): Record<string, string> {
  const attrs: Record<string, string> = { "service.name": SENTRY_SERVICE_NAME };
  if (release) {
    attrs["service.version"] = release;
    attrs["sentry.release"] = release;
  }
  return attrs;
}
