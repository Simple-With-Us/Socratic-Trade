import * as Sentry from "@sentry/nextjs";
import { resolveSentryRelease } from "./src/lib/sentry-release";
import { redactForTelemetry, sanitizeTelemetryUrl, sanitizeTransactionEvent } from "./src/lib/telemetry-sanitize";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: resolveSentryRelease(),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2"),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      },
      httpBodies: [],
      urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
    },
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = sanitizeTelemetryUrl(event.request.url);
      }
      return redactForTelemetry(event) as typeof event;
    },
    beforeSendTransaction(event) {
      return sanitizeTransactionEvent(event);
    }
  });
}
