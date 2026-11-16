// prompt-safety.ts — deterministic, ADVISORY-ONLY receipts for the money-path prompts.
//
// Four pure scanners/primitives live here (CR-H prompt-safety lane, 2026-07-05; corpus-coverage-receipt,
// 2026-07-06):
//   1. scanForInjectionAttempts — a small, curated regex sweep over the UNTRUSTED text blocks
//      that get assembled into the Bull/Bear prompts (headlines, smart-money bulletins, RAG
//      snippets, learned facts, episodic blocks, the owner strategy prompt incl. its AI-LEARNED
//      appends, and the reflection summary).
//   2. collectEvidenceAgeAnomalies — flags evidence that is suspiciously FRESH (first seen <24h
//      before the run): a high-relevance RAG chunk dated today, or a learned fact asserted today.
//   3. computeEmptyDocTypes — flags a COVERAGE-CHECKED filings doc type (a static allowlist of
//      types whose PRODUCER LEDGER IS COMPLETE — see coverageCheckedFilingsDocTypes in strategy.ts)
//      that is BOTH not retrieved this run AND has zero ever-ingested producer rows. "8-k" remains
//      excluded because its default-on writer does not record a producer row. Earnings transcripts
//      join the allowlist only while their default-off FMP producer is explicitly enabled.
//   4. containPromptText — classifies a source as owner-authored instructions or untrusted data,
//      then deterministically quarantines only instruction-like spans from untrusted data.
//
// OWNER PHILOSOPHY (binding): detection and narrow containment are the controls. Findings become
// audit rows and decision-case evidence items. Trusted owner strategy text is never altered;
// instruction-like spans in untrusted data are replaced with explicit quarantine markers and the
// removed excerpts are retained only in bounded receipts. Generation always proceeds.
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
/** Work cap for the containment primitive. The result makes truncation explicit. */
export const MAX_PROMPT_CONTAINMENT_INPUT_LENGTH = 32_000;
/** Max quarantined spans from one input; enough for review without becoming a forensic dump. */
const MAX_CONTAINMENT_FINDINGS = 12;
/** A malformed unpunctuated input may not cause an unbounded span removal. */
const MAX_INSTRUCTION_SPAN_LENGTH = 2_048;

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
 * NFKC catches practical, width/spacing-based evasions (for example `ｓｙｓｔｅｍ：`). We only
 * use it when UTF-16 offsets stay aligned, so every resulting span can safely index the original
 * source text. The raw source is never normalized or otherwise rewritten by detection.
 */
function normalizeForDetection(text: string): string {
  const normalized = text.normalize("NFKC");
  return normalized.length === text.length ? normalized : text;
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
    const detectionText = normalizeForDetection(field.text);
    for (const pattern of INJECTION_PATTERNS) {
      if (findings.length >= MAX_FINDINGS) return findings;
      const match = pattern.re.exec(detectionText);
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

// ── Prompt-injection containment ────────────────────────────────────────────────────────────

/** Source trust is deliberately a property of the source label, not source text. */
export type PromptSourceTrust = "trusted_owner" | "untrusted_data";

/**
 * `owner_strategy` is intentionally the only trusted source. In particular, reflection, coach,
 * learned, RAG, news, and web content remain data even when they were originally authored by an
 * owner or an LLM: they can contain relayed or persistent untrusted material.
 *
 * `web` labels text the app fetched from an arbitrary host (a coach-pasted article URL). It is
 * the most attacker-controllable source family in the app, which is why it is scanned at INGEST —
 * before anything durable is written — and not only at prompt-assembly read time.
 */
export type PromptTextSource =
  | "owner_strategy"
  | "rag"
  | "news"
  | "web"
  | "learned"
  | "reflection"
  | "coach"
  | "unknown";

export interface PromptContainmentInput {
  /** Source family, not a user-controlled claim embedded in the source text. */
  source: PromptTextSource | string;
  text: string;
}

export type PromptContainmentStatus =
  | "trusted"
  | "clean"
  | "quarantined"
  | "truncated"
  | "quarantined_truncated";

export interface PromptContainmentFinding {
  /** Curated detector id, stable across regex tuning. */
  pattern: string;
  /** UTF-16 offsets into the original source text. */
  start: number;
  end: number;
  /** Bounded source excerpt for review; never placed in sanitizedText. */
  excerpt: string;
}

export interface QuarantinedPromptExcerpt extends PromptContainmentFinding {
  /** The deterministic marker substituted into sanitizedText. */
  replacement: string;
}

export interface PromptContainmentResult {
  source: string;
  trust: PromptSourceTrust;
  status: PromptContainmentStatus;
  /** True only when untrusted input exceeded MAX_PROMPT_CONTAINMENT_INPUT_LENGTH. */
  truncated: boolean;
  findings: PromptContainmentFinding[];
  /** Safe-to-compose data text. Quarantined spans become explicit non-instruction markers. */
  sanitizedText: string;
  quarantinedExcerpts: QuarantinedPromptExcerpt[];
}

const TRUSTED_OWNER_SOURCES = new Set(["owner_strategy"]);

/** Unknown labels fail closed into the data tier; only the canonical owner strategy is trusted. */
export function classifyPromptSourceTrust(source: PromptTextSource | string): PromptSourceTrust {
  return TRUSTED_OWNER_SOURCES.has(String(source).trim().toLowerCase()) ? "trusted_owner" : "untrusted_data";
}

interface InstructionMatch {
  pattern: string;
  start: number;
  end: number;
}

function clampExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_EXCERPT_LENGTH) return compact;
  const half = Math.floor((MAX_EXCERPT_LENGTH - 5) / 2);
  return `${compact.slice(0, half)} ... ${compact.slice(compact.length - half)}`;
}

