/**
 * Past-decision case affinity (ST-4539, RAG improvement 1).
 *
 * ## What already existed (and is deliberately NOT rebuilt here)
 *
 * ST-4539 asked for three things. Two were already built and merged before this issue landed, and
 * re-implementing either would be a regression risk, not progress:
 *
 *  1. "Store each trade decision's rationale plus its outcome/post-mortem lesson as a retrievable
 *     case" — `experience-memory.ts`'s `recordClosedLotExperience` embeds one document per closed
 *     lot carrying the ENTRY rationale (`entry_rationale:`) alongside the realized outcome
 *     (`realized_outcome: return_pct=… holding_days=… risk_exit=… mae=… mfe=…`), keyed by the entry
 *     proposalId. Post-mortem lessons have their own writer (`writeThesisRegimeLessonVectors` in
 *     post-mortem.ts, one `doc_type: "lesson"` vector per thesisTag x regime bucket). Both already
 *     ride the existing RAG ingest path (`storeContexts`).
 *  2. "Retrieve the top-k most similar past cases and include them in the decision context with
 *     outcome" — `retrieveDecisionExperiences` (experience-memory.ts) k-NN's those doc types with a
 *     SITUATION SKETCH, excludes same-run neighbors, stamps `asOf`, reserves a COUNTEREXAMPLE slot,
 *     and packs each case through `formatAnalogCard` (return_pct / holding_days / risk_exit land in
 *     the prompt).
 *
 * ## The gap this module closes
 *
 * "most similar past cases (**same symbol/strategy/setup weighted**)". The episodic pass runs with
 * `matchAllSymbols: true` — the module header calls that "by design: the same setup on a different
 * ticker is exactly the kind of prior the review wants surfaced". That intent is right and is kept.
 * But it means a decision on AAPL is ranked purely by vector similarity, and a prior on the SAME
 * ticker with the same thesis and regime scores no better than an unrelated name that happened to
 * embed nearby. This module adds the missing weighting as a BOUNDED, RANK-STABLE, BOOST-ONLY
 * re-rank over the chunks the retrieval pass already fetched.
 *
 * ## Guarantees (same contract style as retrieval-usefulness.ts, which is the sibling re-rank)
 *
 *  - ADDSITIVE: reorders chunks that are already in memory. Writes nothing, deletes nothing, and
 *    touches no stored record. It cannot drop a case — a mis-scored affinity at worst wastes a slot
 *    on a cross-symbol analog, exactly what today's no-weighting behavior already does.
 *  - ADVISORY ONLY: the result is prompt DATA for the Bull/Bear prompts. Nothing here gates, sizes,
 *    blocks, or approves. Same philosophy as the module it feeds.
 *  - GATE UNTOUCHED (ST-3843 / ST-4448): this runs on the READ side, after ingestion. It creates no
 *    learned-context candidate, so it cannot reach — let alone bypass — `classifyWithSemanticGate`
 *    or the human approval queue. Nothing it does promotes or demotes a candidate's gate tier.
 *  - ZERO ADDED I/O / LATENCY: no extra vector query, no extra embed, no extra DB read. It is a pure
 *    in-memory pass over the k+4 chunks already returned under the caller's existing deadline
 *    signal, so it inherits `withStrategyRagRetrievalDeadline` unchanged.
 *  - BOOST-ONLY: matched cases are multiplied up (bounded at +50%); unmatched cases get exactly
 *    1.0. Nothing is demoted, because the cross-symbol analog surfacing is a deliberate design
 *    property of the episodic pass and a penalty would suppress it.
 *  - RANK-STABLE: the base score is POSITIONAL (RRF-style 1/(K + incomingIndex)), never the raw
 *    similarity score, so the caller's ordering semantics survive. Equal multipliers produce a
 *    byte-identical order — when nothing matches, the output IS the input.
 *  - FAIL-OPEN: any error returns the input order unchanged. Retrieval never fails because of this.
 *  - OFF-SWITCH: `PAST_DECISION_CASE_AFFINITY=off` restores pre-issuance behavior exactly.
 */
import { envFlagOn } from "./rag/env-flag";
import { normalizeSymbol } from "./money";

/** Env off-switch. Default ON — the weighting is bounded, boost-only and fail-open. */
export const PAST_DECISION_CASE_AFFINITY_ENV = "PAST_DECISION_CASE_AFFINITY";

export function pastDecisionCaseAffinityEnabled(): boolean {
  return envFlagOn(PAST_DECISION_CASE_AFFINITY_ENV, true);
}

