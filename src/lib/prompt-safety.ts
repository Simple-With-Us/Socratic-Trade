// prompt-safety.ts — deterministic, ADVISORY-ONLY receipts for the money-path prompts.
//
// Two pure scanners live here (CR-H prompt-safety lane, 2026-07-05):
//   1. scanForInjectionAttempts — a small, curated regex sweep over the UNTRUSTED text blocks
//      that get assembled into the Bull/Bear prompts (headlines, smart-money bulletins, RAG
//      snippets, learned facts, episodic blocks, the owner strategy prompt incl. its AI-LEARNED
//      appends, and the reflection summary).
//   2. collectEvidenceAgeAnomalies — flags evidence that is suspiciously FRESH (first seen <24h
//      before the run): a high-relevance RAG chunk dated today, or a learned fact asserted today.
//
// OWNER PHILOSOPHY (binding): detection IS the control. Findings become audit rows and
// decision-case evidence items — the scanned text is NEVER altered, dropped, or blocked, and
// generation always proceeds. This is a receipt printer, not a gate.
//
// This is a LEAF module: no imports, no DB, no I/O — so it is trivially unit-testable and can
// never entangle the strategy money path.

export interface UntrustedPromptField {
  /** Stable label for receipts, e.g. "reflection_summary", "headlines:AAPL". */
  name: string;
  text: string;
}

export interface InjectionFinding {
  /** The field the pattern fired in (UntrustedPromptField.name). */
  name: string;
  /** The curated pattern's id (NOT the raw regex — stable across regex tuning). */
  pattern: string;
  /** Short excerpt around the match so the receipt is reviewable without re-running the scan. */
  excerpt: string;
}

/** Max total findings returned/audited per scan — receipts, not a forensic dump. */
const MAX_FINDINGS = 24;
/** Excerpt window (chars) around a match. */
const EXCERPT_RADIUS = 80;
/**
 * Hard cap on a single finding's excerpt length. Most patterns match a short phrase, so the
 * ±EXCERPT_RADIUS window is normally well under this — EXCEPT base64-instruction-blob, whose
 * regex has no upper bound on match length: a multi-KB base64 run in a RAG chunk or filing would
 * otherwise produce an excerpt of comparable size. Findings are persisted verbatim into every
 * decision-case evidence item for the run (`data: findings`, see strategy.ts) via
 * upsertSocraticDecisionCase (db-socratic.ts) — unlike the audit-log and evidence-summary paths,
 * that write has no length cap of its own, so the cap has to live here, at the source.
 */
const MAX_EXCERPT_LENGTH = 400;

/**
 * The curated pattern set. Deliberately SMALL and low-false-positive: every pattern targets an
 * unambiguous instruction-hijack idiom, not general "suspicious" vocabulary. Ordinary financial
 * prose ("the Fed may override its prior guidance", "discuss overriding risk controls") must NOT
 * trip these — each regex requires the full hijack phrase shape, not a single keyword.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // "ignore/disregard/forget/override (all/any/the/your) previous/prior/above/earlier/original/
  // system instructions|prompt|rules|directives|messages" — the classic prompt-injection opener.
  // Requires BOTH the imperative verb and a prior-instructions noun phrase, so "override risk
  // controls" or "ignore the noise" never fire.
  {
    name: "override-prior-instructions",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|original|system)\s+(?:instructions?|prompts?|rules?|directives?|messages?)\b/i
  },
  // "new/updated/revised/replacement system message|prompt|instructions" — text claiming to BE a
  // fresh system turn. Plain "system upgrade announced" (product news) does not match.
  {
    name: "new-system-message",
    re: /\b(?:new|updated|revised|replacement)\s+system\s+(?:message|prompt|instructions?)\b/i
  },
  // Literal "system override" — a hijack idiom with no legitimate use in market text.
  { name: "system-override", re: /\bsystem\s+override\b/i },
  // "you must/will/shall now ..." / "you are now a|an|the|in ..." — imperative re-tasking or
  // persona hijack aimed at the model. Market prose talks ABOUT companies, not to "you".
  {
    name: "you-must-now",
    re: /\byou\s+(?:must|will|shall)\s+now\b|\byou\s+are\s+now\s+(?:a|an|the|in)\b/i
  },
  // Role-marker smuggling: a line that STARTS with "system:"/"assistant:"/"developer:" — trying
  // to fake a chat-transcript role boundary inside a data field. Anchored to line start so
  // mid-sentence mentions ("the payment system: reliable") don't fire.
  { name: "role-marker-smuggling", re: /^\s*(?:system|assistant|developer)\s*:/im },
  // Tool/function-call injection markers: chat-template delimiters or tool-call JSON keys that
  // have no business appearing inside headlines/facts/filings text.
  {
    name: "tool-call-injection",
    re: /<\|im_(?:start|end)\|>|<\/?(?:tool_call|function_call)>|"tool_calls"\s*:|\[(?:TOOL|FUNCTION)_CALL\]/i
  },
  // A 200+ char unbroken base64-alphabet blob — an obfuscated instruction payload. Real market
  // text (incl. long URLs) virtually never carries 200 consecutive chars of pure [A-Za-z0-9+/].
  { name: "base64-instruction-blob", re: /[A-Za-z0-9+/]{200,}={0,2}/ },
  // Fence-escape smuggling: a literal <reflection_summary>/<owner_strategy_prompt> tag (open OR
  // close) inside UNTRUSTED field text. These are the DATA fences this branch introduces around
  // the reflection summary and owner strategy prompt (see strategy-prompts.ts) — an untrusted
  // field containing one is attempting to forge a fence boundary and smuggle itself out of the
  // DATA region into a position that reads as the start of the next trusted block. Ordinary prose
  // that merely talks ABOUT "reflection summary" or "owner strategy prompt" (no angle brackets)
  // must not fire — requires the literal tag syntax.
  {
    name: "fence-escape",
    re: /<\/?(?:reflection_summary|owner_strategy_prompt)>/i
  }
];

function excerptAround(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + matchLength + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const raw = `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
  if (raw.length <= MAX_EXCERPT_LENGTH) return raw;
  // Over the cap (only reachable via an unbounded match, e.g. base64-instruction-blob): keep a
  // head + tail slice around a middle ellipsis marker instead of truncating one end, so both the
  // start of the match's context and its end stay visible in the receipt.
  const half = Math.floor((MAX_EXCERPT_LENGTH - 5) / 2);
  return `${raw.slice(0, half)} ... ${raw.slice(raw.length - half)}`;
}

/**
 * Scan untrusted prompt fields for instruction-hijack idioms. Pure + deterministic; at most one
 * finding per (field, pattern) pair, capped at MAX_FINDINGS total. NEVER throws on weird input —
 * a scanner crash must not take down a strategy run — and never modifies the scanned text.
 */
