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
    // Continuous profiling on the Node server only (not browser UI profiling).
    // Native @sentry/profiling-node is attached from instrumentation.ts with
    // webpackIgnore so `node:module` never enters the webpack graph.
    profileSessionSampleRate: Number(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? "1"),
    profileLifecycle: "trace",
    tracePropagationTargets: [
      "localhost",
      /^https:\/\/([\w-]+\.)?socratictrade\.com/,
      /^https:\/\/([\w-]+\.)?congress\.trade/,
      /^https:\/\/([\w-]+\.)?jays\.services/,
      /^https:\/\/usage\.jays\.services/,
    ],
    integrations: [
      Sentry.nodeRuntimeMetricsIntegration(),
      Sentry.openAIIntegration(),
      Sentry.anthropicAIIntegration(),
      Sentry.googleGenAIIntegration(),
      Sentry.vercelAIIntegration(),
      Sentry.langChainIntegration(),
    ],
    beforeSend(event) {
      return redactForTelemetry(event) as typeof event;
    }
  });
}
