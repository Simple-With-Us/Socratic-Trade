/**
 * Sentry Application Metrics + sparse structured logs for Socratic-Trade.
 *
 * Operational telemetry only: scheduler ticks, broker calls, RAG rejections,
 * embedding failures. Dynamic-imports `@sentry/nextjs` so importing this
 * module never loads the SDK (scheduler inertness tests depend on that).
 * Fail-soft: metrics and logs must never throw into trading/RAG control flow.
 *
 * Do not dual-ship the Datadog access-log firehose here. Datadog stays the
 * warehouse; these are sparse, trace-attached health events.
 */

import type * as SentryNs from "@sentry/nextjs";

type SentryMod = typeof SentryNs;
type LogAttrs = Record<string, string | number | boolean | null | undefined>;

let cached: Promise<SentryMod | null> | undefined;

function resolveSentryMod(mod: unknown): SentryMod | null {
  if (!mod || typeof mod !== "object") return null;
  const rec = mod as SentryMod & { default?: SentryMod };
  if (typeof rec.metrics?.count === "function") return rec;
  if (typeof rec.default?.metrics?.count === "function") return rec.default;
  return rec.default ?? rec;
}

function loadSentry(): Promise<SentryMod | null> {
  if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return Promise.resolve(null);
  }
  if (!cached) {
    cached = import("@sentry/nextjs")
      .then((mod) => resolveSentryMod(mod))
      .catch(() => null);
  }
  return cached;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactAttrs(attrs: LogAttrs | undefined): Record<string, string | number | boolean> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function recordSchedulerTick(status: "ok" | "error" | "overrun", durationMs?: number): void {
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.metrics.count("scheduler.tick", 1, { attributes: { status } });
      if (status === "overrun") {
        Sentry?.metrics.count("scheduler.overrun", 1);
      }
      const duration = finiteNumber(durationMs);
      if (duration !== undefined) {
        Sentry?.metrics.distribution("scheduler.duration_ms", duration, {
          unit: "millisecond",
          attributes: { status }
        });
      }
    } catch {
      // Fail-soft: metrics should never crash execution
    }
  });
}

export function recordBrokerCall(
  broker: string,
  endpoint: string,
  durationMs: number,
  status: "success" | "failure"
): void {
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.metrics.count("broker.call", 1, { attributes: { broker, endpoint, status } });
      const duration = finiteNumber(durationMs);
      if (duration !== undefined) {
        Sentry?.metrics.distribution("broker.call_duration_ms", duration, {
          unit: "millisecond",
          attributes: { broker, endpoint, status }
        });
      }
    } catch {
      // Fail-soft
    }
  });
}

export function recordRagRejection(reason: string, provider?: string): void {
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.metrics.count("rag.rejected", 1, {
        attributes: { reason, provider: provider ?? "unknown" }
      });
    } catch {
      // Fail-soft
    }
  });
}

export function recordEmbedFailure(provider: string, errorType: string): void {
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.metrics.count("embed.failed", 1, { attributes: { provider, error_type: errorType } });
    } catch {
      // Fail-soft
    }
  });
}

/** Count of EOD series withheld because the newest close is behind the latest completed session. */
export function recordCongressStalePriceWithheld(stream: "push" | "pull", count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.metrics.count("congress_share.stale_price_withheld", count, {
        attributes: { stream }
      });
    } catch {
      // Fail-soft
    }
  });
}

/** Sparse Sentry structured log. No-op when the SDK is absent or uninitialized. */
export function logWarn(message: string, attributes?: LogAttrs): void {
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.logger.warn(message, compactAttrs(attributes));
    } catch {
      // Fail-soft
    }
  });
}

const PROXY_GATE_ALERT_INTERVAL_MS = 10 * 60 * 1000;
let lastProxyGateAlertAt = 0;

type SentryGauge = (name: string, value: number, options?: { unit?: string }) => void;

/**
 * Publish proxy-gate counters.  A hold older than 60s files one warning per
 * ten minutes so a leaked slot is visible without a new issue on every poll.
 * Fail-soft: metrics must not break `/api/proxy-use`.
 */
export function recordProxyGateSnapshot(stats: {
  inFlight: number;
  queued: number;
  oldestHoldMs: number;
}): void {
  void loadSentry().then((Sentry) => {
    try {
      const gauge = (Sentry?.metrics as { gauge?: SentryGauge } | undefined)?.gauge;
      gauge?.("proxy.gate.in_flight", stats.inFlight);
      gauge?.("proxy.gate.queued", stats.queued);
      gauge?.("proxy.gate.oldest_hold_ms", stats.oldestHoldMs, { unit: "millisecond" });
      const now = Date.now();
      if (stats.oldestHoldMs > 60_000 && now - lastProxyGateAlertAt >= PROXY_GATE_ALERT_INTERVAL_MS) {
        lastProxyGateAlertAt = now;
        Sentry?.captureMessage("proxy concurrency gate oldest hold exceeds 60s", {
          level: "warning",
          tags: { area: "proxy-gate" },
          extra: {
            inFlight: stats.inFlight,
            queued: stats.queued,
            oldestHoldMs: stats.oldestHoldMs
          }
        });
      }
    } catch {
      // Fail-soft
    }
  });
}

/** Sparse Sentry structured log. No-op when the SDK is absent or uninitialized. */
export function logError(message: string, attributes?: LogAttrs): void {
  void loadSentry().then((Sentry) => {
    try {
      Sentry?.logger.error(message, compactAttrs(attributes));
    } catch {
      // Fail-soft
    }
  });
}
