export type RetrievalStage =
  | "query_embed_cache"
  | "query_embed_api"
  | "dense_query"
  | "lexical_query"
  | "fusion"
  | "score_floor"
  | "rerank"
  | "asof_filter"
  | "relevance_floor"
  | "dedupe"
  | "final_injection";

export interface RetrievalStageMetadata {
  provider?: string;
  model?: string;
  route?: string;
  namespace?: string;
  cacheHit?: boolean;
  candidatesIn?: number;
  candidatesOut?: number;
  dropped?: number;
}
export interface RetrievalStageReceipt extends RetrievalStageMetadata {
  stage: RetrievalStage;
  ordinal: number;
  durationMs: number;
  ok: boolean;
  errorKind?: string;
}

export interface RetrievalTraceSnapshot {
  traceVersion: 1;
  queryHash: string;
  symbol: string;
  route?: string;
  wallDurationMs: number;
  finalCandidates?: number;
  stages: readonly RetrievalStageReceipt[];
}

type Clock = () => number;

function nonNegativeWhole(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function safeMetadata(metadata: RetrievalStageMetadata): RetrievalStageMetadata {
  return {
    ...(metadata.provider ? { provider: metadata.provider } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.route ? { route: metadata.route } : {}),
    ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
    ...(metadata.cacheHit !== undefined ? { cacheHit: metadata.cacheHit } : {}),
    ...(nonNegativeWhole(metadata.candidatesIn) !== undefined ? { candidatesIn: nonNegativeWhole(metadata.candidatesIn) } : {}),
    ...(nonNegativeWhole(metadata.candidatesOut) !== undefined ? { candidatesOut: nonNegativeWhole(metadata.candidatesOut) } : {}),
    ...(nonNegativeWhole(metadata.dropped) !== undefined ? { dropped: nonNegativeWhole(metadata.dropped) } : {})
  };
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "UnknownError";
}

function queryDigest(value: string): string {
  // Two independently seeded 32-bit FNV-1a lanes provide a stable, text-free
  // correlation key without importing Node crypto into Webpack-analyzed paths.
  let high = 0x811c9dc5;
  let low = 0x811c9dc5 ^ 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193);
    low = Math.imul(low ^ (code >>> 8), 0x01000193);
    low = Math.imul(low ^ code, 0x01000193);
  }
  return `${(high >>> 0).toString(16).padStart(8, "0")}${(low >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Per-retrieval trace collector. It stores no raw query or document text; the query is represented
 * only by a short deterministic digest so latency/cost rows can be grouped without retaining prompt
 * data. This is a correlation key, not a security or authentication primitive.
 */
export class RetrievalStageTrace {
  private readonly startedAt: number;
  private readonly receipts: RetrievalStageReceipt[] = [];
  private readonly ordinals = new Map<RetrievalStage, number>();

  constructor(
    private readonly input: { query: string; symbol: string; route?: string },
    private readonly now: Clock = () => performance.now()
  ) {
    this.startedAt = this.now();
  }

  start(stage: RetrievalStage, metadata: RetrievalStageMetadata = {}): (result?: RetrievalStageMetadata & { error?: unknown }) => void {
    const startedAt = this.now();
    let ended = false;
    return (result = {}) => {
      if (ended) return;
      ended = true;
      const ordinal = (this.ordinals.get(stage) ?? 0) + 1;
      this.ordinals.set(stage, ordinal);
      const combined = safeMetadata({ ...metadata, ...result });
      const failure = "error" in result && result.error !== undefined;
      this.receipts.push(Object.freeze({
        stage,
        ordinal,
        durationMs: Math.max(0, Number((this.now() - startedAt).toFixed(3))),
        ok: !failure,
        ...combined,
        ...(failure ? { errorKind: errorKind(result.error) } : {})
      }));
    };
  }

  async measure<T>(stage: RetrievalStage, metadata: RetrievalStageMetadata, operation: () => Promise<T>): Promise<T> {
    const end = this.start(stage, metadata);
    try {
      const value = await operation();
      end();
      return value;
    } catch (error) {
      end({ error });
      throw error;
    }
  }

  snapshot(finalCandidates?: number): RetrievalTraceSnapshot {
    return Object.freeze({
      traceVersion: 1 as const,
      queryHash: queryDigest(this.input.query.trim()),
      symbol: this.input.symbol.trim().toUpperCase(),
      ...(this.input.route ? { route: this.input.route } : {}),
      wallDurationMs: Math.max(0, Number((this.now() - this.startedAt).toFixed(3))),
      ...(nonNegativeWhole(finalCandidates) !== undefined ? { finalCandidates: nonNegativeWhole(finalCandidates) } : {}),
      stages: Object.freeze([...this.receipts])
    });
  }
}
