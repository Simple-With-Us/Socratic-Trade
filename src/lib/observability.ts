import { redactForTelemetry, safeErrorMessage } from "./telemetry-sanitize";
import { assertWithinLlmBudget } from "./llm-budget";
import { otelResourceAttributes, resolveSentryRelease } from "./sentry-release";

type LlmGenerationOptions<T> = {
  name: string;
  model: string;
  userId?: string;
  /** The targeted account, so the budget backstop resolves THAT account's ceiling (not the active one). */
  connectedAccountId?: string;
  sessionId?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  output?: (result: T) => unknown;
};

type TraceProvider = {
  register: () => void;
};

type TraceProviderConstructor = new (config: { spanProcessors: unknown[]; resource?: unknown }) => TraceProvider;
type SpanProcessorConstructor = new (config: Record<string, unknown>) => unknown;
type LangfuseGeneration = {
  update: (fields: Record<string, unknown>) => void;
  end: () => void;
};
type LangfuseTracing = {
  propagateAttributes: <T>(attributes: Record<string, unknown>, run: () => Promise<T>) => Promise<T>;
  startObservation: (
    name: string,
    attributes: Record<string, unknown>,
    options: Record<string, unknown>
  ) => LangfuseGeneration;
};

declare global {
   
  var __tradingObservabilityStarted: boolean | undefined;
   
  var __tradingObservabilitySdk: unknown | undefined;
   
  var __tradingObservabilityWarned: boolean | undefined;
}

const runtimeImport = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;

export async function startObservability(): Promise<void> {
  if (!langfuseConfigured() || globalThis.__tradingObservabilityStarted) return;

  try {
    const [{ NodeTracerProvider }, { LangfuseSpanProcessor }, { resourceFromAttributes }] = await Promise.all([
      runtimeImport<{ NodeTracerProvider: TraceProviderConstructor }>("@opentelemetry/sdk-trace-node"),
      runtimeImport<{ LangfuseSpanProcessor: SpanProcessorConstructor }>("@langfuse/otel"),
      runtimeImport<{ resourceFromAttributes: (attrs: Record<string, string>) => unknown }>("@opentelemetry/resources")
    ]);

    const sentryRelease = resolveSentryRelease();
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes(otelResourceAttributes(sentryRelease)),
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: process.env.LANGFUSE_BASE_URL,
          environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.NODE_ENV || "development",
          release: process.env.LANGFUSE_RELEASE || sentryRelease || process.env.npm_package_version,
          mask: ({ data }: { data: unknown }) => redactForTelemetry(data)
        })
      ]
    });

    provider.register();
    globalThis.__tradingObservabilitySdk = provider;
    globalThis.__tradingObservabilityStarted = true;
  } catch (error) {
    warnOnce(`Langfuse OpenTelemetry startup failed: ${safeErrorMessage(error)}`);
  }
}

export async function withLlmGeneration<T>(options: LlmGenerationOptions<T>, run: () => Promise<T>): Promise<T> {
  // Durable budget backstop: EVERY LLM generation flows through here (bull, bear, red-team,
  // revalidation, reflection, tuning, and any future one), so throwing when the user is over their
  // daily budget guarantees no model spend slips past the ceiling — even from a call site that forgot
  // its own gate. No-op when no ceiling is configured (default). Runs BEFORE the Langfuse short-circuit
  // so it applies whether or not tracing is enabled.
  if (options.userId) assertWithinLlmBudget(options.userId, options.connectedAccountId);
  if (!langfuseConfigured()) return run();

  let attemptedRun = false;

  try {
    const { propagateAttributes, startObservation } = await runtimeImport<LangfuseTracing>("@langfuse/tracing");
    const observationMetadata = redactForTelemetry(options.metadata) as Record<string, unknown> | undefined;
    return (await propagateAttributes(
      {
        userId: options.userId,
        sessionId: options.sessionId,
        traceName: options.name,
        tags: options.tags,
        metadata: compactTraceMetadata(options.metadata)
      },
      async () => {
        let generation: ReturnType<typeof startObservation>;

        try {
          generation = startObservation(
            options.name,
            {
              model: options.model.includes("/") ? options.model.slice(options.model.indexOf("/") + 1) : options.model,
              input: redactForTelemetry(options.input),
              metadata: observationMetadata
            },
            { asType: "generation" }
          );
        } catch (error) {
          warnOnce(`Langfuse observation startup failed: ${safeErrorMessage(error)}`);
          attemptedRun = true;
          return run();
        }

        try {
          attemptedRun = true;
          const result = await run();
          try {
            generation.update({
              output: redactForTelemetry(options.output ? options.output(result) : undefined),
              level: "DEFAULT"
            });
            generation.end();
          } catch (error) {
            warnOnce(`Langfuse observation update failed: ${safeErrorMessage(error)}`);
          }
          return result;
        } catch (error) {
          try {
            generation.update({
              output: { error: safeErrorMessage(error) },
              level: "ERROR",
              statusMessage: safeErrorMessage(error)
            });
            generation.end();
          } catch (telemetryError) {
            warnOnce(`Langfuse observation error update failed: ${safeErrorMessage(telemetryError)}`);
          }
          throw error;
        }
      }
    )) as T;
  } catch (error) {
    if (attemptedRun) throw error;
    warnOnce(`Langfuse manual tracing failed: ${safeErrorMessage(error)}`);
    return run();
  }
}

/**
 * Emit a lightweight, standalone Langfuse observation for a non-LLM decision point (e.g. a Bear
 * veto or a rationale diversity-collapse) so it's queryable alongside the traced generations. This
 * is a fire-and-forget span with metadata/tags — no model input/output. It is a hard no-op when
 * Langfuse is not configured (`langfuseConfigured()` is false), so it never adds runtime cost or a
 * dependency when Langfuse isn't set up. Errors are swallowed (warn-once) so telemetry can never break a run.
 */
export async function recordDecisionObservation(options: {
  name: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}): Promise<void> {
  if (!langfuseConfigured()) return;
  try {
    const { propagateAttributes, startObservation } = await runtimeImport<LangfuseTracing>("@langfuse/tracing");
    await propagateAttributes(
      {
        userId: options.userId,
        traceName: options.name,
        tags: options.tags,
        metadata: compactTraceMetadata(options.metadata)
      },
      async () => {
        try {
          const observation = startObservation(
            options.name,
            { metadata: redactForTelemetry(options.metadata) as Record<string, unknown> | undefined },
            { asType: "event" }
          );
          observation.end();
        } catch (error) {
          warnOnce(`Langfuse decision observation failed: ${safeErrorMessage(error)}`);
        }
      }
    );
  } catch (error) {
    warnOnce(`Langfuse decision observation failed: ${safeErrorMessage(error)}`);
  }
}

function langfuseConfigured(): boolean {
  return (
    process.env.LANGFUSE_ENABLED !== "off" &&
    Boolean(process.env.LANGFUSE_PUBLIC_KEY) &&
    Boolean(process.env.LANGFUSE_SECRET_KEY)
  );
}

function warnOnce(message: string): void {
  if (globalThis.__tradingObservabilityWarned) return;
  globalThis.__tradingObservabilityWarned = true;
  console.warn(message);
}

function compactTraceMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const redacted = redactForTelemetry(metadata) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(redacted)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const raw = typeof value === "string" ? value : JSON.stringify(value);
        return [key, raw.length > 200 ? `${raw.slice(0, 197)}...` : raw];
      })
  );
}
