// Next.js instrumentation hook - runs once at server startup.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function onRequestError(...args: unknown[]) {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...(args as Parameters<typeof Sentry.captureRequestError>));
}

export async function register() {
  if (typeof window !== "undefined") return;

  if (process.env.NEXT_RUNTIME === "edge") {
    if (process.env.SENTRY_DSN) {
      await import("./sentry.edge.config");
    }
    return;
  }

  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Fail fast if this deployment requires a secrets manager but wasn't launched through one
  // (REQUIRE_SECRETS_MANAGER set, but not started via start:secrets). Default off →
  // no effect on local dev / tests / CI. Runs before anything reads a credential.
  const { assertSecretsManagerIfRequired } = await import("./src/lib/secrets-source");
  assertSecretsManagerIfRequired();

  if (process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
  }

  // Migrate the operator's env broker/LLM keys into the `local` primary user's stores, so key
  // resolution is uniformly per-user (no special `local` env branch). Idempotent.
  const { migrateLocalEnvCredentials } = await import("./src/lib/db");
  migrateLocalEnvCredentials();
  const { migrateLocalRobinhoodToken } = await import("./src/lib/mcp-oauth");
  migrateLocalRobinhoodToken();

  const { startObservability } = await import("./src/lib/observability");
  await startObservability();

  const { startScheduler } = await import("./src/lib/scheduler");
  startScheduler();

  // Outbound streaming workers (opt-in; no-op unless enabled + keyed).
  const { startStreams } = await import("./src/lib/streams");
  startStreams();
}
