/**
 * In-app RSS watchdog (self-healing, 2026-09-30).
 *
 * The 2026-09-25 restart-loop fatal was kernel OOM kills from orphaned Qdrant
 * scroll operations: RSS ballooned until the kernel SIGKILLed the process.
 * A SIGKILL leaves no exit receipt, so the boot ledger can only report the
 * undifferentiated "no receipt (SIGKILL / OOM kill / host kill)" class, and a
 * tight OOM loop risks tripping the restart-loop fatal.  This watchdog samples
 * process.memoryUsage().rss on an interval and, when RSS stays above the
 * configured ceiling for a sustained run of samples, exits the process with
 * code 44 (RSS_WATCHDOG_EXIT_CODE) BEFORE the kernel OOM-killer fires.  A
 * receipted exit 44 is attributable in the boot ledger (code + call site +
 * rssBytes at death, via exit-guard/noteExitReceipt); a SIGKILL is not.
 *
 * The container runtime (restart=unless-stopped) restarts the process after
 * the exit, and the boot interlock then halts autonomy (the safe direction)
 * until the owner re-arms.  This is the last-resort net under the abort-signal
 * threading fix for the orphaned scroll (scheduler.ts): if some OTHER path
 * balloons RSS, this still converts a SIGKILL into a clean, explained restart.
 *
 * Default ceiling is deliberately generous (8 GB on a 16 GB box shared with
 * CT/UM/Coolify): normal ST RSS sits far below it, so the watchdog only fires
 * on genuine runaway growth.  Tune with ST_RSS_LIMIT_MB.  ST_RSS_WATCHDOG=0
 * disables it (e.g. for a deliberately large dev workload).
 *
 * Never throws; a broken watchdog must not take down the process it guards.
 */

export const RSS_WATCHDOG_EXIT_CODE = 44;

export interface RssWatchdogConfig {
  enabled: boolean;
  /** RSS ceiling in bytes. */
  limitBytes: number;
  /** Seconds between samples. */
  intervalS: number;
  /** Consecutive over-limit samples before exiting. */
  breachSamples: number;
}

export function resolveRssWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env
): RssWatchdogConfig {
  const enabled = env.ST_RSS_WATCHDOG !== "0" && env.NODE_ENV === "production";
  const limitMbRaw = Number(env.ST_RSS_LIMIT_MB);
  const limitBytes =
    (Number.isFinite(limitMbRaw) && limitMbRaw > 0 ? limitMbRaw : 8192) *
    1024 *
    1024;
  const intervalRaw = Number(env.ST_RSS_WATCHDOG_INTERVAL_S);
  const intervalS =
    Number.isFinite(intervalRaw) && intervalRaw >= 5 ? Math.floor(intervalRaw) : 30;
  const samplesRaw = Number(env.ST_RSS_WATCHDOG_SAMPLES);
  const breachSamples =
    Number.isFinite(samplesRaw) && samplesRaw >= 1 ? Math.floor(samplesRaw) : 3;
  return { enabled, limitBytes, intervalS, breachSamples };
}

export interface RssSample {
  rssBytes: number;
  overLimit: boolean;
}

/**
 * Pure evaluation step, exported for tests.  Returns the updated consecutive-
 * breach count and whether the process should exit now.
 */
export function evaluateRssSample(
  rssBytes: number,
  config: RssWatchdogConfig,
  consecutiveBreaches: number
): { consecutiveBreaches: number; shouldExit: boolean } {
  if (rssBytes > config.limitBytes) {
    const next = consecutiveBreaches + 1;
    return { consecutiveBreaches: next, shouldExit: next >= config.breachSamples };
  }
  return { consecutiveBreaches: 0, shouldExit: false };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * Start the watchdog.  Idempotent per process.  The timer is unref'd so it
 * never holds the process open on its own.  Returns a stop function.
 */
export function startRssWatchdog(
  env: NodeJS.ProcessEnv = process.env,
  proc: NodeJS.Process = process
): () => void {
  const config = resolveRssWatchdogConfig(env);
  const noop = () => {};
  if (!config.enabled) {
    if (env.NODE_ENV === "production") {
      console.log("[rss-watchdog] disabled (ST_RSS_WATCHDOG=0)");
    }
    return noop;
  }
  let consecutiveBreaches = 0;
  let warned = false;
  const timer = setInterval(() => {
    try {
      const rssBytes = proc.memoryUsage().rss;
      const step = evaluateRssSample(rssBytes, config, consecutiveBreaches);
      consecutiveBreaches = step.consecutiveBreaches;
      if (step.consecutiveBreaches > 0 && !warned) {
        warned = true;
        console.error(
          `[rss-watchdog] WARNING: RSS ${formatMb(rssBytes)} exceeds limit ${formatMb(
            config.limitBytes
          )} (sample 1/${config.breachSamples}); ` +
            `exiting with code ${RSS_WATCHDOG_EXIT_CODE} if it stays over for ` +
            `${config.breachSamples} consecutive samples`
        );
      }
      if (step.shouldExit) {
        console.error(
          `[rss-watchdog] FATAL: RSS ${formatMb(rssBytes)} exceeded limit ${formatMb(
            config.limitBytes
          )} for ${config.breachSamples} consecutive samples ` +
            `(${config.breachSamples * config.intervalS}s); exiting ${RSS_WATCHDOG_EXIT_CODE} ` +
            `before the kernel OOM-killer fires. The container runtime will restart the process.`
        );
        try {
          clearInterval(timer);
        } catch {
          /* never block the exit */
        }
        proc.exit(RSS_WATCHDOG_EXIT_CODE);
      }
    } catch {
      // A broken sampler must not take down the process it guards.
      consecutiveBreaches = 0;
    }
  }, config.intervalS * 1000);
  try {
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* ignore */
  }
  console.log(
    `[rss-watchdog] armed: limit=${formatMb(config.limitBytes)} ` +
      `interval=${config.intervalS}s breachSamples=${config.breachSamples} ` +
      `exitCode=${RSS_WATCHDOG_EXIT_CODE}`
  );
  return () => {
    try {
      clearInterval(timer);
    } catch {
      /* ignore */
    }
  };
}
