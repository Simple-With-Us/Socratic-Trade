// "Deciding what to remember" — the salience-gated write policy from Atlas Deep Dive 12.
// In production the extractor would be a cheap structured-output LLM call; this is the
// deterministic rule-based stand-in so the policy is testable offline. Pure (no DB).
// Ported from reference/atlas-public-src/bff/memory/salience.mjs.

import type { LearnedContextCandidate, MemoryCandidate, MemoryDecision, MemoryKind } from "../types";

// Durability by kind (constraints are permanent; one-offs never persist).
const DUR: Record<string, number> = {
  constraint: 1.0,
  correction: 1.0,
  preference: 0.8,
  goal: 0.6,
  pattern: 0.5,
  decision: 0.9,
  oneoff: 0.0
};
const SRC: Record<string, number> = { user_stated: 1.0, confirmed_action: 0.9, inferred: 0.5 };

// PII we should never extract into free-text memory.
const PII_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/, /\b(?:\d[ -]?){13,16}\b/];

/** Rule-based candidate extraction — mirrors the structured output an LLM extractor would emit. */
export function extractCandidates(message: string): MemoryCandidate[] {
  const text = String(message);
  const lc = text.toLowerCase();
  const out: MemoryCandidate[] = [];

  const add = (c: {
    kind: MemoryKind;
    subject: string;
    value: string;
    hard?: boolean;
    specificity?: number;
    confidence?: number;
    source?: string;
  }) => out.push({ source: "user_stated", confidence: 0.9, hard: false, specificity: 0.7, pii: false, ...c });

  // Hard constraints
  if (/\bno (options|derivatives)\b/.test(lc) || /\bnever (trade|buy) options\b/.test(lc))
    add({ kind: "constraint", subject: "no_options", value: "No options/derivatives", hard: true, specificity: 0.9 });
  if (/\b(no|never|avoid)\b[\w\s]{0,15}\b(leverage|margin|leveraged)\b/.test(lc))
    add({ kind: "constraint", subject: "no_leverage", value: "No leverage/margin", hard: true, specificity: 0.9 });
  if (/\b(esg|sustainab|no (fossil|tobacco|defense))\b/.test(lc))
    add({ kind: "constraint", subject: "esg", value: "ESG preferences stated", hard: true, specificity: 0.6 });
  const maxPos = lc.match(/max(?:imum)?\s+(?:position|single name)[^\d]*(\d+)\s*%/);
  if (maxPos) add({ kind: "constraint", subject: "max_position_pct", value: `${maxPos[1]}%`, hard: true, specificity: 0.95 });

  // Preferences
  const risk = lc.match(
    /\b(conservative|moderate|aggressive)\b.*\b(risk|tolerance)\b|\brisk (tolerance|appetite)\b.*\b(conservative|moderate|aggressive)\b/
  );
  if (risk) {
    const level = (lc.match(/\b(conservative|moderate|aggressive)\b/) || [])[1];
    add({ kind: "preference", subject: "risk_tolerance", value: level || "stated", specificity: 0.8 });
  }
  const horizon = lc.match(/\b(\d{1,2})\s*\+?\s*(year|yr)s?\b/);
  if (horizon || /\b(retirement|long[- ]?term|long horizon)\b/.test(lc))
    add({ kind: "preference", subject: "horizon", value: horizon ? `${horizon[1]}y` : "long", specificity: 0.7 });
  if (/\b(dividend|income|large[- ]?cap|growth|semis?|semiconductor|tech)\b/.test(lc)) {
    const m = lc.match(/\b(dividend|income|large[- ]?cap|growth|semiconductors?|semis?|tech)\b/g) ?? [];
    add({ kind: "preference", subject: "style", value: [...new Set(m)].join(", "), specificity: 0.6, confidence: 0.75 });
  }

  // Goals (event-bounded)
  if (/\b(buy(ing)? a (house|home)|down ?payment|need (the )?(liquidity|cash))\b/.test(lc))
    add({ kind: "goal", subject: "liquidity_need", value: "Near-term liquidity goal", specificity: 0.6, confidence: 0.7 });

  // Corrections (supersede high-confidence)
  if (/\b(no,? i meant|actually,? i meant|correction|that's wrong)\b/.test(lc))
    add({ kind: "correction", subject: "correction", value: text.slice(0, 120), specificity: 0.9, confidence: 0.95 });

  // PII gate
  for (const c of out) c.pii = PII_PATTERNS.some((re) => re.test(c.value));
  return out;
}

// A ticker-like token (1–5 uppercase letters) used to attach a learned fact to a symbol.
const TICKER_RE = /\b([A-Z]{1,5})\b/g;

// Cheap, pure (no DB) first-pass complement: common uppercase words/acronyms that are NOT tickers
// but match TICKER_RE's shape (1-5 uppercase letters) and would otherwise mis-bind a learned fact
// to a fake symbol. This is deliberately small/conservative — it does not replace a real
// known-universe validator (see salience-llm.ts's injected validateSymbol), just filters the most
// common false positives so the pure regex path is safer even with no validator injected.
const TICKER_STOPWORDS = new Set([
  "I", "A", "CEO", "CFO", "COO", "CTO", "ESG", "USA", "EPS", "ETF", "IPO", "AI", "US", "UK", "EU",
  "GDP", "FOMC", "FED", "SEC", "IRS", "CPI", "PPI", "GAAP", "IFRS", "YOY", "QOQ"
]);

/**
 * Pick the first ticker-shaped token from `text` that passes validation, using `matchAll` (not the
 * first-match-only `text.match` this replaced) — a sentence like "NVDA is the sole supplier, not
 * AMD or INTC" must not mis-bind to whichever CAPS token happens to appear first if that token
 * fails validation (e.g. a leading "I" or "CEO"). `validate` is injected so this stays pure/DB-free:
 * callers needing real known-universe validation (salience-llm.ts) pass a stricter predicate;
 * omitting it applies only the built-in stopword denylist.
 */
export function firstValidTicker(text: string, validate?: (candidate: string) => boolean): string | null {
  for (const match of text.matchAll(TICKER_RE)) {
    const candidate = match[1];
    if (!candidate || TICKER_STOPWORDS.has(candidate)) continue;
    if (validate && !validate(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Extract durable learned-FACT candidates (the dormant `pattern`/`decision` salience kinds) from a
 * chat message. These do NOT go to user_memory — the orchestrator routes them through
 * ingestLearned, where the fail-closed classifier decides whether each is a safe fact or a
 * risk-adjacent candidate to drop. We therefore extract liberally here and let classify.ts gate:
 * the raw phrase is carried as `intent` so risk-adjacent prose ("lean harder into tech") is caught.
 *
 * `pattern`  — a recurring, symbol-specific behavioral observation (e.g. post-earnings drift).
 * `decision` — a durable named fact / stable truth about a name or the market structure.
 *
 * `validateSymbol` is an optional injected predicate for stricter (e.g. real known-universe)
 * ticker validation — kept optional/injected so this module never imports a DB. Omitting it still
 * applies the built-in stopword denylist (firstValidTicker's default behavior).
 */
export function extractLearnedCandidates(
  message: string,
  validateSymbol?: (candidate: string) => boolean
): LearnedContextCandidate[] {
  const text = String(message);
  const lc = text.toLowerCase();
  const out: LearnedContextCandidate[] = [];
  const symbol = firstValidTicker(text, validateSymbol);

  // Pattern: an explicitly stated recurring/behavioral observation worth remembering.
  if (/\b(always|usually|tends? to|historically|every time|seasonal|pattern|typically|drifts?|fades?)\b/.test(lc)) {
    out.push({
      kind: "pattern",
      subject: symbol ? `pattern:${symbol}` : "pattern",
      value: text.slice(0, 200),
      symbol,
      source: "user_stated",
      confidence: 0.6,
      intent: lc
    });
  }

  // Decision/fact: a durable named fact ("X is the sole supplier of Y", "the only", "is the").
  if (/\b(is the (sole|only|largest|dominant|leading)|sole supplier|only supplier|monopol|fact:)\b/.test(lc)) {
    out.push({
      kind: "decision",
      subject: symbol ? `fact:${symbol}` : "fact",
      value: text.slice(0, 200),
      symbol,
      source: "user_stated",
      confidence: 0.7,
      intent: lc
    });
  }

  return out;
}

/** Salience score in [0,1]. PII is a hard GATE, not a weighted term. */
export function score(candidate: MemoryCandidate, existing: { value: string } | null = null): { score: number; decision: MemoryDecision } {
  if (candidate.pii) return { score: 0, decision: "SKIP" };
  const durability = DUR[candidate.kind] ?? 0;
  const specificity = candidate.specificity ?? 0.5;
  const confidence = candidate.confidence ?? 0.5;
  const source = SRC[candidate.source] ?? 0.5;
  const refines = existing && existing.value !== candidate.value ? 1 : 0;
  const recency = 1.0;
  let s = (0.3 * durability + 0.2 * specificity + 0.2 * confidence + 0.15 * source + 0.15 * refines) * recency;
  s = Number(s.toFixed(4));
  const decision: MemoryDecision = s >= 0.7 ? "WRITE" : s >= 0.45 ? "HOLD" : "SKIP";
  return { score: s, decision };
}