/** Minimal structural chunk shape — deliberately not `RetrievedChunk`, so this pure module stays
 *  dependency-free and unit-testable without the vector-db import graph. */
export interface AffinityChunk {
  doc_type?: string;
  metadata?: Record<string, unknown>;
  text?: string;
}

/** What the decision being made looks like. Derived from the situation candidates already handed to
 *  the episodic pass — no new upstream data is required. */
export interface CaseAffinityContext {
  /** Tickers under consideration this decision (normalized compare). */
  symbols: string[];
  /**
   * Thesis tags of the decision being made, when the caller knows them (e.g. a sell/hold/trim on a
   * held position that already carries a thesis). OPTIONAL on purpose: at proposal time the thesis
   * is chosen by the proposer LLM AFTER this retrieval runs, so it is normally unknown. Past cases
   * carrying a thesis_tag still earn the sector/factor/regime/symbol components.
   */
  thesisTags?: string[];
  /** Entry market regime of the decision being made — the "setup". */
  regime?: string;
  /** Sectors of the candidates under consideration. */
  sectors?: string[];
  /** Dominant scan factor of the candidates under consideration (momentum/value/… ). */
  dominantFactors?: string[];
}

/** RRF-style positional constant, matching retrieval-usefulness.ts so the two re-ranks compose
 *  predictably. The base is positional, not similarity-based, on purpose (see file header). */
export const CASE_AFFINITY_RRF_K = 60;

/**
 * Contribution of each matched dimension. `symbol` dominates: a prior on the SAME ticker under the
 * SAME thesis and regime is the strongest "this is the trade I already made" signal available.
 * Bounded so no single dimension can dominate the sum.
 */
export const CASE_AFFINITY_WEIGHTS = {
  symbol: 0.30,
  thesis: 0.25,
  regime: 0.15,
  sector: 0.10,
  factor: 0.10
} as const;

/**
 * Upper bound on the multiplier. NOTE this BINDS before the weight sum does: a case matching every
 * dimension scores 1 + 0.90 = 1.90 and is clamped to 1.5 here, so in practice the cap is what
 * "strongest possible match" means. Keep the two in step if either is retuned.
 */
export const CASE_AFFINITY_MAX_MULTIPLIER = 1.5;

/** Lower bound. BOOST-ONLY by design: unmatched cases stay at exactly 1.0, never below. */
export const CASE_AFFINITY_MIN_MULTIPLIER = 1;

