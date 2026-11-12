// Match the public health identity at build time, before Sentry injects SDK release metadata.
// No credential or secret belongs in a release name.
function sentryBuildRelease(env = process.env) {
  const keys = ['APP_RELEASE_SHA', 'SOURCE_COMMIT', 'COOLIFY_COMMIT_SHA', 'GIT_COMMIT_SHA', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA'];
  for (const key of keys) {
    const value = env[key]?.trim();
    // Match getGitSha's first usable identity, skipping placeholders.
    if (!value || !/^[0-9a-f]{7,64}$/i.test(value)) continue;
    // A usable short identity masks later keys in health too.  Do not name
    // the bundle after a different fallback revision; let Sentry infer it.
    return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  return undefined; // Observability metadata must not stop application builds.
}
module.exports = { sentryBuildRelease };
