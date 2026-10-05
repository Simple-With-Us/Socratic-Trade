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
 *     Analog prompt lines are packed at retrieve time via `formatAnalogCard` (situation +
 *     return_pct / holding_days / risk_exit + short rationale). Full SocraticDecisionCase JSON
 *     never enters the prompt. One COUNTEREXAMPLE slot is reserved from the over-ask set when
 *     any opposite-sign neighbor exists.
 *
 * Product philosophy: everything here is ADVISORY evidence for the Bull AND Bear prompts
 * (evidence parity). Nothing in this module gates, blocks, or sizes anything, and every failure
 * degrades to "no analogs block" rather than breaking a run or a fill record.
 */
import { envFlagOn } from "./rag/env-flag";
import { normalizeSymbol } from "./money";
import type { ContextDocument, RetrievalStatus, RetrievedChunk, StoreContextsResult } from "./vector-db";
import type { FillEvent, FillSource, MarketFactorBreakdown, TradeProposal } from "./types";
import { bumpVectorDocRetrieved } from "./db-memory-lifecycle";

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
  accountEnvironment?: "paper" | "live";
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
      memory_scope: "account",
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
      ...(input.accountEnvironment ? {
        account_environment: input.accountEnvironment,
        transfer_state: "not_applicable"
      } : {}),
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
    const fills = listFillEvents(input.accountNumber, input.source, undefined, userId);
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
        accountEnvironment: input.source,
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

    return await storeContexts(documents, userId, {
      dedupKeyPrefix: EXPERIENCE_MEMORY_SOURCE,
      scope: "private"
    });
  } catch (err) {
    // The experience write must never affect fill recording or the money path.
    console.warn(
      "[experience-memory] closed-lot experience write failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Backfill/re-embed support (corpus-reembed, 2026-07-18): reconstruct EVERY historical closed-lot
 * experience document for one account, not just the ones matching a single just-closed fill.
 * Mirrors `recordClosedLotExperience`'s per-lot construction (entry-fill/proposal resolution,
 * factor breakdown, risk-exit classification) but additionally resolves the EXIT fill/proposal per
 * lot — `recordClosedLotExperience` gets those directly from its caller's `closingFill`/
 * `closingProposal` inputs, which don't exist for a full historical replay.
 *
 * Deliberately does NOT touch `recordClosedLotExperience` or `buildClosedLotExperienceDocument`:
 * this is purely additive so the live write-hook (money-path-adjacent — feeds the Bull/Bear
 * decision prompt) keeps its exact existing behavior. Read-only: never writes to the vector store
 * itself. Callers decide how/where to embed the returned documents.
 */
export async function listClosedLotExperienceDocumentsForAccount(input: {
  userId: string;
  connectedAccountId?: string;
  accountEnvironment: FillSource;
  accountNumber: string;
}): Promise<ContextDocument[]> {
  const [{ listFillEvents }, { calculatePnl }] = await Promise.all([
    import("./db"),
    import("./performance")
  ]);
  const fills = listFillEvents(input.accountNumber, input.accountEnvironment, undefined, input.userId);
  const { closedLots } = calculatePnl(fills);

  return closedLots
    .filter((lot): lot is typeof lot & { exitAt: string } => Boolean(lot.exitAt))
    .map((lot) => {
      const symbol = normalizeSymbol(lot.symbol ?? "");
      const wantEntrySide = lot.side === "short" ? "short" : "buy";
      const wantExitSide = lot.side === "short" ? "cover" : "sell";
      const entryFill = fills.find(
        (fill) =>
          normalizeSymbol(fill.symbol) === symbol && fill.side === wantEntrySide && fill.filledAt === lot.entryAt
      );
      const exitFill = fills.find(
        (fill) =>
          normalizeSymbol(fill.symbol) === symbol && fill.side === wantExitSide && fill.filledAt === lot.exitAt
      );
      const entryProposal = proposalFromFillRaw(entryFill);
      const exitProposal = proposalFromFillRaw(exitFill);
      const riskExit = Boolean(
        exitProposal?.tradeThesisTag && RISK_EXIT_THESIS_TAGS.has(exitProposal.tradeThesisTag)
      );
      return buildClosedLotExperienceDocument({
        userId: input.userId,
        connectedAccountId: input.connectedAccountId,
        accountEnvironment: input.accountEnvironment,
        accountNumber: input.accountNumber,
        symbol,
        side: lot.side ?? "long",
        returnPct: lot.returnPct,
        pnl: lot.pnl,
        entryAt: lot.entryAt,
        exitAt: lot.exitAt,
        entryRunId: lot.entryRunId,
        exitRunId: exitFill?.runId,
        entryProposalId: entryFill?.proposalId,
        exitProposalId: exitFill?.proposalId,
        thesisTag: lot.thesisTag,
        entryMarketRegime: lot.regime,
        sector: lot.sector,
        confidence: lot.confidence,
        factorBreakdown: factorBreakdownFromFillRaw(entryFill),
        entryBreadthPct: breadthFromFillRaw(entryFill),
        entryRationale: entryProposal?.rationale,
        exitThesisTag: exitProposal?.tradeThesisTag,
        exitRationale: exitProposal?.rationale,
        riskExit,
        mae: lot.mae,
        mfe: lot.mfe
      });
    });
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
  /**
   * Set by callers for candidates appended past the top-N scan slice specifically because the
   * symbol is a held (open) position — not because it scored into the top-N. Lets the sketch
   * builder below include held names beyond its top-3 cutoff without widening the cutoff for
   * ordinary (non-held) scan candidates.
   */
  held?: boolean;
}

/** Hard cap on candidates folded into the sketch text, so a large held-position book can never
 *  make the situation-sketch query unbounded: total selected (top-3 scan + held overflow) never
 *  exceeds this cap. In the common case (3+ scan candidates) that's top-3 + up to 3 extra held
 *  names; if fewer than 3 scan candidates are passed, the held budget grows to fill the cap
 *  (e.g. 1 scan candidate leaves room for up to 5 held names). */
const SITUATION_SKETCH_MAX_CANDIDATES = 6;

/**
 * Build the SITUATION SKETCH query for episodic retrieval: current regime + candidate factor/
 * sector hints + evidence summary. Deliberately NOT the generic "significant financial events,
 * SEC filings" query the filings pass uses — the point is to match past decision SITUATIONS,
 * not filing content.
 *
 * Candidate selection: the top-3 (by input order — callers pass scan-ranked candidates first)
 * PLUS any `held: true` candidates beyond that cutoff, so sell/hold/trim decisions on a held
 * position outside the top-3 still reach the episodic query text — capped at
 * SITUATION_SKETCH_MAX_CANDIDATES total so query length stays bounded regardless of book size.
 * Non-held callers (or callers that never set `held`) see byte-identical behavior to a plain
 * slice(0, 3).
 */
export function buildSituationSketch(input: { regime: string; candidates: SituationCandidate[] }): string {
  const topThree = input.candidates.slice(0, 3);
  const extraHeld = input.candidates.slice(3).filter((candidate) => candidate.held);
  const budget = Math.max(0, SITUATION_SKETCH_MAX_CANDIDATES - topThree.length);
  const selected = [...topThree, ...extraHeld.slice(0, budget)];
  const candidateLines = selected.map((candidate) => {
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

/**
 * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06) — mirrors
 * `RetrievalStatus` from vector-db.ts but adds the two conditions specific to THIS caller:
 * `flag_off` (experienceMemoryEnabled() is false, so retrieval never ran) and `ok_empty` (the
 * pipeline ran and returned "ok"/"no_memory" from vector-db but same-run exclusion or the
 * analog/coaching split left nothing to inject). Advisory receipt only — never changes which
 * chunks are injected.
 */
export type ExperienceRetrievalStatus = "flag_off" | "budget_skipped" | "lookup_failed" | "ok_empty" | "ok";

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
  /** Typed retrieval-status receipt — see `ExperienceRetrievalStatus`. */
  status: ExperienceRetrievalStatus;
}

function chunkMeta(chunk: RetrievedChunk, key: string): unknown {
  return chunk.metadata?.[key];
}

const ANALOG_CARD_MAX_CHARS = 1500;
const ANALOG_CARD_MAX_LINES = 12;
const ANALOG_CARD_CAP = 8;
const ANALOG_BLOCK_MAX_CHARS = 6000;

function analogMeta(chunk: RetrievedChunk, keys: string[]): unknown {
  const md = chunk.metadata ?? {};
  for (const key of keys) {
    const value = md[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function analogStr(chunk: RetrievedChunk, keys: string[]): string | undefined {
  const value = analogMeta(chunk, keys);
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed && trimmed !== "n/a" ? trimmed : undefined;
}

function analogNum(chunk: RetrievedChunk, keys: string[]): number | undefined {
  const value = analogMeta(chunk, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function analogBool(chunk: RetrievedChunk, keys: string[]): boolean | undefined {
  const value = analogMeta(chunk, keys);
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true" || value === "yes") return true;
  if (value === 0 || value === "0" || value === "false" || value === "no") return false;
  return undefined;
}

function analogFmt(value: number): string {
  const n = round2(value);
  return Number.isInteger(n) ? String(n) : String(n);
}

function analogTextField(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|\\n)${escaped}:\\s*(.+)`, "i"));
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!value || value === "n/a") return undefined;
  return value;
}

function analogOutcomeScalar(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\b${escaped}\\s*[=:]\\s*([^;\\n]+)`, "i"));
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  return value && value !== "n/a" ? value : undefined;
}

function looksLikeJsonDump(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  if (trimmed.length < 80) return false;
  if (/"greenTeamRationale"|"redTeamVerdict"|"ragAttributions"|"policyDecision"|"evidenceRefs"/.test(trimmed)) {
    return true;
  }
  const quotes = trimmed.match(/"/g);
  return trimmed.startsWith("{") && (quotes?.length ?? 0) > 24;
}

function tryParseCaseObject(text: string): Record<string, unknown> | undefined {
  if (!looksLikeJsonDump(text)) return undefined;
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function analogSideLabel(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s || s === "n/a") return undefined;
  if (s === "buy" || s === "long") return "long";
  if (s === "short" || s === "cover") return "short";
  return s;
}

function analogTicker(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t === "n/a") return undefined;
  if (t.toUpperCase() === "PORTFOLIO") return "PORTFOLIO";
  return normalizeSymbol(t);
}

const ANALOG_BOILERPLATE_LINE =
  /^(Experience memory:|Socratic institutional memory case|Durable lesson from a Socratic decision case)\b/i;
const ANALOG_SKIP_LABELED_LINE =
  /^(ticker|side|thesis_tag|entry_market_regime|sector|entry_factor_scores|macro_snapshot_at_entry|entry_confidence|exit_reason|realized_outcome|entry_at|exit_at|timestamp|final_action|authority|broker_argument|critic_counter_argument|policy_outcome|autonomy_override|rag_contribution|evidence|outcome|lessons|coach_notes|decision_id|entry_rationale|lesson):/i;

function unstructuredRationale(text: string): string | undefined {
  if (looksLikeJsonDump(text)) return undefined;
  const cleaned = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !ANALOG_BOILERPLATE_LINE.test(line) && !ANALOG_SKIP_LABELED_LINE.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function caseString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const trimmed = value.replace(/\s+/g, " ").trim();
      if (trimmed && trimmed !== "n/a") return trimmed;
    }
  }
  return undefined;
}

function caseReturnPct(obj: Record<string, unknown> | undefined): number | undefined {
  if (!obj) return undefined;
  const direct = obj.returnPct ?? obj.return_pct ?? obj.realizedReturnPct;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const outcome = obj.outcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    const rp = (outcome as Record<string, unknown>).returnPct ?? (outcome as Record<string, unknown>).return_pct;
    if (typeof rp === "number" && Number.isFinite(rp)) return rp;
  }
  return undefined;
}

function analogNumFromText(text: string, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = analogOutcomeScalar(text, key);
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function analogBoolFromText(text: string, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const raw = analogOutcomeScalar(text, key)?.toLowerCase();
    if (!raw) continue;
    if (raw === "true" || raw === "yes" || raw === "1") return true;
    if (raw === "false" || raw === "no" || raw === "0") return false;
  }
  return undefined;
}

/**
 * Retrieve-side analog card (~400–1500 chars, 6–12 lines max). Packs situation + realized
 * scalars + a short rationale. Never dumps a SocraticDecisionCase JSON blob into the prompt.
 */
export function formatAnalogCard(chunk: RetrievedChunk): string {
  const text = typeof chunk.text === "string" ? chunk.text : "";
  const parsed = tryParseCaseObject(text);

  const symbol =
    analogTicker(analogStr(chunk, ["symbol"])) ??
    analogTicker(analogTextField(text, "ticker")) ??
    analogTicker(caseString(parsed, ["symbol"]));
  const side =
    analogSideLabel(analogStr(chunk, ["side"])) ??
    analogSideLabel(analogTextField(text, "side")) ??
    analogSideLabel(caseString(parsed, ["side"]));
  const thesis =
    analogStr(chunk, ["thesis_tag", "thesis", "tradeThesisTag"]) ??
    analogTextField(text, "thesis_tag") ??
    caseString(parsed, ["thesisTag", "thesis", "tradeThesisTag"]);
  const regime =
    analogStr(chunk, ["entry_market_regime", "regime"]) ??
    analogTextField(text, "entry_market_regime") ??
    caseString(parsed, ["regime", "entryMarketRegime"]);
  const returnPct =
    analogNum(chunk, ["return_pct", "realizedReturnPct"]) ??
    analogNumFromText(text, ["return_pct", "realizedReturnPct"]) ??
    caseReturnPct(parsed);
  const holdingDays =
    analogNum(chunk, ["holding_days", "holdingDays"]) ??
    analogNumFromText(text, ["holding_days", "holdingDays"]);
  const riskExit =
    analogBool(chunk, ["risk_exit", "riskExit"]) ??
    analogBoolFromText(text, ["risk_exit", "riskExit"]);

  const headerBits = [`ANALOG ${symbol ?? "n/a"}${side ? ` ${side}` : ""}`];
  if (thesis) headerBits.push(`thesis ${thesis}`);
  if (returnPct !== undefined) headerBits.push(`return_pct ${analogFmt(returnPct)}`);
  if (holdingDays !== undefined) headerBits.push(`holding_days ${analogFmt(holdingDays)}`);
  if (riskExit !== undefined) headerBits.push(`risk_exit ${riskExit ? "yes" : "no"}`);
  if (regime) headerBits.push(`regime ${regime}`);

  const situationParts: string[] = [];
  const sector = analogStr(chunk, ["sector"]) ?? analogTextField(text, "sector");
  if (sector) situationParts.push(sector);
  const factors = analogTextField(text, "entry_factor_scores");
  if (factors) situationParts.push(factors);
  const macro = analogTextField(text, "macro_snapshot_at_entry");
  if (macro) situationParts.push(macro);
  const evidence = analogTextField(text, "evidence");
  if (evidence && !/^No structured evidence/i.test(evidence)) {
    situationParts.push(compact(evidence, 220));
  }
  const situation = situationParts.length > 0 ? compact(situationParts.join("; "), 400) : undefined;

  const rationaleSource =
    analogTextField(text, "entry_rationale") ??
    analogTextField(text, "broker_argument") ??
    analogTextField(text, "lesson") ??
    analogTextField(text, "rationale") ??
    caseString(parsed, ["greenTeamRationale", "rationale", "thesis", "lesson"]) ??
    unstructuredRationale(text);
  const rationale = rationaleSource ? compact(rationaleSource, 400) : undefined;

  const lines = [
    headerBits.join(" | "),
    situation ? `situation: ${situation}` : undefined,
    rationale && rationale !== "n/a" ? `rationale: ${rationale}` : undefined
  ].filter((line): line is string => Boolean(line));

  let kept = lines.slice(0, ANALOG_CARD_MAX_LINES);
  let card = kept.join("\n");
  if (card.length <= ANALOG_CARD_MAX_CHARS) return card;
  while (card.length > ANALOG_CARD_MAX_CHARS && kept.length > 1) {
    const last = kept[kept.length - 1]!;
    const overflow = card.length - ANALOG_CARD_MAX_CHARS;
    if (last.length > 80) {
      kept[kept.length - 1] = compact(last, Math.max(48, last.length - overflow - 1));
    } else {
      kept = kept.slice(0, -1);
    }
    card = kept.join("\n");
  }
  if (card.length > ANALOG_CARD_MAX_CHARS) {
    return `${card.slice(0, ANALOG_CARD_MAX_CHARS).trimEnd()}…`;
  }
  return card;
}

function selectAnalogChunks(ordered: RetrievedChunk[], window: RetrievedChunk[]): RetrievedChunk[] {
  const analogWindow = window.filter((chunk) => chunk.doc_type !== "coach-note").slice(0, ANALOG_CARD_CAP);
  const analogPool = ordered.filter((chunk) => chunk.doc_type !== "coach-note");
  if (analogWindow.some((chunk) => realizedSign(chunk) === -1)) return analogWindow;
  const reserved = analogPool.find((chunk) => realizedSign(chunk) === -1);
  if (!reserved) return analogWindow;
  if (analogWindow.some((chunk) => chunk.id === reserved.id)) return analogWindow;
  if (analogWindow.length === 0) return [reserved];
  return [...analogWindow.slice(0, -1), reserved];
}

function packAnalogsBlock(
  asOf: string,
  topAnalogSimilarity: number | undefined,
  analogChunks: RetrievedChunk[]
): string | undefined {
  if (analogChunks.length === 0) return undefined;
  const header = `CLOSEST HISTORICAL ANALOGS (episodic memory, advisory; as of ${asOf}${
    typeof topAnalogSimilarity === "number" ? `; top-analog similarity ${topAnalogSimilarity.toFixed(2)}` : ""
  }). Entries labeled COUNTEREXAMPLE had the OPPOSITE realized sign — weigh them as dissent, not noise.`;
  const cards = analogChunks.map((chunk) => {
    const formatted = formatAnalogCard(chunk);
    return realizedSign(chunk) === -1 ? `[COUNTEREXAMPLE — opposite realized sign]\n${formatted}` : formatted;
  });
  const kept: string[] = [];
  for (const card of cards) {
    const next = [header, ...kept, card].join("\n\n");
    if (kept.length > 0 && next.length > ANALOG_BLOCK_MAX_CHARS) break;
    kept.push(card);
    if (kept.length >= ANALOG_CARD_CAP) break;
  }
  const counter = cards.find((card) => card.startsWith("[COUNTEREXAMPLE"));
  if (counter && !kept.some((card) => card.startsWith("[COUNTEREXAMPLE"))) {
    if (kept.length === 0) kept.push(counter);
    else kept[kept.length - 1] = counter;
  }
  return [header, ...kept].join("\n\n");
}

function realizedSign(chunk: RetrievedChunk): number | undefined {
  const value = analogNum(chunk, ["return_pct", "realizedReturnPct"]);
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
  /** Strategy-run deadline. Aborts the underlying query embed / dense read. */
  signal?: AbortSignal;
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
    query,
    status: "flag_off"
  };
  if (!experienceMemoryEnabled()) return empty;

  const k = Math.min(10, Math.max(5, input.k ?? 8));
  let chunks: RetrievedChunk[] = [];
  // Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): populated by
  // retrieveContextDetailed's onStatus callback below. Advisory only — never affects `chunks`.
  // Held in an object (not a bare `let`) so TS doesn't narrow the read below to the closure's
  // capture-time literal type across the intervening `await`.
  const vectorStatusRef: { value: RetrievalStatus } = { value: "ok" };
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
        connectedAccountId: input.connectedAccountId,
        accountScope: "exact",
        runId: input.runId,
        ...(input.signal ? { signal: input.signal } : {}),
        onStatus: (s) => {
          vectorStatusRef.value = s;
        }
      }
    );
    // Same-run / future-neighbor exclusion: a case this run just indexed (decision run OR exit
    // run stamped with this runId) must not be retrieved back into this run's own prompt.
    const eligible = fetched.filter(
      (chunk) =>
        chunkMeta(chunk, "run_id") !== input.runId && chunkMeta(chunk, "exit_run_id") !== input.runId
    );
    // Advisory usefulness re-rank (retrieval-usefulness join, handoff 4.1): doc types whose past
    // injections preceded better matured outcomes rank somewhat higher. RANK-STABLE: the nudge is
    // a bounded ±10% multiplier on an RRF-style positional base over the INCOMING order, so the
    // upstream ordering semantics (similarity sort or HYBRID_RETRIEVAL's RRF-fused order) are
    // preserved exactly when multipliers are equal (neutral prior for unseen kinds, off-switch
    // RETRIEVAL_USEFULNESS_WEIGHTING=off). NEVER excludes a kind and NEVER fails retrieval — any
    // error falls open to the incoming order above.
    let ordered = eligible;
    try {
      const { applyRetrievalUsefulnessWeighting } = await import("./retrieval-usefulness");
      ordered = applyRetrievalUsefulnessWeighting(eligible, input.userId);
    } catch {
      ordered = eligible;
    }
    chunks = ordered.slice(0, k);

    const coachingChunks = chunks.filter((chunk) => chunk.doc_type === "coach-note");
    const analogChunks = selectAnalogChunks(ordered, chunks);

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

    const analogsBlock = packAnalogsBlock(asOf, topAnalogSimilarity, analogChunks);

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

    // Map vector-db's typed status onto this caller's status union. `budget_skipped`/`lookup_failed`
    // pass through unchanged; vector-db's "no_memory"/"degraded"/"ok" all collapse to this caller's
    // own "ok"/"ok_empty" split — `injected.length` is the ground truth for THIS caller (same-run
    // exclusion can empty out an otherwise-"ok" vector-db result, which "no_memory" alone wouldn't
    // capture).
    const vectorStatus = vectorStatusRef.value;
    const status: ExperienceRetrievalStatus =
      vectorStatus === "budget_skipped" || vectorStatus === "lookup_failed"
        ? vectorStatus
        : injected.length > 0
          ? "ok"
          : "ok_empty";

    try {
      bumpVectorDocRetrieved({
        userId: input.userId,
        vectorIds: injected.map((row) => row.id)
      });
    } catch {
      // Lifecycle table is additive; a missing migration/table must never fail retrieval.
    }

    return {
      analogsBlock,
      coachingBlock,
      analogChunks,
      coachingChunks,
      injected,
      asOf,
      query,
      topAnalogSimilarity,
      status
    };
  } catch (err) {
    console.warn(
      "[experience-memory] decision-time retrieval failed; continuing without analogs:",
      err instanceof Error ? err.message : String(err)
    );
    return { ...empty, status: "lookup_failed" };
  }
}
