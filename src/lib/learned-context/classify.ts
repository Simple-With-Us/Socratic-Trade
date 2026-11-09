// The single security-critical chokepoint of the crossover-learning loop.
//
// classifyRiskTier maps a learned-context candidate to one of three tiers:
//   - 'fact'              — a durable, non-risk observation safe to surface to the brain as
//                           advisory DATA (e.g. "ASML is the sole EUV-lithography supplier").
//   - 'risk'              — anything that touches position sizing, exposure limits, risk
//                           tolerance, leverage/margin, stops/targets, sector caps, scoring
//                           weights, strategy authority, or risk-adjacent INTENT prose.
//   - 'strategy-directive'— a directive that would rewrite the agent's strategy prompt.
//
// It is FAIL-CLOSED: anything that is not clearly a non-risk fact returns 'risk' (UNKNOWN -> risk).
// In the fact-tier slice the store AUDIT-LOGS-AND-DROPS everything above 'fact', so a conservative
// mis-tier costs at worst a dropped fact, never a silent risk change reaching the brain.
//
// ── Two channels, two guarantees (read before weakening anything below) ─────────────────────────
// DATA channel: a row that survives classification is surfaced to the brain only as an advisory
//   STRING. The PHASE-0 test in test/learned-context.test.ts proves applyDeterministicSizing never
//   READS learned_context — its output is byte-identical with and without rows in the table. That
//   test guards the DATA channel ONLY: it shows no learned row can flow through the sizing math.
// SEMANTIC channel (a KNOWN residual handled OUTSIDE this classifier): a 'fact' that primes the LLM
//   to emit a higher confidenceScore can still enlarge size, because strategy.ts maps
//   conviction = confidenceScore/100 (strategy.ts:633), multiplier = (winRate/100)*conviction*edge
//   (strategy.ts:640) and targetNotional = maxOrderNotional*multiplier (strategy.ts:659). The PHASE-0
//   byte-identical test cannot catch this — it never re-runs the LLM. The evidence floor
//   (strategy.ts:651-653) pins any thesis under minLots closed lots to the sizing floor, so the hole
//   opens only on already-proven theses (a slow-burn anchoring attack, not instant inflation). This
//   classifier MITIGATES the residual only insofar as conviction/certainty/correlation-collapse and
//   stop-manipulation PHRASES now route to 'risk'; the full fix (per-name/per-theme volumetric cap on
//   accumulated facts, or a semantic gate) lives outside the classifier. See the rollout note.

import type { LearnedContextCandidate, LearnedContextRiskTier } from "../types";

// Reused from salience.ts — PII must never be written to learned_context either.
export const PII_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/, /\b(?:\d[ -]?){13,16}\b/];

/**
 * Risk-controlling SUBJECTS. If the candidate's FULL haystack (subject + value + intent, normalized)
 * matches any of these, it is risk-tier regardless of its value. Producers emit `fact:NVDA`-style
 * subjects, so matching only `subject` is a no-op for chat/post-mortem facts AND lets risk vocabulary
 * that lives in the value/intent fields escape (e.g. a knob name like `max_order_notional` mentioned
 * in prose). This is the owner-reviewable DEFAULT set; extend it, never silently weaken it. Matching
 * is substring-based on a normalized haystack so "max_position", "maxPositionPct" and "max position"
 * all hit "max position".
 *
 * SCOPING NOTE (false-positive fatigue — see panel finding `medium`): broad single words that collide
 * with benign company-fundamental prose are deliberately NOT here. Bare "margin" (→ gross/operating
 * margin), bare "cap" (→ market cap / cap-ex), bare "size"/"sizing" (→ deal size), bare "limit"
 * (→ limit order), bare "exposure"/"allocation" (→ "exposure to China", "capital allocation
 * discipline") are scoped to phrases or routed through the co-occurrence gate below instead.
 */