function expandInstructionSpan(text: string, match: InstructionMatch): InstructionMatch {
  // A blob is already the suspicious payload. Expanding it would hide nearby filing prose.
  if (match.pattern === "base64-instruction-blob") return match;

  const minimumStart = Math.max(0, match.start - MAX_INSTRUCTION_SPAN_LENGTH);
  const before = text.slice(minimumStart, match.start);
  const previousBoundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"));
  let start = previousBoundary >= 0 ? minimumStart + previousBoundary + 1 : minimumStart;
  while (start < match.start && /\s/.test(text[start]!)) start += 1;

  const after = text.slice(match.end, match.end + MAX_INSTRUCTION_SPAN_LENGTH);
  const nextBoundary = after.search(/[.!?\n]/);
  const end = nextBoundary >= 0 ? match.end + nextBoundary + 1 : Math.min(text.length, match.end + MAX_INSTRUCTION_SPAN_LENGTH);
  return { ...match, start, end };
}

function findInstructionSpans(text: string): InstructionMatch[] {
  const detectionText = normalizeForDetection(text);
  const matches: InstructionMatch[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const flags = pattern.re.flags.includes("g") ? pattern.re.flags : `${pattern.re.flags}g`;
    const re = new RegExp(pattern.re.source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(detectionText)) !== null) {
      matches.push(expandInstructionSpan(text, { pattern: pattern.name, start: match.index, end: match.index + match[0].length }));
      if (matches.length >= MAX_CONTAINMENT_FINDINGS * 3) break;
      if (match[0].length === 0) re.lastIndex += 1;
    }
    if (matches.length >= MAX_CONTAINMENT_FINDINGS * 3) break;
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end || a.pattern.localeCompare(b.pattern));
  const nonOverlapping: InstructionMatch[] = [];
  for (const match of matches) {
    const previous = nonOverlapping.at(-1);
    if (previous && match.start < previous.end) continue;
    nonOverlapping.push(match);
    if (nonOverlapping.length >= MAX_CONTAINMENT_FINDINGS) break;
  }
  return nonOverlapping;
}

function quarantineReplacement(pattern: string): string {
  return `[QUARANTINED_INSTRUCTION_LIKE_DATA:${pattern}]`;
}

/**
 * Deterministically separate untrusted source data from instruction-like spans without silently
 * discarding it: removed spans are represented in `sanitizedText` and returned as bounded,
 * reviewable excerpts. This is a composition primitive, not an execution gate. Trusted owner
 * strategy text is returned byte-for-byte unchanged and is never scanned, truncated, or mutated.
 */
export function containPromptText(input: PromptContainmentInput): PromptContainmentResult {
  const source = typeof input?.source === "string" ? input.source : "unknown";
  const text = typeof input?.text === "string" ? input.text : "";
  const trust = classifyPromptSourceTrust(source);
  if (trust === "trusted_owner") {
    return { source, trust, status: "trusted", truncated: false, findings: [], sanitizedText: text, quarantinedExcerpts: [] };
  }

  const truncated = text.length > MAX_PROMPT_CONTAINMENT_INPUT_LENGTH;
  const boundedText = truncated ? text.slice(0, MAX_PROMPT_CONTAINMENT_INPUT_LENGTH) : text;
  const spans = findInstructionSpans(boundedText);
  const quarantinedExcerpts = spans.map((span) => {
    const replacement = quarantineReplacement(span.pattern);
    return { ...span, excerpt: clampExcerpt(boundedText.slice(span.start, span.end)), replacement };
  });

  let sanitizedText = "";
  let cursor = 0;
  for (const quarantined of quarantinedExcerpts) {
    sanitizedText += boundedText.slice(cursor, quarantined.start);
    sanitizedText += quarantined.replacement;
    cursor = quarantined.end;
  }
  sanitizedText += boundedText.slice(cursor);
  if (truncated) sanitizedText += "\n[INPUT_TRUNCATED: untrusted source data exceeded containment limit]";

  const status: PromptContainmentStatus = quarantinedExcerpts.length > 0
    ? truncated ? "quarantined_truncated" : "quarantined"
    : truncated ? "truncated" : "clean";
  return {
    source,
    trust,
    status,
    truncated,
    findings: quarantinedExcerpts.map(({ pattern, start, end, excerpt }) => ({ pattern, start, end, excerpt })),
    sanitizedText,
    quarantinedExcerpts
  };
}