function normalizeToken(value: string | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

function metaString(chunk: AffinityChunk, keys: string[]): string | undefined {
  const md = chunk.metadata;
  if (!md || typeof md !== "object") return undefined;
  for (const key of keys) {
    const value = md[key];
    if (typeof value === "string") {
      const trimmed = value.replace(/\s+/g, " ").trim();
      if (trimmed && trimmed !== "n/a") return trimmed;
    }
  }
  return undefined;
}

/** Read a `key: value` / `key=value` scalar out of the embedded document text. Mirrors the
 *  experience-memory.ts analog helpers so a case whose metadata was dropped still scores. */
function textField(text: string | undefined, key: string): string | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\b${escaped}\\s*[=:]\\s*([^;\\n]+)`, "i"));
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  return value && value !== "n/a" ? value : undefined;
}

function caseSymbol(chunk: AffinityChunk): string {
  const raw =
    metaString(chunk, ["symbol"]) ??
    textField(chunk.text, "ticker") ??
    textField(chunk.text, "symbol");
  return raw ? normalizeSymbol(raw) : "";
}

function caseThesis(chunk: AffinityChunk): string {
  const raw = metaString(chunk, ["thesis_tag", "thesis", "tradeThesisTag"]) ?? textField(chunk.text, "thesis_tag");
  return normalizeToken(raw);
}

function caseRegime(chunk: AffinityChunk): string {
  const raw =
    metaString(chunk, ["entry_market_regime", "regime"]) ??
    textField(chunk.text, "entry_market_regime") ??
    textField(chunk.text, "regime");
  return normalizeToken(raw);
}

function caseSector(chunk: AffinityChunk): string {
  return normalizeToken(metaString(chunk, ["sector"]) ?? textField(chunk.text, "sector"));
}

/** The dominant factor is carried in the embedded text as `entry_factor_scores: liquidity=… momentum=…`
 *  — the decision-time match is against the candidate's dominantFactor, so the highest-scoring key
 *  in that line is the case's own dominant factor. */
function caseDominantFactor(chunk: AffinityChunk): string {
  const line = textField(chunk.text, "entry_factor_scores");
  if (!line) return "";
  let bestKey = "";
  let bestValue = -Infinity;
  for (const token of line.split(/\s+/)) {
    const [rawKey, rawValue] = token.split("=");
    if (!rawKey || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (value > bestValue) {
      bestValue = value;
      bestKey = rawKey;
    }
  }
  return bestKey ? normalizeToken(bestKey) : "";
}

/**
 * Multiplier for one past case against the decision context. Returns exactly 1.0 when nothing
 * matches, and is bounded to [1, CASE_AFFINITY_MAX_MULTIPLIER].
 */
export function caseAffinityMultiplier(
  chunk: AffinityChunk,
  context: CaseAffinityContext
): number {
  let score = 0;

  const wantSymbols = new Set((context.symbols ?? []).map((s) => normalizeSymbol(s ?? "")).filter(Boolean));
  if (wantSymbols.size > 0 && wantSymbols.has(caseSymbol(chunk))) score += CASE_AFFINITY_WEIGHTS.symbol;

  const wantTheses = new Set((context.thesisTags ?? []).map((t) => normalizeToken(t)).filter(Boolean));
  if (wantTheses.size > 0 && wantTheses.has(caseThesis(chunk))) score += CASE_AFFINITY_WEIGHTS.thesis;

  const wantRegime = normalizeToken(context.regime);
  if (wantRegime && wantRegime === caseRegime(chunk)) score += CASE_AFFINITY_WEIGHTS.regime;

  const wantSectors = new Set((context.sectors ?? []).map((s) => normalizeToken(s)).filter(Boolean));
  if (wantSectors.size > 0 && wantSectors.has(caseSector(chunk))) score += CASE_AFFINITY_WEIGHTS.sector;

  const wantFactors = new Set((context.dominantFactors ?? []).map((f) => normalizeToken(f)).filter(Boolean));
  if (wantFactors.size > 0 && wantFactors.has(caseDominantFactor(chunk))) score += CASE_AFFINITY_WEIGHTS.factor;

  if (score <= 0) return CASE_AFFINITY_MIN_MULTIPLIER;
  return Math.min(CASE_AFFINITY_MAX_MULTIPLIER, 1 + score);
}

/**
 * Boost-only, rank-stable affinity re-rank over ALREADY-RETRIEVED past-decision cases.
 *
 * Never excludes, never re-queries, never fails the caller: on any error, or when the flag is off,
 * or when the context matches nothing, the input order is returned unchanged (which, thanks to the
 * rank-stable positional base, is also what an all-1.0 weighting produces).
 */
export function applyPastCaseAffinityWeighting<T extends AffinityChunk>(
  chunks: T[],
  context: CaseAffinityContext
): T[] {
  if (chunks.length < 2 || !pastDecisionCaseAffinityEnabled()) return chunks;
  if (!context || (context.symbols ?? []).length === 0) return chunks;
  try {
    const scored = chunks.map((chunk, index) => {
      const multiplier = caseAffinityMultiplier(chunk, context);
      return { chunk, index, multiplier, weighted: multiplier / (CASE_AFFINITY_RRF_K + index) };
    });
    const reordered = [...scored].sort((a, b) => b.weighted - a.weighted || a.index - b.index);
    const changed = reordered.some((entry, position) => entry.index !== position);
    if (changed) {
      console.log(
        `[past-decision-cases] affinity reweighting reordered ${chunks.length} retrieved case(s): ` +
          reordered
            .map((entry) => `#${entry.index}(${entry.chunk.doc_type ?? "?"} x${entry.multiplier.toFixed(2)})`)
            .join(" ")
      );
    }
    return reordered.map((entry) => entry.chunk);
  } catch (err) {
    console.warn(
      "[past-decision-cases] affinity weighting unavailable, using incoming order:",
      err instanceof Error ? err.message : String(err)
    );
    return chunks;
  }
}

/**
 * Build the affinity context from the situation candidates the episodic pass already receives.
 * Pure helper so the caller stays a one-liner and the mapping is unit-testable on its own.
 */
export function caseAffinityContextFromCandidates(input: {
  regime?: string;
  candidates: Array<{ symbol: string; sector?: string; dominantFactor?: string }>;
  thesisTags?: string[];
}): CaseAffinityContext {
  return {
    symbols: input.candidates.map((c) => normalizeSymbol(c.symbol ?? "")).filter(Boolean),
    sectors: input.candidates.map((c) => c.sector ?? "").filter(Boolean),
    dominantFactors: input.candidates.map((c) => c.dominantFactor ?? "").filter(Boolean),
    regime: input.regime,
    ...(input.thesisTags && input.thesisTags.length > 0 ? { thesisTags: input.thesisTags } : {})
  };
}