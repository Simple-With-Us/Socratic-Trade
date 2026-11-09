import { redactForTelemetry, safeErrorMessage } from "./telemetry-sanitize";
import {
  type DatadogLogStatus,
  datadogLogsEnabled,
  logStatusRank,
  resolveDatadogApiKey,
  resolveDatadogEnv,
  resolveDatadogService,
  resolveDatadogVersion,
  resolveLogsIntakeUrl,
  resolveLogsMinLevel
} from "./datadog-env";

const MAX_BATCH = 10;
const FLUSH_MS = 2000;
const MAX_QUEUE = 200;
const REQUEST_TIMEOUT_MS = 4000;

type DatadogLogEvent = {
  ddsource: string;
  ddtags: string;
  hostname: string;
  message: string;
  service: string;
  status: DatadogLogStatus;
  timestamp: number;
  "dd.trace_id"?: string;
  "dd.span_id"?: string;
};

type TracerLike = {
  scope?: () => {
    active?: () => {
      context?: () => {
        toTraceId?: () => string;
        toSpanId?: () => string;
      };
    };
  };
};

declare global {
   
  var __tradingDatadogLogsStarted: boolean | undefined;
   
  var __tradingDatadogLogQueue: DatadogLogEvent[] | undefined;
   
  var __tradingDatadogLogTimer: ReturnType<typeof setTimeout> | undefined;
   
  var __tradingDatadogConsoleWrapped: boolean | undefined;
   
  var _ddtrace: TracerLike | undefined;
}

const SKIP_PATHS = ["/api/live", "/api/health"];

export function emitDatadogLog(
  status: DatadogLogStatus,
  message: string,
  extra?: Record<string, unknown>
): void {
  if (!datadogLogsEnabled()) return;
  if (logStatusRank(status) < logStatusRank(resolveLogsMinLevel())) return;

  const trimmed = message.trim();
  if (!trimmed || trimmed.startsWith("[datadog]")) return;

  const redactedMessage = String(redactForTelemetry(trimmed) ?? trimmed);
  const redactedExtra = extra ? (redactForTelemetry(extra) as Record<string, unknown>) : undefined;
  const rendered =
    redactedExtra && Object.keys(redactedExtra).length > 0
      ? `${redactedMessage} ${safeJson(redactedExtra)}`
      : redactedMessage;

  enqueue({
    ddsource: "nodejs",
    ddtags: buildTags(),
    hostname: resolveHostname(),
    message: rendered.slice(0, 8000),
    service: resolveDatadogService(),
    status,
    timestamp: Date.now(),
    ...traceIds()
  });
}

export function emitDatadogRequestError(
  error: unknown,
  request: { path?: string; method?: string } | undefined
): void {
  const path = request?.path ?? "";
  if (SKIP_PATHS.some((skip) => path === skip || path.startsWith(`${skip}?`))) return;
  emitDatadogLog("error", safeErrorMessage(error), {
    path: path || undefined,
    method: request?.method
  });
}

export function startDatadogLogShipping(): void {
  if (globalThis.__tradingDatadogLogsStarted || !datadogLogsEnabled()) return;
  globalThis.__tradingDatadogLogsStarted = true;
  wrapConsole();
}

function wrapConsole(): void {
  if (globalThis.__tradingDatadogConsoleWrapped) return;
  globalThis.__tradingDatadogConsoleWrapped = true;

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    try {
      emitDatadogLog("warn", formatConsoleArgs(args));
    } catch {
      // Telemetry must never throw.
    }
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    try {
      emitDatadogLog("error", formatConsoleArgs(args));
    } catch {
      // Telemetry must never throw.
    }
  };
}

function enqueue(event: DatadogLogEvent): void {
  const queue = (globalThis.__tradingDatadogLogQueue ??= []);
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(event);
  if (queue.length >= MAX_BATCH) {
    void flushDatadogLogs();
    return;
  }
  if (!globalThis.__tradingDatadogLogTimer) {
    globalThis.__tradingDatadogLogTimer = setTimeout(() => {
      globalThis.__tradingDatadogLogTimer = undefined;
      void flushDatadogLogs();
    }, FLUSH_MS);
    globalThis.__tradingDatadogLogTimer.unref?.();
  }
}

export async function flushDatadogLogs(): Promise<void> {
  const apiKey = resolveDatadogApiKey();
  const queue = globalThis.__tradingDatadogLogQueue;
  if (!apiKey || !queue?.length) return;

  const batch = queue.splice(0, MAX_BATCH);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const response = await fetch(resolveLogsIntakeUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": apiKey
      },
      body: JSON.stringify(batch),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      // Leave the original console.error path alone; do not recurse into Datadog.
    }
  } catch {
    // Fail closed: drop the batch rather than crash or retry-storm.
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return String(redactForTelemetry(arg) ?? arg);
      if (arg instanceof Error) return safeErrorMessage(arg);
      return safeJson(redactForTelemetry(arg));
    })
    .join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function buildTags(): string {
  const tags = [`env:${resolveDatadogEnv()}`, `service:${resolveDatadogService()}`];
  const version = resolveDatadogVersion();
  if (version) tags.push(`version:${version}`);
  return tags.join(",");
}

function resolveHostname(): string {
  return (
    process.env.DD_HOSTNAME?.trim() ||
    process.env.HOSTNAME?.trim() ||
    process.env.COMPUTERNAME?.trim() ||
    "unknown"
  );
}

function traceIds(): { "dd.trace_id"?: string; "dd.span_id"?: string } {
  try {
    const context = globalThis._ddtrace?.scope?.()?.active?.()?.context?.();
    const traceId = context?.toTraceId?.();
    const spanId = context?.toSpanId?.();
    if (traceId && spanId) return { "dd.trace_id": traceId, "dd.span_id": spanId };
  } catch {
    // Tracer is optional.
  }
  return {};
}