export interface PromptDataContainmentReceipt {
  path: string;
  result: PromptContainmentResult;
}

/** Recursively contain instruction-like strings inside a structured data payload. */
export function containPromptDataTree(
  value: unknown,
  source: PromptTextSource | string = "unknown",
  path = "data",
  depth = 0
): { value: unknown; receipts: PromptDataContainmentReceipt[] } {
  if (typeof value === "string") {
    const result = containPromptText({ source, text: value });
    return {
      value: result.sanitizedText,
      receipts: result.status === "clean" || result.status === "trusted" ? [] : [{ path, result }]
    };
  }
  if (depth >= 8 || value === null || typeof value !== "object") return { value, receipts: [] };
  if (Array.isArray(value)) {
    const receipts: PromptDataContainmentReceipt[] = [];
    const contained = value.map((item, index) => {
      const result = containPromptDataTree(item, source, `${path}[${index}]`, depth + 1);
      receipts.push(...result.receipts);
      return result.value;
    });
    return { value: contained, receipts };
  }
  const receipts: PromptDataContainmentReceipt[] = [];
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const result = containPromptDataTree(item, source, `${path}.${key}`, depth + 1);
    receipts.push(...result.receipts);
    return [key, result.value] as const;
  });
  return { value: Object.fromEntries(entries), receipts };
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
  /** rag_chunk / learned_fact as of #816; headline first-seen added #837. */
  kind: "rag_chunk" | "learned_fact" | "headline";
  id: string;
  /** Compact human label for the receipt, e.g. "AAPL 8-K 2026-07-05" or "NVDA fact:NVDA". */
  label: string;
  /** ISO timestamp: chunk.as_of for RAG, row.assertedAt for learned facts, first-seen for headlines. */
  timestamp?: string;
  /** RAG only: post-rerank relevance (falls back to cosine score at the call site). */
  relevanceScore?: number;
  /** RAG only: the retrieval floor in effect (defaultRelevanceFloor()). */
  relevanceFloor?: number;
}

export interface EvidenceAgeAnomaly {
  kind: "rag_chunk" | "learned_fact" | "headline";
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

/**
 * Corpus-coverage receipt (corpus-coverage-receipt, 2026-07-06; corrected twice same day — see
 * docs/rollouts/2026-07-06-corpus-coverage-receipt.md for the full history). A coverage-checked
 * filings doc type counts as "empty" for this run only when BOTH:
 *   (a) zero chunks of that doc type were retrieved THIS run, AND
 *   (b) `hasProducerForDocType` reports zero ever-ingested producer rows for it.
 *
 * Both conditions are load-bearing. Condition (a) alone is too noisy: an event-sparse type
 * (originally 8-K) can legitimately fail to rank in a normal run's top-3 chunks even though the
 * corpus holds real coverage for it — firing on (a) alone would make the receipt noise on a large
 * fraction of ordinary runs. Condition (b) alone would never fire (a type can rank low every run
 * forever while still having historical producer rows). Together, the receipt only fires for the
 * genuinely useful signal: "this account/corpus has never once produced this doc type" — not
 * "didn't rank today."
 *
 * `coverageCheckedDocTypes` (the caller's `COVERAGE_CHECKED_DOC_TYPES` in strategy.ts) MUST be
 * restricted to doc types whose producer ledger is actually COMPLETE (every writer for that type
 * records a producer row) — see that constant's comment. `hasProducerForDocType` is intentionally
 * a plain predicate (not a DB call) so this module stays a DB-free leaf; the caller is responsible
 * for building it (e.g. from one bulk `ingestedAccessionCountsByDocType()` query) and keeping the
 * DB dependency in strategy.ts.
 *
 * Pure; DB-free.
 */
export function computeEmptyDocTypes(
  coverageCheckedDocTypes: string[],
  retrievedDocTypes: Iterable<string | undefined>,
  hasProducerForDocType: (docType: string) => boolean
): string[] {
  const retrieved = new Set<string>();
  for (const dt of retrievedDocTypes) {
    if (dt) retrieved.add(dt.toLowerCase());
  }
  const empty: string[] = [];
  for (const requested of coverageCheckedDocTypes) {
    const normalized = requested.toLowerCase();
    if (retrieved.has(normalized)) continue;
    if (hasProducerForDocType(requested)) continue;
    empty.push(requested);
  }
  return empty;
}
