// Structured-output LLM salience extractor (item 7, 2026-07-01 RAG workstream).
//
// extractLearnedCandidates() in salience.ts is an admitted "deterministic rule-based stand-in"
// (see salience.ts:1-4) — its TICKER_RE (`\b([A-Z]{1,5})\b`) matches ANY 1-5 char uppercase token,
// so ordinary words/abbreviations ("I", "A", "CEO", "ESG") get attached as a symbol whenever they
// appear near a pattern/decision-triggering phrase. This module adds an LLM-based extractor that:
//   1. Is OFF by default (LLM_SALIENCE_EXTRACTOR env flag) — extractLearnedCandidates (regex) stays
//      the production default AND the deterministic test fallback so offline tests never depend on
//      a network call.
//   2. Validates any symbol the model proposes against the real known-universe check
//      (isIndexMemberSymbol) instead of accepting any uppercase token — a hallucinated or
//      out-of-universe "ticker" is dropped (kept symbol-less) rather than silently attached.
//   3. Falls back to the regex extractor on ANY failure (no key, network error, malformed JSON,
//      timeout) — the write path (orchestrator.ts) must never lose learned-context candidates
//      just because the LLM path had a bad day.
//
// This governs a chat memory-extraction side-channel, not the money path: nothing here can
// ever escalate above 'fact' tier (ingestLearned's chat hard-cap still applies downstream) and
// nothing here touches sizing/weights/orders.

import { getPolicy } from "../db";
import { isIndexMemberSymbol } from "../index-universes";
import { buildLlmRequestBody, extractLlmText, llmAuthHeaders, type LlmJsonSchema } from "../llm-call";
import { resolveLlmEndpoint } from "../llm-provider";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_TIMEOUT_MS } from "../llm-request";
import type { LearnedContextCandidate } from "../types";
import { extractLearnedCandidates } from "./salience";

/** Returns true when LLM_SALIENCE_EXTRACTOR=on. Default OFF — regex extraction is unaffected. */
export function llmSalienceExtractorEnabled(): boolean {
  return String(process.env.LLM_SALIENCE_EXTRACTOR ?? "off").trim().toLowerCase() === "on";
}

const EXTRACTOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: {
            type: "string",
            enum: ["pattern", "decision"],
            description: "'pattern' = a recurring/behavioral observation; 'decision' = a durable named fact."
          },
          value: { type: "string", description: "The observation or fact, verbatim or lightly trimmed from the message (<=200 chars)." },
          symbol: {
            type: ["string", "null"],
            description: "The stock ticker this candidate is about, if any (e.g. 'AAPL'). null if none or not a real ticker."
          }
        }
      }
    }
  }
};

const SCHEMA: LlmJsonSchema = {
  name: "learned_context_candidates",
  schema: EXTRACTOR_SCHEMA,
  description: "Durable learned-context candidates extracted from a user chat message."
};

const SYSTEM_PROMPT = `You extract durable learned-context candidates from a single chat message in a stock-trading app.

Only extract:
- "pattern": an explicitly stated recurring/seasonal/behavioral observation about a stock or the market (e.g. "TSLA always drifts up after earnings").
- "decision": a durable named fact about a company or market structure (e.g. "NVDA is the dominant supplier of AI accelerators").

Do NOT extract opinions, requests, questions, or one-off statements. If the message contains nothing durable, return an empty candidates array.

If a candidate is about a specific company, set "symbol" to its stock ticker (e.g. "AAPL"). Only set a symbol when you are confident it is a REAL, currently-traded stock ticker explicitly named or unambiguously implied by the message — never guess, never invent one, and never use a common word/acronym/abbreviation (e.g. "I", "A", "CEO", "ESG", "IPO") as if it were a ticker. If unsure, set symbol to null.

Respond ONLY with the structured candidates array — no prose.`;

/** Raw shape the LLM returns before ticker validation. */
interface RawCandidate {
  kind?: unknown;
  value?: unknown;
  symbol?: unknown;
}

