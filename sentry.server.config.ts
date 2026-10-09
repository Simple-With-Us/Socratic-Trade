import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry } from "./src/lib/telemetry-sanitize";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
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
    // Continuous profiling, node runtime metrics, and the GenAI SDK hooks are
    // attached from instrumentation.ts on the Node runtime only.  webpackIgnore
    // keeps @sentry/profiling-node and @sentry/node out of the Edge bundle
    // (a static import fails that compile on diagnostics_channel / worker_threads).
    profileSessionSampleRate: Number(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? "1"),
    profileLifecycle: "trace",
    tracePropagationTargets: [
      "localhost",
      /^https:\/\/([\w-]+\.)?socratictrade\.com/,
      /^https:\/\/([\w-]+\.)?congress\.trade/,
      /^https:\/\/([\w-]+\.)?jays\.services/,
      /^https:\/\/usage\.jays\.services/,
    ],
    beforeSend(event) {
      return redactForTelemetry(event) as typeof event;
    }
  });
}
