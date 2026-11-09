const RELEASE_SHA_KEYS = [
  "APP_RELEASE_SHA",
  "SOURCE_COMMIT",
  "COOLIFY_COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA"
] as const;

/**
 * Resolves the deployed git commit SHA from standard environment variables.
 * Pure function with no Node.js filesystem or network dependencies, safe for browser/edge builds.
 */
export function getGitSha(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const key of RELEASE_SHA_KEYS) {
    const value = env[key]?.trim();
    if (value && /^[a-f0-9]{7,64}$/i.test(value)) {
      return value.toLowerCase();
    }
  }
  return undefined;
}