/**
 * Parse the model's JSON text into raw candidates. Throws on malformed/unparseable JSON so the
 * caller's try/catch falls back to the regex extractor — distinct from a well-formed
 * `{"candidates": []}` response (a legitimate "nothing durable in this message" answer), which
 * returns an empty array rather than throwing.
 */
function parseRawCandidates(text: string | undefined): RawCandidate[] {
  if (!text) throw new Error("empty LLM response text");
  const parsed = JSON.parse(text) as { candidates?: unknown };
  return Array.isArray(parsed.candidates) ? (parsed.candidates as RawCandidate[]) : [];
}

/**
 * Validate a model-proposed symbol against the real known-universe membership check
 * (isIndexMemberSymbol — S&P 500 / NASDAQ-100 / DOW-30 union), NOT the permissive format-only
 * isValidAppSymbol check. This is the fix for TICKER_RE over-matching: a pseudo-ticker like "I" or
 * "CEO" fails membership and is dropped (candidate is kept, just symbol-less) rather than attached.
 */
function validateSymbol(symbol: unknown): string | null {
  if (typeof symbol !== "string") return null;
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed) return null;
  return isIndexMemberSymbol(trimmed) ? trimmed : null;
}

function toLearnedContextCandidates(raw: RawCandidate[], message: string): LearnedContextCandidate[] {
  const lc = message.toLowerCase();
  const out: LearnedContextCandidate[] = [];
  for (const r of raw) {
    const kind = r.kind === "pattern" || r.kind === "decision" ? r.kind : undefined;
    if (!kind) continue;
    const value = typeof r.value === "string" && r.value.trim() ? r.value.trim().slice(0, 200) : undefined;
    if (!value) continue;
    const symbol = validateSymbol(r.symbol);
    out.push({
      kind,
      subject: symbol ? `${kind === "pattern" ? "pattern" : "fact"}:${symbol}` : kind === "pattern" ? "pattern" : "fact",
      value,
      symbol,
      source: "user_stated",
      confidence: 0.6,
      intent: lc
    });
  }
  return out;
}

/**
 * Structured-output LLM extraction of learned-context candidates. Falls back to the deterministic
 * regex extractor (extractLearnedCandidates) on ANY failure — flag off, no credential, network
 * error, timeout, or malformed/empty response — so the write path never silently loses candidates
 * and offline tests keep using the regex path unless they explicitly opt into the LLM path.
 */
export async function extractLearnedCandidatesLLM(message: string, userId: string = "local"): Promise<LearnedContextCandidate[]> {
  if (!llmSalienceExtractorEnabled()) return extractLearnedCandidates(message, isIndexMemberSymbol);

  try {
    const policy = getPolicy(userId);
    const endpoint = resolveLlmEndpoint(policy, userId, "https://api.openai.com/v1/chat/completions", "green");
    if (!endpoint.key) return extractLearnedCandidates(message, isIndexMemberSymbol);

    const body = buildLlmRequestBody(
      { provider: endpoint.provider, transport: endpoint.transport },
      {
        model: endpoint.model,
        systemPrompt: SYSTEM_PROMPT,
        userContent: message,
        schema: SCHEMA,
        maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.salienceExtraction
      }
    );

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: llmAuthHeaders(endpoint),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });
    if (!response.ok) return extractLearnedCandidates(message, isIndexMemberSymbol);

    const payload = await response.json();
    const text = extractLlmText(payload);
    const raw = parseRawCandidates(text); // throws on malformed JSON -> caught below -> regex fallback
    if (raw.length === 0) return []; // well-formed "nothing durable" answer, not a failure
    return toLearnedContextCandidates(raw, message);
  } catch (err) {
    console.warn("[salience-llm] extraction failed; falling back to regex:", err instanceof Error ? err.message : String(err));
    return extractLearnedCandidates(message, isIndexMemberSymbol);
  }
}
