import { safeErrorMessage } from "./telemetry-sanitize";
import {
  datadogApmEnabled,
  datadogLogsEnabled,
  resolveDatadogApiKey,
  resolveDatadogEnv,
  resolveDatadogService,
  resolveDatadogTraceAgentUrl,
  resolveDatadogVersion,
  resolveTraceSampleRate,
  shouldUseAgentlessExporter
} from "./datadog-env";
import { datadogLlmObsInitOptions } from "./datadog-llmobs";
import { startDatadogLogShipping } from "./datadog-logs";

declare global {
  var __tradingDatadogApmStarted: boolean | undefined;
}

type TracerInit = (options: Record<string, unknown>) => unknown;

/**
 * Server Datadog boot.  Fail-closed: missing keys are a no-op, init errors never throw.
 * APM uses the existing account (DD_SITE defaults to us5).  When no agent host is set,
 * official DD_TRACE_EXPERIMENTAL_EXPORTER=agentless is used so traces can leave Docker.
 */
export async function startDatadogServer(): Promise<void> {
  try {
    if (datadogLogsEnabled()) startDatadogLogShipping();
    if (!datadogApmEnabled() || globalThis.__tradingDatadogApmStarted) return;
    if (globalThis._ddtrace) {
      globalThis.__tradingDatadogApmStarted = true;
      return;
    }

    applyAgentlessDefaults();

    const imported = await import(/* webpackIgnore: true */ "dd-trace");
    const init = (imported.default?.init ?? (imported as { init?: TracerInit }).init) as TracerInit | undefined;
    if (typeof init !== "function") return;

    init({
      service: resolveDatadogService(),
      env: resolveDatadogEnv(),
      version: resolveDatadogVersion(),
      hostname: process.env.DD_AGENT_HOST || process.env.DD_TRACE_AGENT_HOSTNAME,
      url: resolveDatadogTraceAgentUrl(),
      logInjection: true,
      runtimeMetrics: true,
      profiling: false,
      appsec: false,
      startupLogs: false,
      sampleRate: resolveTraceSampleRate(),
      ingestion: { sampleRate: resolveTraceSampleRate() },
      llmobs: datadogLlmObsInitOptions()
    });
    globalThis.__tradingDatadogApmStarted = true;
  } catch (error) {
    console.warn(`[datadog] server init no-op: ${safeErrorMessage(error)}`);
  }
}

function applyAgentlessDefaults(): void {
  process.env.DD_SERVICE = process.env.DD_SERVICE || resolveDatadogService();
  process.env.DD_ENV = process.env.DD_ENV || resolveDatadogEnv();
  process.env.DD_SITE = process.env.DD_SITE || "us5.datadoghq.com";
  const version = resolveDatadogVersion();
  if (version && !process.env.DD_VERSION) process.env.DD_VERSION = version;
  if (!process.env.DD_LOGS_INJECTION) process.env.DD_LOGS_INJECTION = "true";
  if (!process.env.DD_PROFILING_ENABLED) process.env.DD_PROFILING_ENABLED = "false";
  if (!process.env.DD_APPSEC_ENABLED) process.env.DD_APPSEC_ENABLED = "false";
  if (shouldUseAgentlessExporter() && resolveDatadogApiKey()) {
    if (!process.env.DD_TRACE_EXPERIMENTAL_EXPORTER) {
      process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = "agentless";
    }
  }
}
