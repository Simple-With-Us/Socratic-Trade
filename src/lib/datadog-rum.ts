import { redactForTelemetry, safeErrorMessage } from "./telemetry-sanitize";
import { type PublicRumConfig } from "./datadog-env";

let rumStarted = false;

type RumSdk = {
  init: (options: Record<string, unknown>) => void;
  addError: (error: unknown) => void;
};

let rumSdk: RumSdk | null = null;

export function datadogRumAlreadyStarted(): boolean {
  return rumStarted;
}

/** Browser RUM.  No-op without application id + client token.  Session Replay stays off unless opted in. */
export async function startDatadogRum(config: PublicRumConfig | null | undefined): Promise<void> {
  if (!config || rumStarted) return;
  if (typeof window === "undefined") return;

  rumStarted = true;
  try {
    const imported = await import("@datadog/browser-rum");
    const datadogRum = imported.datadogRum as unknown as RumSdk;
    rumSdk = datadogRum;
    datadogRum.init({
      applicationId: config.applicationId,
      clientToken: config.clientToken,
      site: config.site,
      service: config.service,
      env: config.env,
      version: config.version,
      sessionSampleRate: config.sessionSampleRate,
      sessionReplaySampleRate: config.sessionReplayEnabled ? config.sessionReplaySampleRate : 0,
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: "mask-user-input",
      allowedTracingUrls: [
        {
          match: (url: string) => sameOrigin(url),
          propagatorTypes: ["datadog"]
        }
      ],
      beforeSend(event: unknown) {
        return redactForTelemetry(event);
      }
    });
  } catch (error) {
    rumStarted = false;
    rumSdk = null;
    console.warn(`[datadog] rum init no-op: ${safeErrorMessage(error)}`);
  }
}

export function captureRumError(error: unknown): void {
  if (!rumSdk) return;
  try {
    rumSdk.addError(error);
  } catch {
    // Telemetry must never throw.
  }
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}