export const RISK_SUBJECTS: readonly string[] = [
  // ── existing knob names ──
  "position sizing",
  "max position",
  "risk tolerance",
  "leverage",
  "sector cap",
  "sector allocation",
  "sector exposure",
  "stop loss",
  "take profit",
  "strategy authority",
  "scoring weight",
  "max order notional",
  "max daily notional",
  "daily limit",
  "percent allocation",
  "% allocation",
  // ── margin scoped to phrases (bare "margin" hits PROFIT margin) ──
  "margin call",
  "on margin",
  "margin requirement",
  "margin account",
  "maintenance margin",
  "margin headroom",
  // ── exposure/allocation scoped to risk-shaped phrases (bare nouns over-match) ──
  "net exposure",
  "gross exposure",
  "factor exposure",
  "increase exposure",
  "reduce exposure",
  "add exposure",
  "cut exposure",
  // ── concentration / portfolio shape ──
  "concentration",
  "position count",
  "max positions",
  "single name",
  "correlation",
  "factor tilt",
  "factor weight",
  "sector tilt",
  "sector rotation",
  "style tilt",
  // ── risk budgets ──
  "drawdown",
  "value at risk",
  "tail risk",
  "volatility target",
  "kelly",
  "beta target",
  "cash level",
  "cash target",
  "fully deployed",
  // ── hedging ──
  "hedge ratio",
  "hedging",
  // ── conviction / edge as sizing inputs ──
  "conviction",
  "win rate",
  "expectancy",
  "thesis weight",
  "signal weight",
  "signal half life",
  // ── order/trade sizing knobs ──
  "notional",
  "order size",
  "trade size",
  "lot size",
  "leverage ratio",
  "reg t",
  // ── horizons / turnover ──
  "holding horizon",
  "turnover",
  "rebalance",
  "exit horizon",
  // ── stops & targets ──
  "trailing stop",
  "price target",
  "buy the dip",
  // ── execution / liquidity risk ──
  "adv",
  "average daily volume",
  "market impact",
  "participation rate",
  "time in force",
  "vwap",
  "twap",
  "slippage",
  "execution cost",
  "cost model",
  // ── day-trading / buying power ──
  "day trading",
  "pdt",
  "buying power",
  // ── short / borrow / locate eligibility ──
  "short locate",
  "locate",
  "borrow",
  "hard to borrow",
  // ── compliance / restricted-list controls ──
  "restricted list",
  "blocked list",
  "compliance hold",
  "trading restriction",
  "suitability",
  "wash sale",
  "short selling enabled"
];

/**
 * Intent KEYWORDS / PHRASES that force 'risk' even with no numeric trigger. These catch risk-adjacent
 * prose (the Safety judge's named failure mode: "lean much harder into tech", "more aggressive") that a
 * subject/numeric check alone would miss. SPECIFIC multi-word idioms are safe as substring matches —
 * they rarely collide with benign company-fundamental prose. Single words here are word-boundary
 * matched against the combined text.
 *
 * Deliberately EXCLUDED (panel finding `medium`, false-positive fatigue): bare "margin", "cap", "size",
 * "limit" (scoped to phrases / handled in RISK_SUBJECTS), and the bare directional verbs
 * lower/raise/increase/decrease (routed through the AMBIGUOUS_DIRECTIONAL co-occurrence gate below so
 * "raised guidance" / "revenue increased" do not force risk on their own).
 */
export const RISK_INTENT_KEYWORDS: readonly string[] = [
  // ── original idioms ──
  "lean harder",
  "lean much harder",
  "lean into",
  "double down",
  "overweight",
  "underweight",
  "aggressive",
  "aggressively",
  "conservative",
  "conservatively",
  "leverage",
  "leveraged",
  // ── sizing / concentration intent ──
  "concentrate",
  "concentrated",
  "concentrate into",
  "diversify",
  "deploy",
  "high conviction",
  "very high conviction",
  "elevated conviction",
  "low conviction",
  "tilt toward",
  "skew toward",
  "must own",
  "add to winners",
  "keep adding",
  "back up the truck",
  "load the boat",
  "load up",
  "pile in",
  "press the trade",
  "full send",
  "go all in",
  "all-in",
  "max out",
  "let it ride",
  "let winners run",
  "swing for the fences",
  "bet big",
  "go heavy",
  "upsize",
  "size up",
  "outsized",
  "pyramid",
  "comfortable with bigger swings",
  "willing to stomach",
  // ── certainty / over-confidence (semantic-channel conviction priming) ──
  "sure thing",
  "near certainty",
  "guaranteed",
  "risk-free",
  "cant lose",
  "cannot lose",
  "no downside",
  "bulletproof",
  "safe bet",
  "no-brainer",
  "free money",
  "easy money",
  "always pops",
  "never fails",
  "never draws down",
  // ── de-risking intent (still a risk-control change) ──
  "scale back",
  "pare down",
  "scale in",
  "scale out",
  "play it safe",
  "stay small",
  "lock in gains",
  // ── stop manipulation ──
  "trim the hedge",
  "drop the hedge",
  "remove the stop",
  "widen the stop",
  "loosen the stop",
  "pull the stop",
  "give it room",
  "room to breathe",
  "without a stop",
  "take chips off",
  // ── correlation collapse / interchangeability ──
  "treat them as one position",
  "effectively one position",
  "interchangeable",
  // ── short / borrow / restricted eligibility prose ──
  "no locate",
  "not restricted",
  "eligible to trade",
  "wash sale expired",
  "wash sale safe",
  "ample buying power",
  // ── execution sizing idioms ──
  "3x the usual",
  "usual clip"
];

