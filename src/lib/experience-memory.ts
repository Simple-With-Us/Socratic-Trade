/**
 * Episodic experience memory (2026-07-04 composite expert review, section A item 1 — [Both]):
 * "Retrieve episodic decision memory (closest historical analogs) at decision time."
 *
 * Two halves live here:
 *
 *  1. WRITE — `recordClosedLotExperience`: on every closed lot (hooked fire-and-forget from
 *     `performance.recordFillFromProposal` when a sell/cover fill lands), embed a state vector of
 *     the ENTRY situation — the 8 factor sub-scores, `entryMarketRegime`, macro/breadth snapshot,
 *     thesisTag, sector, and the entry rationale — together with the realized outcome
 *     `{returnPct, holdingDays, riskExit, mae, mfe}` as metadata, into a dedicated
 *     `source="experience-memory"` namespace keyed by the ENTRY proposalId. The doc carries
 *     `doc_type="socratic-decision"` so the decision-time retrieval pass below finds experiences
 *     and proposal-time decision cases (socratic-memory.ts) in one query.
 *
 *  2. READ — `retrieveDecisionExperiences`: a second retrieval pass per run over doc types
 *     `['socratic-decision','coach-note','lesson']` (coach-note/lesson writers land via parallel
 *     lanes — this consumes the doc_types), with the query built as a SITUATION SKETCH (regime +
 *     thesis/factor hints + evidence summary — deliberately NOT the generic filings query), k-NN
 *     retrieving the closest priors across ALL symbols. Same-run neighbors are excluded (no
 *     leaking this run's own freshly-indexed cases back into its prompt) and the result is
 *     stamped as-of (retrieval passes `asOf` so nothing dated after the stamp is admitted — no
 *     lookahead on replay). Nearest priors with OPPOSITE realized sign are labeled
 *     COUNTEREXAMPLE rather than filtered — feeding the dissent habit, not curating a winner reel.
 *
 * Product philosophy: everything here is ADVISORY evidence for the Bull AND Bear prompts
 * (evidence parity). Nothing in this module gates, blocks, or sizes anything, and every failure
 * degrades to "no analogs block" rather than breaking a run or a fill record.
 */
import { envFlagOn } from "./rag/env-flag";
import { normalizeSymbol } from "./money";
import type { ContextDocument, RetrievedChunk, StoreContextsResult } from "./vector-db";
import type { FillEvent, FillSource, MarketFactorBreakdown, TradeProposal } from "./types";

/** Source tag for closed-lot experience vectors — the "dedicated namespace" within the index. */
export const EXPERIENCE_MEMORY_SOURCE = "experience-memory";

/**
 * Doc types the decision-time episodic pass retrieves over. `socratic-decision` covers both the
 * proposal-time case files (socratic-memory.ts) and the closed-lot experience vectors written
 * here; `coach-note` and `lesson` are consumed when their writer lanes land — retrieving them
 * today is a harmless no-match until then.
 */
export const EPISODIC_DOC_TYPES = ["socratic-decision", "coach-note", "lesson"] as const;

/** The 8 factor sub-scores embedded into every experience state vector (keys of ScoringWeights). */
export const EXPERIENCE_FACTOR_KEYS = [
  "liquidity",
  "momentum",
  "value",
  "quality",
  "volatility",
  "sentiment",
  "positioning",
  "diversification"
] as const;

/**
 * Opt-OUT flag (default ON, like reranking): set EXPERIENCE_MEMORY=off to disable both the
 * closed-lot write hook and the decision-time retrieval pass.
 */
export function experienceMemoryEnabled(): boolean {
  return envFlagOn("EXPERIENCE_MEMORY", true);
}

/** Mechanical stop-driven exit tags — closing under one of these marks the lot `risk_exit`. */
const RISK_EXIT_THESIS_TAGS = new Set(["Risk-Exit", "Synthetic Stop"]);

