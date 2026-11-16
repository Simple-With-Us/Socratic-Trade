/** Shared Datadog env resolution.  No secrets are invented here -- only official DD_* names. */

export const DEFAULT_DD_SITE = "us5.datadoghq.com";
export const DEFAULT_DD_SERVICE = "socratic-trade";
export const DEFAULT_TRACE_SAMPLE_RATE = 0.1;
export const DEFAULT_RUM_SESSION_SAMPLE_RATE = 100;
export const DEFAULT_LOGS_MIN_LEVEL = "warn";

export type DatadogLogStatus = "debug" | "info" | "warn" | "error";

export type PublicRumConfig = {
  applicationId: string;
  clientToken: string;
  site: string;
  service: string;
  env: string;
  version?: string;
  sessionSampleRate: number;
  sessionReplaySampleRate: number;
  sessionReplayEnabled: boolean;
};

export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function flagOff(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

export function resolveDatadogSite(): string {
  return firstNonEmpty(process.env.DD_SITE, process.env.NEXT_PUBLIC_DD_SITE) ?? DEFAULT_DD_SITE;
}

export function resolveDatadogService(): string {
  return firstNonEmpty(process.env.DD_SERVICE, process.env.NEXT_PUBLIC_DD_SERVICE) ?? DEFAULT_DD_SERVICE;
}

/** Map Coolify/handoff `prod` onto Datadog `production` so dashboards do not split. */
export function canonicalizeDatadogEnv(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "prod" || lower === "production") return "production";
  return trimmed;
}

export function resolveDatadogEnv(): string {
  return (
    canonicalizeDatadogEnv(
      firstNonEmpty(
        process.env.DD_ENV,
        process.env.NEXT_PUBLIC_DD_ENV,
        process.env.SENTRY_ENVIRONMENT,
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
        process.env.NODE_ENV
      )
    ) ?? "development"
  );
}

export function resolveDatadogVersion(): string | undefined {
  return firstNonEmpty(
    process.env.DD_VERSION,
    process.env.NEXT_PUBLIC_DD_VERSION,
    process.env.SOURCE_COMMIT,
    process.env.COOLIFY_COMMIT_SHA,
    process.env.COOLIFY_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA
  );
}

export function resolveDatadogApiKey(): string | undefined {
  return firstNonEmpty(process.env.DD_API_KEY, process.env.DATADOG_API_KEY);
}

export function resolveDatadogAgentHost(): string | undefined {
  return firstNonEmpty(
    process.env.DD_AGENT_HOST,
    process.env.DD_TRACE_AGENT_HOSTNAME
  );
}

export function resolveDatadogTraceAgentUrl(): string | undefined {
  return firstNonEmpty(process.env.DD_TRACE_AGENT_URL, process.env.DD_TRACE_URL);
}

export function datadogAgentConfigured(): boolean {
  return Boolean(resolveDatadogAgentHost() || resolveDatadogTraceAgentUrl());
}

export function datadogApmEnabled(): boolean {
  if (flagOff(process.env.DD_TRACE_ENABLED) || flagOff(process.env.DD_APM_TRACING_ENABLED)) {
    return false;
  }
  return Boolean(resolveDatadogApiKey() || datadogAgentConfigured());
}

export function datadogLogsEnabled(): boolean {
  if (flagOff(process.env.DD_LOGS_ENABLED)) return false;
  return Boolean(resolveDatadogApiKey());
}

export function resolveLogsMinLevel(): DatadogLogStatus {
  const raw = (process.env.DD_LOGS_MIN_LEVEL ?? DEFAULT_LOGS_MIN_LEVEL).trim().toLowerCase();
  switch (raw) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return raw;
    default:
      return DEFAULT_LOGS_MIN_LEVEL;
  }
}

export function logStatusRank(status: DatadogLogStatus): number {
  switch (status) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function resolveTraceSampleRate(): number {
  const raw = Number(process.env.DD_TRACE_SAMPLE_RATE ?? DEFAULT_TRACE_SAMPLE_RATE);
  if (!Number.isFinite(raw)) return DEFAULT_TRACE_SAMPLE_RATE;
  return Math.min(1, Math.max(0, raw));
}

export function resolveRumApplicationId(): string | undefined {
  return firstNonEmpty(
    process.env.NEXT_PUBLIC_DD_APPLICATION_ID,
    process.env.NEXT_PUBLIC_DD_RUM_APPLICATION_ID,
    process.env.DD_APPLICATION_ID,
    process.env.DD_RUM_APPLICATION_ID
  );
}

export function resolveRumClientToken(): string | undefined {
  return firstNonEmpty(
    process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN,
    process.env.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN,
    process.env.DD_CLIENT_TOKEN,
    process.env.DD_RUM_CLIENT_TOKEN
  );
}

export function datadogRumEnabled(): boolean {
  if (flagOff(process.env.NEXT_PUBLIC_DD_RUM_ENABLED) || flagOff(process.env.DD_RUM_ENABLED)) {
    return false;
  }
  return Boolean(resolveRumApplicationId() && resolveRumClientToken());
}

export function resolvePublicRumConfig(): PublicRumConfig | null {
  if (!datadogRumEnabled()) return null;
  const applicationId = resolveRumApplicationId();
  const clientToken = resolveRumClientToken();
  if (!applicationId || !clientToken) return null;

  const sessionSampleRaw = Number(
    firstNonEmpty(process.env.NEXT_PUBLIC_DD_SESSION_SAMPLE_RATE, process.env.DD_SESSION_SAMPLE_RATE) ??
      DEFAULT_RUM_SESSION_SAMPLE_RATE
  );
  const sessionSampleRate = Number.isFinite(sessionSampleRaw)
    ? Math.min(100, Math.max(0, sessionSampleRaw))
    : DEFAULT_RUM_SESSION_SAMPLE_RATE;

  const replayEnabled =
    process.env.NEXT_PUBLIC_DD_SESSION_REPLAY_ENABLED === "true" ||
    process.env.DD_SESSION_REPLAY_ENABLED === "true";
  const replayRaw = Number(
    firstNonEmpty(
      process.env.NEXT_PUBLIC_DD_SESSION_REPLAY_SAMPLE_RATE,
      process.env.DD_SESSION_REPLAY_SAMPLE_RATE
    ) ?? "0"
  );
  const sessionReplaySampleRate = replayEnabled && Number.isFinite(replayRaw)
    ? Math.min(100, Math.max(0, replayRaw))
    : 0;

  return {
    applicationId,
    clientToken,
    site: resolveDatadogSite(),
    service: resolveDatadogService(),
    env: resolveDatadogEnv(),
    version: resolveDatadogVersion(),
    sessionSampleRate,
    sessionReplaySampleRate,
    sessionReplayEnabled: replayEnabled && sessionReplaySampleRate > 0
  };
}

/** HTTP Logs intake host for the configured Datadog site (us5 is the existing account). */
export function resolveLogsIntakeUrl(): string {
  const override = firstNonEmpty(process.env.DD_AGENTLESS_LOG_SUBMISSION_URL);
  if (override) return override;
  const site = resolveDatadogSite().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const host = site === "datadoghq.com" ? "http-intake.logs.datadoghq.com" : `http-intake.logs.${site}`;
  return `https://${host}/api/v2/logs`;
}

export function shouldUseAgentlessExporter(): boolean {
  if (datadogAgentConfigured()) return false;
  if (!resolveDatadogApiKey()) return false;
  const existing = firstNonEmpty(process.env.DD_TRACE_EXPERIMENTAL_EXPORTER);
  if (existing) return existing.toLowerCase() === "agentless";
  return true;
}
