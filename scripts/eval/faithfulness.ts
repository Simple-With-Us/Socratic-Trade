/**
 * Faithfulness / citation-grounding scorer (R11, 2026-07-01 RAG backlog).
 *
 * docs/chat-assistant-rag-learning.md §5 calls for "recall@k/MRR + faithfulness". C1
 * (test/rag-retrieval-eval.test.ts) covers recall/MRR only; this module is the faithfulness half.
 *
 * Faithfulness here means: given (query, retrieved chunks, model answer with citations), does the
 * answer's content actually trace back to what was retrieved? Two DETERMINISTIC checks (no
 * network, no API key) form the floor:
 *
 *   1. citationsGrounded  — every `chunk_id` the answer CITES must be present in the retrieved
 *      set. A citation to a chunk that was never retrieved is a fabricated source, full stop.
 *   2. numericClaimsSupported — every standalone number the answer states (dollar amounts,
 *      percentages, plain numerics) must substring-appear in the text of AT LEAST ONE retrieved
 *      chunk. This catches the most damaging failure mode (a hallucinated figure) with a cheap,
 *      explainable check — it is NOT a full entailment/NLI check.
 *
 * An OPTIONAL LLM judge (default OFF, no-ops without OPENAI_API_KEY) adds a holistic pass for
 * claims the deterministic checks can't reach (paraphrased facts, causal claims). Mirrors
 * `scoreLlmJudge` in score.ts. Kept OUT of required CI — a network-dependent judge in a hard gate
 * is a flaky-build risk this repo has hit before (see AGENTS.md's CI notes).
 *
 * IMPORTANT: the deterministic checks are a FLOOR, not a verdict. Passing them means "no
 * detectable fabrication of the cheap-to-check kind" — NOT "this answer is fully faithful".
 */

import { isReasoningModel, LLM_TIMEOUT_MS } from "../../src/lib/llm-request";
import { extractLlmUsage, recordLlmUsage } from "../../src/lib/llm-usage";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FaithfulnessChunk {
  chunk_id: string;
  text: string;
}

export interface FaithfulnessCase {
  id: string;
  query: string;
  /** The chunks actually returned by retrieval for this query (the "grounding truth"). */
  retrievedChunks: FaithfulnessChunk[];
  /** The model's answer text, expected to cite chunk ids inline, e.g. "[AAPL-10K#c001]". */
  answer: string;
  /** Optional rubric for the LLM judge (skipped when the judge isn't configured). */
  rubric?: string;
}

export interface FaithfulnessResult {
  caseId: string;
  citationsGrounded: boolean;
  /** Citation ids the answer referenced that are NOT in retrievedChunks (fabricated sources). */
  unsupportedCitations: string[];
  numericClaimsSupported: boolean;
  /** Numeric substrings in the answer that don't appear in ANY retrieved chunk's text. */
  unsupportedNumericClaims: string[];
  /** citationsGrounded && numericClaimsSupported — the deterministic floor verdict. */
  pass: boolean;
}

// ── Citation extraction ──────────────────────────────────────────────────────

/**
 * Extract cited chunk ids from an answer. Supports the two citation shapes this codebase's
 * chat/eval fixtures actually use: bracketed `[chunk-id]` and a `(source: chunk-id)` style.
 * Pure string/regex — no assumption about a specific chunk_id format beyond "no whitespace,
 * no closing bracket/paren".
 */