/**
 * AMBIGUOUS directional verbs. Bare lower/raise/increase/decrease are ubiquitous in macro/fundamental
 * prose ("rates lower", "raised guidance", "revenue increased"), so on their own they must NOT force
 * risk. They fire ONLY when they CO-OCCUR with a risk subject OR a numeric trigger in the same
 * haystack (panel finding `medium`). The same gate scopes the otherwise-over-matching bare nouns
 * "exposure" / "allocation".
 */
const AMBIGUOUS_DIRECTIONAL: readonly string[] = [
  "increase",
  "decrease",
  "raise",
  "lower",
  "exposure",
  "allocation",
  "allocate"
];

function normalizeSubject(subject: string): string {
  return subject.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A numeric size/limit/percent reference implies a risk knob. Applied to the FULL haystack (a numeric
 * in the intent field alone used to bypass this). ONE-or-more digits (single-digit counts like
 * "3x the usual clip" used to escape). Units recognized: percent, dollars, bps/basis points, N:1
 * ratios, Nx / N times / N× multipliers, ADV/ADTV ratios, and bare counts before shares|lots|clip.
 * Plain 4-digit years (1900-2099) are NOT treated as a risk numeric on their own; if a year sits next
 * to a real unit the unit still fires (fail-closed — gating a number is safe).
 */
const NUMERIC_RISK_PATTERN = new RegExp(
  [
    "\\d+(?:\\.\\d+)?\\s*%", // 5% / 12.5%
    "\\bpercent\\b",
    "\\$\\s*\\d", // $10,000
    "\\d+(?:\\.\\d+)?\\s*(?:bps|basis\\s*points?)", // 25 bps
    "\\d+(?:\\.\\d+)?\\s*:\\s*1\\b", // 3:1 ratio
    "\\d+(?:\\.\\d+)?\\s*(?:x|×)\\b", // 3x / 3×
    "\\d+(?:\\.\\d+)?\\s*times\\b", // 3 times
    "\\d+(?:\\.\\d+)?\\s*(?:adv|adtv)\\b", // 2 ADV
    "\\d+\\s*(?:shares?|lots?|clips?)\\b" // 500 shares / 3 lots / 3 clip
  ].join("|"),
  "i"
);

/**
 * Cue-anchored numeric catch: a number that reads as a SIZE/COEFFICIENT magnitude even without a unit
 * — e.g. "coefficient closer to 15", "run it as half the book". This is deliberately NOT a bare
 * "any 2+ digit number" test: a date/ordinal/count in a benign fact ("reports earnings on the 20th",
 * "the CEO of 30 years") must stay a fact. We only fire when a number sits next to a sizing/coefficient
 * cue word, so the signal is "this number tunes a knob", not "a number appears". Fail-closed elsewhere
 * is provided by the unit-bearing NUMERIC_RISK_PATTERN above.
 */
function hasCueNumeric(haystack: string): boolean {
  const cue = "coefficient|multiple|multiplier|the book|the position|the clip|book size|position size";
  return (
    new RegExp(`(?:${cue})[^.]{0,20}?\\d+(?:\\.\\d+)?`, "i").test(haystack) ||
    new RegExp(`\\d+(?:\\.\\d+)?[^.]{0,20}?(?:${cue})`, "i").test(haystack) ||
    /(?:closer\s+to|treated\s+as|run\s+it\s+as)\s+(?:much\s+)?(?:higher|lower|bigger)?\s*\d+(?:\.\d+)?/i.test(
      haystack
    )
  );
}

/**
 * Short single-token subjects that are real ENGLISH-word substrings of benign prose ("adv" ⊂
 * "advisory"/"advance"/"advantage", "notional" ⊂ harmless but boundary-safe, plus the acronyms
 * "pdt"/"vwap"/"twap"/"reg t" and the short verbs "borrow"/"locate"/"kelly"). These must be
 * WORD-BOUNDARY matched on the spaced haystack, never substring-matched — otherwise they false-gate
 * fundamentals. (Longer multi-word subjects like "value at risk"/"beta target" stay substring-safe.)
 */
const BOUNDARY_ONLY_SUBJECTS = new Set([
  "adv",
  "pdt",
  "borrow",
  "locate",
  "kelly",
  "vwap",
  "twap",
  "reg t",
  "notional"
]);

function matchesRiskSubject(haystack: string, haystackCondensed: string): boolean {
  return RISK_SUBJECTS.some((s) => {
    const sn = normalizeSubject(s);
    if (BOUNDARY_ONLY_SUBJECTS.has(sn)) {
      const escaped = sn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
    }
    return haystack.includes(sn) || haystackCondensed.includes(sn.replace(/\s+/g, ""));
  });
}

export function classifyRiskTier(candidate: LearnedContextCandidate): LearnedContextRiskTier {
  const subject = normalizeSubject(candidate.subject ?? "");
  const value = String(candidate.value ?? "");
  const intent = String(candidate.intent ?? "");
  // FULL haystack (subject + value + intent), normalized the same way as a subject so "max_order"
  // and "max order" collapse identically wherever they appear.
  const haystack = normalizeSubject(`${subject} ${value.toLowerCase()} ${intent.toLowerCase()}`);
  // Space-stripped variant so camelCase knob names ("strategyAuthority", "scoringWeight") and
  // run-together producers ("maxOrderNotional") still hit multi-word subjects.
  const haystackCondensed = haystack.replace(/\s+/g, "");

  // 1. A known risk-controlling knob/term anywhere in the haystack → risk.
  if (matchesRiskSubject(haystack, haystackCondensed)) {
    return "risk";
  }

  // 2. Risk-adjacent INTENT prose (idioms / certainty / stop-manipulation) → risk (no-numeric hole).
  if (
    RISK_INTENT_KEYWORDS.some((kw) => {
      // Multi-word phrases: substring; single words: word-boundary so "limited" != "limit".
      if (kw.includes(" ")) return haystack.includes(kw);
      // Escape regex-special chars (e.g. the hyphen in "all-in") before boundary-matching.
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
    })
  ) {
    return "risk";
  }

  // 3. Any numeric size/limit/percent reference anywhere → risk (a learned "5%"/"3x" tunes a knob).
  if (NUMERIC_RISK_PATTERN.test(haystack) || hasCueNumeric(haystack)) {
    return "risk";
  }

  // 4. Ambiguous directional verbs / bare exposure-allocation: fire ONLY with a co-occurring risk
  //    subject or numeric (already returned above if present), so a lone "raised guidance" /
  //    "revenue increased" / "exposure to China" stays a fact. By the time we reach here, no risk
  //    subject and no numeric matched — so a bare directional verb with NOTHING else is a fact.
  //    (The co-occurrence partner — risk subject or numeric — would have returned 'risk' in steps
  //    1/3 already; this branch documents the intent and guards against a future reorder.)
  const directionalHit = AMBIGUOUS_DIRECTIONAL.some((kw) =>
    new RegExp(`\\b${kw}\\b`, "i").test(haystack)
  );
  if (directionalHit) {
    const corroborated =
      matchesRiskSubject(haystack, haystackCondensed) ||
      NUMERIC_RISK_PATTERN.test(haystack) ||
      hasCueNumeric(haystack);
    if (corroborated) return "risk";
  }

  // 5. Otherwise it is a clean, non-risk fact. (Producers are responsible for emitting durable
  //    facts/patterns; the fact tier is the only thing this slice ever writes to the brain.)
  return "fact";
}

/** PII gate: true if the candidate's value carries an SSN/card-like number and must be dropped. */
export function hasPii(value: string): boolean {
  return PII_PATTERNS.some((re) => re.test(String(value)));
}