export function scanForInjectionAttempts(fields: UntrustedPromptField[]): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const field of fields) {
    if (!field || typeof field.text !== "string" || field.text.length === 0) continue;
    for (const pattern of INJECTION_PATTERNS) {
      if (findings.length >= MAX_FINDINGS) return findings;
      const match = pattern.re.exec(field.text);
      if (!match) continue;
      findings.push({
        name: field.name,
        pattern: pattern.name,
        excerpt: excerptAround(field.text, match.index, match[0].length)
      });
    }
  }
  return findings;
}

// ── Evidence-age anomaly receipts ────────────────────────────────────────────────────────────

/** Evidence younger than this counts as "first seen today" for the age receipt. */
export const EVIDENCE_AGE_FRESH_MS = 24 * 60 * 60 * 1000;
/**
 * A RAG chunk only earns an age receipt when its post-rerank relevance sits MEANINGFULLY above
 * the retrieval floor (floor + this margin) — i.e. the chunk is both brand-new AND likely to
 * actually steer the decision. Low-relevance fresh chunks are routine and not receipt-worthy.
 */
export const EVIDENCE_AGE_HIGH_RELEVANCE_MARGIN = 0.2;
/** Cap on receipt items — one aggregated audit row, not a firehose. */
const MAX_AGE_ANOMALIES = 12;

export interface EvidenceAgeInput {
  kind: "rag_chunk" | "learned_fact";
  id: string;
  /** Compact human label for the receipt, e.g. "AAPL 8-K 2026-07-05" or "NVDA fact:NVDA". */
  label: string;
  /** ISO timestamp: chunk.as_of for RAG, row.assertedAt for learned facts. */
  timestamp?: string;
  /** RAG only: post-rerank relevance (falls back to cosine score at the call site). */
  relevanceScore?: number;
  /** RAG only: the retrieval floor in effect (defaultRelevanceFloor()). */
  relevanceFloor?: number;
}

export interface EvidenceAgeAnomaly {
  kind: "rag_chunk" | "learned_fact";
  id: string;
  label: string;
  ageHours: number;
  relevanceScore?: number;
}

/**
 * Flag evidence dated within EVIDENCE_AGE_FRESH_MS of `now`: every fresh learned fact, and fresh
 * RAG chunks whose relevance clears floor + margin. A future-dated timestamp (|age| < 24h the
 * other way) is treated as fresh too — a clock-skewed "today" is still "today". Unparseable or
 * missing timestamps are skipped (no fabricated ages). Pure; never throws.
 */
export function collectEvidenceAgeAnomalies(items: EvidenceAgeInput[], now: Date = new Date()): EvidenceAgeAnomaly[] {
  const anomalies: EvidenceAgeAnomaly[] = [];
  for (const item of items) {
    if (anomalies.length >= MAX_AGE_ANOMALIES) break;
    if (!item?.timestamp) continue;
    const ts = Date.parse(item.timestamp);
    if (!Number.isFinite(ts)) continue;
    const ageMs = now.getTime() - ts;
    if (Math.abs(ageMs) >= EVIDENCE_AGE_FRESH_MS) continue;
    if (item.kind === "rag_chunk") {
      const floor = typeof item.relevanceFloor === "number" ? item.relevanceFloor : 0.3;
      if (typeof item.relevanceScore !== "number") continue;
      if (item.relevanceScore < floor + EVIDENCE_AGE_HIGH_RELEVANCE_MARGIN) continue;
    }
    anomalies.push({
      kind: item.kind,
      id: item.id,
      label: item.label,
      ageHours: Number(Math.max(0, ageMs / 3_600_000).toFixed(1)),
      ...(typeof item.relevanceScore === "number" ? { relevanceScore: item.relevanceScore } : {})
    });
  }
  return anomalies;
}
