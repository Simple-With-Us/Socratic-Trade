// Match the public health identity at build time, before Sentry injects SDK release metadata.
// No credential or secret belongs in a release name.
function sentryBuildRelease(env = process.env) {
  const keys = ['APP_RELEASE_SHA', 'SOURCE_COMMIT', 'COOLIFY_COMMIT_SHA', 'GIT_COMMIT_SHA', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA'];
  const raw = keys.map((key) => env[key]).find((value) => typeof value === 'string' && value.trim());
  if (!raw) return undefined; // Local/CI builds can retain Sentry's default inference.
  if (!/^[0-9a-f]{40}$/i.test(raw.trim())) throw new Error('Sentry build release requires a full source SHA');
  return raw.trim().toLowerCase();
}
module.exports = { sentryBuildRelease };