function compact(value: string | undefined, maxChars = 400): string {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return "n/a";
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}…` : trimmed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Calendar days between two ISO timestamps, rounded to 2dp; undefined when either is missing/invalid. */
export function holdingDaysBetween(entryAt?: string, exitAt?: string): number | undefined {
  if (!entryAt || !exitAt) return undefined;
  const entry = Date.parse(entryAt);
  const exit = Date.parse(exitAt);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || exit < entry) return undefined;
  return round2((exit - entry) / 86_400_000);
}

export interface ClosedLotExperienceInput {
  userId: string;
  connectedAccountId?: string;
  accountNumber: string;
  symbol: string;
  side: "long" | "short";
  /** Side-adjusted realized return % for the closed lot (positive = the trade worked). */
  returnPct: number;
  pnl: number;
  entryAt?: string;
  exitAt: string;
  /** Run that opened the lot (decision run) — used for same-run exclusion at retrieval time. */
  entryRunId?: string;
  exitRunId?: string;
  /** ENTRY proposal id — the key of the experience vector per the review spec. */
  entryProposalId?: string;
  exitProposalId?: string;
  thesisTag?: string;
  entryMarketRegime?: string;
  sector?: string;
  confidence?: number;
  /** The 8 factor sub-scores at entry (stamped into the entry fill's raw by recordFillFromProposal). */
  factorBreakdown?: Partial<Record<(typeof EXPERIENCE_FACTOR_KEYS)[number], number>> & { weightedTotal?: number };
  /** Market breadth % at entry (macro/scan snapshot stamped at entry), when available. */
  entryBreadthPct?: number;
  entryRationale?: string;
  exitThesisTag?: string;
  exitRationale?: string;
  /** True when the lot was closed by a mechanical stop-driven exit (Risk-Exit / Synthetic Stop). */
  riskExit: boolean;
  mae?: number;
  mfe?: number;
}

/**
 * Build the embeddable experience document for one closed lot. Text carries the full state sketch
 * (so Voyage embeds the situation AND the rationale); metadata carries the machine-readable
 * realized outcome for retrieval-time labeling (counterexamples, similarity, exclusions).
 */
export function buildClosedLotExperienceDocument(input: ClosedLotExperienceInput): ContextDocument {
  const symbol = normalizeSymbol(input.symbol);
  const factorLine = EXPERIENCE_FACTOR_KEYS
    .map((key) => {
      const value = input.factorBreakdown?.[key];
      return typeof value === "number" && Number.isFinite(value) ? `${key}=${round2(value)}` : undefined;
    })
    .filter(Boolean)
    .join(" ");
  const outcomeParts = [
    `return_pct=${round2(input.returnPct)}`,
    ...(input.entryAt ? [`holding_days=${holdingDaysBetween(input.entryAt, input.exitAt) ?? "n/a"}`] : []),
    `risk_exit=${input.riskExit}`,
    ...(typeof input.mae === "number" ? [`mae=${round2(input.mae)}`] : []),
    ...(typeof input.mfe === "number" ? [`mfe=${round2(input.mfe)}`] : [])
  ];

  const text = [
    "Experience memory: closed lot with realized outcome",
    `ticker: ${symbol}`,
    `side: ${input.side}`,
    `thesis_tag: ${input.thesisTag ?? "n/a"}`,
    `entry_market_regime: ${input.entryMarketRegime ?? "n/a"}`,
    `sector: ${input.sector ?? "n/a"}`,
    `entry_factor_scores: ${factorLine || "n/a"}`,
    `macro_snapshot_at_entry: ${typeof input.entryBreadthPct === "number" ? `market_breadth_pct=${round2(input.entryBreadthPct)}` : "n/a"}`,
    ...(typeof input.confidence === "number" ? [`entry_confidence: ${input.confidence}`] : []),
    `entry_rationale: ${compact(input.entryRationale)}`,
    `exit_reason: ${compact(input.exitRationale)}${input.exitThesisTag ? ` (${input.exitThesisTag})` : ""}`,
    `realized_outcome: ${outcomeParts.join("; ")}`,
    `entry_at: ${input.entryAt ?? "n/a"}`,
    `exit_at: ${input.exitAt}`
  ].join("\n");

  const holdingDays = holdingDaysBetween(input.entryAt, input.exitAt);
  const factorMetadata: Record<string, number> = {};
  for (const key of EXPERIENCE_FACTOR_KEYS) {
    const value = input.factorBreakdown?.[key];
    if (typeof value === "number" && Number.isFinite(value)) factorMetadata[`factor_${key}`] = round2(value);
  }

  return {
    text,
    metadata: {
      symbol,
      source: EXPERIENCE_MEMORY_SOURCE,
      // Keyed by the ENTRY proposalId (the decision the outcome belongs to); the exit fill id
      // disambiguates partial closes of one entry across multiple exits.
      accession: `exp:${input.entryProposalId ?? "no-proposal"}:${input.exitProposalId ?? "manual"}`,
      timestamp: input.exitAt,
      doc_type: "socratic-decision",
      memory_kind: "experience",
      side: input.side,
      return_pct: round2(input.returnPct),
      pnl_usd: round2(input.pnl),
      risk_exit: input.riskExit,
      ...(typeof holdingDays === "number" ? { holding_days: holdingDays } : {}),
      ...(typeof input.mae === "number" ? { mae: round2(input.mae) } : {}),
      ...(typeof input.mfe === "number" ? { mfe: round2(input.mfe) } : {}),
      ...(input.entryProposalId ? { proposal_id: input.entryProposalId } : {}),
      ...(input.exitProposalId ? { exit_proposal_id: input.exitProposalId } : {}),
      ...(input.entryRunId ? { run_id: input.entryRunId } : {}),
      ...(input.exitRunId ? { exit_run_id: input.exitRunId } : {}),
      ...(input.thesisTag ? { thesis_tag: input.thesisTag } : {}),
      ...(input.entryMarketRegime ? { entry_market_regime: input.entryMarketRegime } : {}),
      ...(input.sector ? { sector: input.sector } : {}),
      ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
      ...(input.connectedAccountId ? { connected_account_id: input.connectedAccountId } : {}),
      ...factorMetadata
    }
  };
}

function proposalFromFillRaw(fill: FillEvent | undefined): (TradeProposal & Record<string, unknown>) | undefined {
  const raw = fill?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const proposal = (raw as Record<string, unknown>).proposal;
  if (!proposal || typeof proposal !== "object") return undefined;
  return proposal as TradeProposal & Record<string, unknown>;
}

function factorBreakdownFromFillRaw(fill: FillEvent | undefined): MarketFactorBreakdown | undefined {
  const raw = fill?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const breakdown = (raw as Record<string, unknown>).factorBreakdown;
  if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) return undefined;
  return breakdown as MarketFactorBreakdown;
}

function breadthFromFillRaw(fill: FillEvent | undefined): number | undefined {
  const raw = fill?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const breadth = (raw as Record<string, unknown>).scanBreadthPct;
  return typeof breadth === "number" && Number.isFinite(breadth) ? breadth : undefined;
}

export interface RecordClosedLotExperienceInput {
  userId?: string;
  connectedAccountId?: string;
  accountNumber: string;
  source: FillSource;
  /** The just-inserted closing (sell/cover) fill. */
  closingFill: FillEvent;
  /** The closing proposal (exit reason / mechanical-exit tags). */
  closingProposal: TradeProposal;
}

/**
 * Write hook: called fire-and-forget from `performance.recordFillFromProposal` after a closing
 * (sell/cover) fill is inserted. Replays the account's fills through the SAME FIFO accounting the
 * scorecards use (`calculatePnl`) to find exactly the lots THIS fill closed, resolves each lot's
 * ENTRY fill (for the entry proposal / factor snapshot / proposalId key), and embeds one
 * experience document per closed entry-lot.
 *
 * Best-effort by design: returns null (never throws) when the vector store isn't configured, the
 * closing fill isn't an accounting fill yet (live fills are `pending_reconciliation` until the
 * broker confirms — a known v1 gap, noted in the rollout), or no matching open lot existed.
 */
export async function recordClosedLotExperience(
  input: RecordClosedLotExperienceInput
): Promise<StoreContextsResult | null> {
  if (!experienceMemoryEnabled()) return null;
  try {
    const userId = input.userId ?? "local";
    const [{ listFillEvents }, { calculatePnl }, { storeContexts }] = await Promise.all([
      import("./db"),
      import("./performance"),
      import("./vector-db")
    ]);
    const fills = listFillEvents(input.accountNumber, input.source, 500, userId);
    const { closedLots } = calculatePnl(fills);
    const closingSymbol = normalizeSymbol(input.closingFill.symbol);
    const matched = closedLots.filter(
      (lot) => lot.symbol === closingSymbol && lot.exitAt === input.closingFill.filledAt
    );
    if (matched.length === 0) return null;

    const riskExit = RISK_EXIT_THESIS_TAGS.has(input.closingProposal.tradeThesisTag);
    const documents: ContextDocument[] = matched.map((lot) => {
      // Resolve the ENTRY fill for this lot (proposalId key + entry-state snapshot). entryAt +
      // symbol + entry side is unique per fill row in practice (one fill per proposal placement).
      const wantEntrySide = lot.side === "short" ? "short" : "buy";
      const entryFill = fills.find(
        (fill) =>
          normalizeSymbol(fill.symbol) === closingSymbol &&
          fill.side === wantEntrySide &&
          fill.filledAt === lot.entryAt
      );
      const entryProposal = proposalFromFillRaw(entryFill);
      return buildClosedLotExperienceDocument({
        userId,
        connectedAccountId: input.connectedAccountId,
        accountNumber: input.accountNumber,
        symbol: closingSymbol,
        side: lot.side ?? "long",
        returnPct: lot.returnPct,
        pnl: lot.pnl,
        entryAt: lot.entryAt,
        exitAt: input.closingFill.filledAt,
        entryRunId: lot.entryRunId,
        exitRunId: input.closingFill.runId,
        entryProposalId: entryFill?.proposalId,
        exitProposalId: input.closingFill.proposalId,
        thesisTag: lot.thesisTag,
        entryMarketRegime: lot.regime,
        sector: lot.sector,
        confidence: lot.confidence,
        factorBreakdown: factorBreakdownFromFillRaw(entryFill),
        entryBreadthPct: breadthFromFillRaw(entryFill),
        entryRationale: entryProposal?.rationale,
        exitThesisTag: input.closingProposal.tradeThesisTag,
        exitRationale: input.closingProposal.rationale,
        riskExit,
        mae: lot.mae,
        mfe: lot.mfe
      });
    });

    return await storeContexts(documents, userId, { dedupKeyPrefix: EXPERIENCE_MEMORY_SOURCE });
  } catch (err) {
    // The experience write must never affect fill recording or the money path.
    console.warn(
      "[experience-memory] closed-lot experience write failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision-time retrieval (read hook, called from the strategy run loop)
// ─────────────────────────────────────────────────────────────────────────────

export interface SituationCandidate {
  symbol: string;
  sector?: string;
  dominantFactor?: string;
  /** 1-line evidence bulletins from the scan (congress/insider/technical etc.). */
  evidence?: string[];
}

/**
 * Build the SITUATION SKETCH query for episodic retrieval: current regime + candidate factor/
 * sector hints + evidence summary. Deliberately NOT the generic "significant financial events,
 * SEC filings" query the filings pass uses — the point is to match past decision SITUATIONS,
 * not filing content.
 */
export function buildSituationSketch(input: { regime: string; candidates: SituationCandidate[] }): string {
  const candidateLines = input.candidates.slice(0, 3).map((candidate) => {
    const parts = [normalizeSymbol(candidate.symbol)];
    if (candidate.sector) parts.push(`sector ${candidate.sector}`);
    if (candidate.dominantFactor) parts.push(`dominant factor ${candidate.dominantFactor}`);
    const evidence = (candidate.evidence ?? []).slice(0, 2).map((line) => compact(line, 120)).filter((l) => l !== "n/a");
    if (evidence.length > 0) parts.push(`evidence: ${evidence.join(" | ")}`);
    return parts.join(", ");
  });
  return [
    `Trading situation: market regime ${input.regime}.`,
    candidateLines.length > 0 ? `Candidates under consideration: ${candidateLines.join("; ")}.` : "",
    "Looking for the closest prior decisions, realized outcomes, owner coaching, and lessons from similar setups."
  ]
    .filter(Boolean)
    .join(" ");
}

export interface InjectedMemoryRef {
  id: string;
  docType?: string;
  kind: "analog" | "coaching";
  counterexample?: boolean;
  score?: number;
  relevanceScore?: number;
}

export interface ExperienceRetrievalResult {
  /** Labeled prompt block for Bull AND Bear, or undefined when nothing was retrieved. */
  analogsBlock?: string;
  /** Labeled owner-coaching prompt block (doc_type coach-note), or undefined when none. */
  coachingBlock?: string;
  /** Raw chunks behind each block (for rag attributions on the decision cases). */
  analogChunks: RetrievedChunk[];
  coachingChunks: RetrievedChunk[];
  /** Every injected memory id — persisted per run so retrieval-usefulness scoring can join later. */
  injected: InjectedMemoryRef[];
  /** The as-of stamp the retrieval ran under (no chunk dated after this was admitted). */
  asOf: string;
  /** The situation-sketch query used (recoverable for replay/debug). */
  query: string;
  topAnalogSimilarity?: number;
}

function chunkMeta(chunk: RetrievedChunk, key: string): unknown {
  return chunk.metadata?.[key];
}

function realizedSign(chunk: RetrievedChunk): number | undefined {
  const value = chunkMeta(chunk, "return_pct");
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? 1 : -1;
}

export interface RetrieveDecisionExperiencesInput {
  userId: string;
  /** Current run id — neighbors written by THIS run are excluded (no self-retrieval). */
  runId: string;
  regime: string;
  candidates: SituationCandidate[];
  connectedAccountId?: string;
  /** As-of stamp; defaults to now. Chunks dated after this are never admitted (no lookahead). */
  asOf?: string;
  /** How many neighbors to keep across analogs+coaching (review suggests 5-10; default 8). */
  k?: number;
}

/**
 * Decision-time episodic retrieval: k-NN over `['socratic-decision','coach-note','lesson']`
 * across ALL symbols, queried with the situation sketch, same-run neighbors excluded, as-of
 * stamped. Returns labeled prompt blocks plus the injected ids for per-run persistence.
 */
export async function retrieveDecisionExperiences(
  input: RetrieveDecisionExperiencesInput
): Promise<ExperienceRetrievalResult> {
  const asOf = input.asOf ?? new Date().toISOString();
  const query = buildSituationSketch({ regime: input.regime, candidates: input.candidates });
  const empty: ExperienceRetrievalResult = {
    analogChunks: [],
    coachingChunks: [],
    injected: [],
    asOf,
    query
  };
  if (!experienceMemoryEnabled()) return empty;

  const k = Math.min(10, Math.max(5, input.k ?? 8));
  let chunks: RetrievedChunk[] = [];
  try {
    const { retrieveContextDetailed, defaultMinScore, formatChunkWithProvenance } = await import("./vector-db");
    // Over-ask by a small margin so same-run exclusion below doesn't leave us short of k.
    const fetched = await retrieveContextDetailed(
      query,
      normalizeSymbol(input.candidates[0]?.symbol ?? "PORTFOLIO"),
      k + 4,
      input.userId,
      {
        docType: [...EPISODIC_DOC_TYPES],
        // Analogs are cross-symbol by design: the same setup on a different ticker is exactly
        // the kind of prior the review wants surfaced.
        matchAllSymbols: true,
        asOf,
        minScore: defaultMinScore(),
        connectedAccountId: input.connectedAccountId
      }
    );
    // Same-run / future-neighbor exclusion: a case this run just indexed (decision run OR exit
    // run stamped with this runId) must not be retrieved back into this run's own prompt.
    chunks = fetched
      .filter(
        (chunk) =>
          chunkMeta(chunk, "run_id") !== input.runId && chunkMeta(chunk, "exit_run_id") !== input.runId
      )
      .slice(0, k);

    const coachingChunks = chunks.filter((chunk) => chunk.doc_type === "coach-note");
    const analogChunks = chunks.filter((chunk) => chunk.doc_type !== "coach-note");

    const injected: InjectedMemoryRef[] = [
      ...analogChunks.map((chunk) => ({
        id: chunk.id,
        docType: chunk.doc_type,
        kind: "analog" as const,
        ...(realizedSign(chunk) === -1 ? { counterexample: true } : {}),
        ...(typeof chunk.score === "number" ? { score: chunk.score } : {}),
        ...(typeof chunk.relevanceScore === "number" ? { relevanceScore: chunk.relevanceScore } : {})
      })),
      ...coachingChunks.map((chunk) => ({
        id: chunk.id,
        docType: chunk.doc_type,
        kind: "coaching" as const,
        ...(typeof chunk.score === "number" ? { score: chunk.score } : {}),
        ...(typeof chunk.relevanceScore === "number" ? { relevanceScore: chunk.relevanceScore } : {})
      }))
    ];

    const top = analogChunks[0];
    const topAnalogSimilarity =
      typeof top?.relevanceScore === "number" ? top.relevanceScore : typeof top?.score === "number" ? top.score : undefined;

    const analogsBlock =
      analogChunks.length > 0
        ? [
            `CLOSEST HISTORICAL ANALOGS (episodic memory, advisory; as of ${asOf}${
              typeof topAnalogSimilarity === "number" ? `; top-analog similarity ${topAnalogSimilarity.toFixed(2)}` : ""
            }). Entries labeled COUNTEREXAMPLE had the OPPOSITE realized sign — weigh them as dissent, not noise.`,
            ...analogChunks.map((chunk) => {
              const symbol = typeof chunkMeta(chunk, "symbol") === "string" ? String(chunkMeta(chunk, "symbol")) : undefined;
              const formatted = formatChunkWithProvenance(chunk, symbol);
              return realizedSign(chunk) === -1 ? `[COUNTEREXAMPLE — opposite realized sign]\n${formatted}` : formatted;
            })
          ].join("\n\n")
        : undefined;

    const coachingBlock =
      coachingChunks.length > 0
        ? [
            `OWNER COACHING (advisory; as of ${asOf}). Notes the owner attached to prior decisions — re-read before deciding on similar setups.`,
            ...coachingChunks.map((chunk) => {
              const symbol = typeof chunkMeta(chunk, "symbol") === "string" ? String(chunkMeta(chunk, "symbol")) : undefined;
              return formatChunkWithProvenance(chunk, symbol);
            })
          ].join("\n\n")
        : undefined;

    return {
      analogsBlock,
      coachingBlock,
      analogChunks,
      coachingChunks,
      injected,
      asOf,
      query,
      topAnalogSimilarity
    };
  } catch (err) {
    console.warn(
      "[experience-memory] decision-time retrieval failed; continuing without analogs:",
      err instanceof Error ? err.message : String(err)
    );
    return empty;
  }
}