export function extractCitedChunkIds(answer: string): string[] {
  const ids = new Set<string>();
  for (const m of answer.matchAll(/\[([^\]\s]+)\]/g)) {
    const id = m[1];
    if (id) ids.add(id);
  }
  for (const m of answer.matchAll(/\(source:\s*([^)\s]+)\)/gi)) {
    const id = m[1];
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

// ── Numeric claim extraction ─────────────────────────────────────────────────

/**
 * Extract standalone numeric claims from an answer: dollar amounts ("$1.2 billion", "$45.20"),
 * percentages ("12%", "3.5%"), and plain multi-digit numbers (>=2 digits, to skip noise like a
 * lone "1" in prose). Deliberately conservative/simple — this is a substring-grounding check,
 * not a unit-aware financial-claim parser.
 */
export function extractNumericClaims(answer: string): string[] {
  const claims = new Set<string>();
  for (const m of answer.matchAll(/\$\s?[\d,]+(?:\.\d+)?\s?(?:billion|million|thousand|bn|mm|k)?/gi)) {
    claims.add(m[0].trim());
  }
  for (const m of answer.matchAll(/\b\d+(?:\.\d+)?\s?%/g)) {
    claims.add(m[0].trim());
  }
  for (const m of answer.matchAll(/\b\d{2,}(?:\.\d+)?\b/g)) {
    // Skip numbers already captured as part of a $ or % claim above (approximate by checking
    // whether any existing claim contains this numeric substring).
    const already = Array.from(claims).some((c) => c.includes(m[0]));
    if (!already) claims.add(m[0]);
  }
  return Array.from(claims);
}

/** Normalize for substring comparison: strip commas/whitespace variance, lowercase. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ").trim();
}

// ── Deterministic scorer ─────────────────────────────────────────────────────

/**
 * Score one (query, retrievedChunks, answer) tuple against the two deterministic checks.
 * Pure, offline, no network — the only inputs are the strings/arrays passed in.
 */
export function scoreFaithfulness(evalCase: Pick<FaithfulnessCase, "id" | "retrievedChunks" | "answer">): FaithfulnessResult {
  const retrievedIds = new Set(evalCase.retrievedChunks.map((c) => c.chunk_id));
  const citedIds = extractCitedChunkIds(evalCase.answer);
  const unsupportedCitations = citedIds.filter((id) => !retrievedIds.has(id));
  const citationsGrounded = unsupportedCitations.length === 0;

  const normalizedChunkTexts = evalCase.retrievedChunks.map((c) => normalizeForMatch(c.text));
  const numericClaims = extractNumericClaims(evalCase.answer);
  const unsupportedNumericClaims = numericClaims.filter((claim) => {
    const normalizedClaim = normalizeForMatch(claim);
    return !normalizedChunkTexts.some((text) => text.includes(normalizedClaim));
  });
  const numericClaimsSupported = unsupportedNumericClaims.length === 0;

  return {
    caseId: evalCase.id,
    citationsGrounded,
    unsupportedCitations,
    numericClaimsSupported,
    unsupportedNumericClaims,
    pass: citationsGrounded && numericClaimsSupported
  };
}

// ── Optional LLM judge (default OFF; no-ops without OPENAI_API_KEY) ─────────

export interface FaithfulnessJudgeResult {
  ran: boolean;
  pass: boolean;
  detail: string;
}

/** Returns true when RAG_EVAL_FAITHFULNESS_JUDGE is truthy AND OPENAI_API_KEY is set. Default OFF. */
export function faithfulnessJudgeEnabled(): boolean {
  const flagOn = String(process.env.RAG_EVAL_FAITHFULNESS_JUDGE ?? "").trim().toLowerCase();
  const wantsJudge = ["1", "true", "on", "yes"].includes(flagOn);
  return wantsJudge && Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Optional holistic LLM-judge pass over claims the deterministic checks can't reach (paraphrased
 * facts, causal claims). No-ops (ran:false) unless BOTH RAG_EVAL_FAITHFULNESS_JUDGE is truthy AND
 * OPENAI_API_KEY is set — this keeps the judge out of any required/default CI run. Mirrors the
 * pattern in scripts/eval/score.ts's scoreLlmJudge.
 */
export async function judgeFaithfulness(evalCase: FaithfulnessCase): Promise<FaithfulnessJudgeResult> {
  if (!faithfulnessJudgeEnabled()) {
    return { ran: false, pass: false, detail: "skipped (RAG_EVAL_FAITHFULNESS_JUDGE off or OPENAI_API_KEY unset)" };
  }
  const apiKey = process.env.OPENAI_API_KEY!;
  const model = process.env.RAG_EVAL_FAITHFULNESS_JUDGE_MODEL || "gpt-5.4-mini";
  const context = evalCase.retrievedChunks.map((c) => `[${c.chunk_id}] ${c.text}`).join("\n\n");
  const prompt = [
    "You are a faithfulness judge for a RAG system. Given retrieved context and a model answer,",
    "determine whether every factual claim in the answer is supported by the context.",
    evalCase.rubric ? `RUBRIC: ${evalCase.rubric}` : "",
    "",
    `QUERY: ${evalCase.query}`,
    "",
    `RETRIEVED CONTEXT:\n${context}`,
    "",
    `ANSWER: ${evalCase.answer}`,
    "",
    'Reply with exactly one line: "PASS" or "FAIL", followed by a brief reason (max 100 chars).'
  ]
    .filter(Boolean)
    .join("\n");

  const tokenParam = isReasoningModel(model) ? { max_completion_tokens: 80 } : { max_tokens: 80 };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...tokenParam, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ran: true, pass: false, detail: `judge error ${res.status}: ${text.slice(0, 120)}` };
    }
    const payload = await res.json();
    // Every LLM call is hardwired into the usage ledger + external telemetry (owner directive),
    // including this dev-only faithfulness judge. Runs against whatever DATABASE_URL is set —
    // intended. recordLlmUsage never throws, but wrapped anyway so a ledger hiccup can never fail
    // the eval run.
    try {
      recordLlmUsage({
        userId: "local",
        provider: "openai",
        model,
        context: "eval-faithfulness",
        keySource: "operator",
        ...extractLlmUsage(payload)
      });
    } catch {
      /* usage ledger is best-effort; never break the eval run */
    }
    const data = payload as { choices?: Array<{ message?: { content?: string } }> };
    const verdict = (data?.choices?.[0]?.message?.content ?? "").trim();
    const pass = /^PASS\b/i.test(verdict);
    const reason = verdict.replace(/^(PASS|FAIL)\s*/i, "").trim().slice(0, 120) || "(no reason given)";
    return { ran: true, pass, detail: `judge[${evalCase.id}]: ${pass ? "PASS" : "FAIL"} — ${reason}` };
  } catch (e) {
    return { ran: true, pass: false, detail: `judge exception: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Aggregate reporting ──────────────────────────────────────────────────────

export interface FaithfulnessSummary {
  total: number;
  citationSupportRate: number;
  unsupportedClaimCount: number;
  passCount: number;
}

/** Aggregate a citation-support rate + unsupported-claim count across many results. */
export function summarizeFaithfulness(results: FaithfulnessResult[]): FaithfulnessSummary {
  const total = results.length;
  const citationsGroundedCount = results.filter((r) => r.citationsGrounded).length;
  const unsupportedClaimCount = results.reduce((sum, r) => sum + r.unsupportedNumericClaims.length, 0);
  const passCount = results.filter((r) => r.pass).length;
  return {
    total,
    citationSupportRate: total === 0 ? 1 : citationsGroundedCount / total,
    unsupportedClaimCount,
    passCount
  };
}
