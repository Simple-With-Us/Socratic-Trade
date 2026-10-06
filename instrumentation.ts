// Next.js instrumentation hook - runs once at server startup.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function onRequestError(...args: unknown[]) {
  if (process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...(args as Parameters<typeof Sentry.captureRequestError>));
  }
  if (process.env.NEXT_RUNTIME !== "edge") {
    try {
      const { datadogLogsEnabled } = await import("./src/lib/datadog-env");
      if (!datadogLogsEnabled()) return;
      const { emitDatadogRequestError } = await import("./src/lib/datadog-logs");
      const [error, request] = args;
      emitDatadogRequestError(error, request as { path?: string; method?: string } | undefined);
    } catch {
      // Datadog is optional telemetry and must never fail the request error hook.
    }
  }
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

  // next.config.mjs also sets this, but instrumentation is the guaranteed server-boot hook across
  // build modes/containers (the prod box moved to Coolify; the 2026-07-06 IPv6-blackhole fix — see
  // docs/rollouts/2026-07-06-api-health-timeouts.md — must hold there too). Run this FIRST, before
  // any other import below can trigger a network call. webpackIgnore: this file is also compiled for
  // the edge runtime above, and webpack has no "node:dns" handling for that target's bundle — the
  // comment keeps this a real runtime dynamic import instead of a build-time bundle attempt.
  const dns = await import(/* webpackIgnore: true */ "node:dns");
  dns.setDefaultResultOrder("ipv4first");

  // Process-exit receipts + the "no spontaneous exit 0" tripwire (production-gated;
  // no-op in dev/tests). Installed before anything below can exit or receive a stop
  // signal. See src/lib/exit-guard.ts and docs/rollouts/2026-08-02-exit0-outage-audit.md.
  const { installProcessExitGuard } = await import("./src/lib/exit-guard");
  const { recordBoot, noteExitReceipt, reportRestartLoop, readRecentWatchdogKill } = await import("./src/lib/boot-ledger");
  installProcessExitGuard(process, { receipt: noteExitReceipt });
  // Durable boot/exit ledger on the persistent data volume + restart-loop detection (board a9676caf).
  // Container logs (and the exit-guard receipts above) die with the container when Coolify replaces it
  // on restart; this keeps one JSON line per boot/exit beside the DB.  Synchronous, never throws.
  const restartAssessment = recordBoot();

  // Attribute a previous-container liveness-watchdog kill (scripts/coolify-prod-start.sh,
  // 2026-09-30 self-healing): without this, the exit-guard receipt for a watchdog
  // restart just shows SIGTERM and the next boot cannot tell it from a deploy stop.
  const watchdogKill = readRecentWatchdogKill();
  if (watchdogKill) {
    console.error(`[boot-ledger] previous container killed by liveness watchdog: ${watchdogKill}`);
  }

  // Fail fast if this deployment requires a secrets manager but wasn't launched through one
  // (REQUIRE_SECRETS_MANAGER set, but not started via start:secrets). Default off →
  // no effect on local dev / tests / CI. Runs before anything reads a credential.
  const { assertSecretsManagerIfRequired } = await import("./src/lib/secrets-source");
  assertSecretsManagerIfRequired();

  // Infisical sole-source-of-truth settings cache (fleet directive 2026-10-03): load the
  // app-level settings set into memory at startup; background refresh + SIGHUP reload;
  // write-through on admin saves.  Fail-soft by design — the runner already injected the
  // Infisical-sourced values into process.env, so a failed settings init must never take
  // the trading box down.  See INFISICAL.md and src/lib/infisical-settings.ts.
  const { initInfisicalSettings } = await import("./src/lib/infisical-settings");
  await initInfisicalSettings();

  // Fail fast in PRODUCTION if ENCRYPTION_KEY is missing/malformed — a trading app must never
  // silently mint a per-process ephemeral encryption key (stored credentials would become
  // unreadable after every restart). No effect in dev/test (a deterministic warning fires there
  // instead — see db-api-keys.ts). Runs before anything reads/writes a credential.
  const { assertEncryptionKeyConfiguredInProduction } = await import("./src/lib/db-api-keys");
  assertEncryptionKeyConfiguredInProduction();

  const { assertAuthSecretConfiguredInLiveBootstrap } = await import("./src/lib/auth-secret-guard");
  assertAuthSecretConfiguredInLiveBootstrap();

  if (process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
    try {
      // Same webpackIgnore shape as profiling below.  A static @sentry/node
      // import is traced into the Edge compile of this file and fails the build.
      const sentryNodePkg = "@sentry/node";
      const loaded = (await import(/* webpackIgnore: true */ sentryNodePkg)) as typeof import("@sentry/node") & {
        default?: typeof import("@sentry/node");
      };
      const sentryNode =
        typeof loaded.nodeRuntimeMetricsIntegration === "function" ? loaded : loaded.default;
      const sentryNext = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
        default?: typeof import("@sentry/nextjs");
      };
      // Raw Node ESM can put CJS exports on `.default` (same interop as scheduler.ts).
      const addIntegration = sentryNext.addIntegration ?? sentryNext.default?.addIntegration;
      if (!sentryNode || typeof addIntegration !== "function") {
        console.warn("[sentry] node AI integrations not attached", {
          module: Boolean(sentryNode),
          addIntegration: typeof addIntegration
        });
      } else {
        const attach = (name: string, register: () => void) => {
          try {
            register();
          } catch (err) {
            // One failing factory must not drop the other five, and a silent
            // catch would look the same as "instrumentation is on".
            console.warn(`[sentry] failed to attach integration ${name}`, err);
          }
        };
        attach("nodeRuntimeMetricsIntegration", () => {
          addIntegration(sentryNode.nodeRuntimeMetricsIntegration());
        });
        attach("openAIIntegration", () => {
          addIntegration(sentryNode.openAIIntegration());
        });
        attach("anthropicAIIntegration", () => {
          addIntegration(sentryNode.anthropicAIIntegration());
        });
        attach("googleGenAIIntegration", () => {
          addIntegration(sentryNode.googleGenAIIntegration());
        });
        attach("vercelAIIntegration", () => {
          addIntegration(sentryNode.vercelAIIntegration());
        });
        attach("langChainIntegration", () => {
          addIntegration(sentryNode.langChainIntegration());
        });
      }
    } catch (err) {
      // Node-only SDK.  A missing module must not take down Sentry.init.
      console.warn("[sentry] @sentry/node not loadable on this runtime", err);
    }
    try {
      const profilingPkg = "@sentry/profiling-node";
      const { nodeProfilingIntegration } = (await import(
        /* webpackIgnore: true */ profilingPkg
      )) as { nodeProfilingIntegration: () => any };
      const Sentry = await import("@sentry/nextjs");
      Sentry.addIntegration(nodeProfilingIntegration());
    } catch {
      // Native profiler is optional.  Missing binary must not take down Sentry.init.
    }
  }

  // Loud, fire-and-forget: a restart loop is exactly when boot itself may be unhealthy, so this must not
  // block or fail startup.  Runs after Sentry init so the fatal message is actually captured.
  void reportRestartLoop(restartAssessment).catch(() => {});

  // Stall-triggered CPU profiler (board 687a5fb4; stall class e7b49943).  Keeps a low-rate V8
  // sampling profile running and saves a window to /app/data/profiles (+ a cat-able .top.json)
  // only when the event-loop lag sampler saw >= 5s of stall in it, so the next RTH stall names
  // its culprit.  Armed before the scheduler and background workers so their stalls are covered.
  // Production-only by default; STALL_PROFILER=0 kills it.  Never throws and never blocks boot.
  // See src/lib/stall-profiler.ts and docs/rollouts/2026-09-24-st-stall-profiler.md.
  try {
    const { startStallProfiler } = await import("./src/lib/stall-profiler");
    void startStallProfiler().catch(() => {});
  } catch {
    // Optional diagnostics must never take down boot.
  }

  // In-app RSS watchdog (self-healing 2026-09-30): samples process RSS and
  // exits 44 before the kernel OOM-killer fires, so a runaway allocation
  // (e.g. an orphaned vector scroll) becomes a receipted, attributable restart
  // instead of a SIGKILL.  ST_RSS_WATCHDOG=0 disables; ST_RSS_LIMIT_MB tunes.
  // Never throws and never blocks boot.  See src/lib/rss-watchdog.ts.
  try {
    const { startRssWatchdog } = await import("./src/lib/rss-watchdog");
    startRssWatchdog();
  } catch {
    // Optional protection must never take down boot.
  }

  const { datadogApmEnabled, datadogLogsEnabled } = await import("./src/lib/datadog-env");
  if (datadogApmEnabled() || datadogLogsEnabled()) {
    const { startDatadogServer } = await import("./src/lib/datadog-server");
    await startDatadogServer();
  }

  // Migrate the operator's env broker/LLM keys into the `local` primary user's stores, so key
  // resolution is uniformly per-user (no special `local` env branch). Idempotent.
  const { migrateLocalEnvCredentials } = await import("./src/lib/db");
  migrateLocalEnvCredentials();
  const { migrateLocalRobinhoodToken } = await import("./src/lib/mcp-oauth");
  migrateLocalRobinhoodToken();

  // One-time, idempotent re-encryption of any legacy PLAINTEXT credential rows now that a real
  // (non-ephemeral) ENCRYPTION_KEY is confirmed available. No-ops silently when only the
  // per-process ephemeral fallback key is active (dev without ENCRYPTION_KEY set) — re-encrypting
  // under a throwaway key would make that data less recoverable, not more.
  const { migrateLegacyPlaintextCredentialsIfKeyConfigured } = await import("./src/lib/db-api-keys");
  migrateLegacyPlaintextCredentialsIfKeyConfigured();

  const { startObservability } = await import("./src/lib/observability");
  await startObservability();

  // Production keeps all process-level workers on by default. Local development and tests fail
  // closed unless DEV_BACKGROUND_WORKERS=on is explicit, preventing a UI-only dev server from
  // launching broker/provider/RAG work against a credentialed or copied database.
  const { startServerBackgroundWorkers } = await import("./src/lib/background-worker-startup");
  await startServerBackgroundWorkers();

  // Warm up Qdrant if configured and enabled for reads, so the first real retrieval doesn't block
  // on cold-cache fault-in.
  const { warmupQdrantHotTenants } = await import("./src/lib/vector-db");
  warmupQdrantHotTenants().catch(() => {});
}
