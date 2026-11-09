// apps/bff/src/memory/salience.mjs
// "Deciding what to remember" — the salience-gated write policy from Deep Dive 12.
// In production the extractor is a cheap Haiku structured-output call; here it is a
// deterministic rule-based stand-in so the policy is testable offline.

// Durability by kind (constraints are permanent; one-offs never persist).
const DUR = { constraint: 1.0, correction: 1.0, preference: 0.8, goal: 0.6, pattern: 0.5, decision: 0.9, oneoff: 0.0 };
const SRC = { user_stated: 1.0, confirmed_action: 0.9, inferred: 0.5 };

// PII we should never extract into free-text memory unless a feature requires it.
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(?:\d[ -]?){13,16}\b/, // card-ish
];

/**
 * Rule-based candidate extraction. Returns [{kind, subject, value, source, confidence, hard, specificity, pii}].
 * Mirrors the structured-output an LLM extractor would emit.
 */
export function extractCandidates(message) {
  const text = String(message);
  const lc = text.toLowerCase();
  const out = [];

  const add = (c) => out.push({ confidence: 0.9, hard: false, specificity: 0.7, pii: false, source: 'user_stated', ...c });

  // Hard constraints
  if (/\bno (options|derivatives)\b/.test(lc) || /\bnever (trade|buy) options\b/.test(lc))
    add({ kind: 'constraint', subject: 'no_options', value: 'No options/derivatives', hard: true, specificity: 0.9 });
  if (/\b(no|never|avoid)\b[\w\s]{0,15}\b(leverage|margin|leveraged)\b/.test(lc))
    add({ kind: 'constraint', subject: 'no_leverage', value: 'No leverage/margin', hard: true, specificity: 0.9 });
  if (/\b(esg|sustainab|no (fossil|tobacco|defense))\b/.test(lc))
    add({ kind: 'constraint', subject: 'esg', value: 'ESG preferences stated', hard: true, specificity: 0.6 });
  const maxPos = lc.match(/max(?:imum)?\s+(?:position|single name)[^\d]*(\d+)\s*%/);
  if (maxPos) add({ kind: 'constraint', subject: 'max_position_pct', value: `${maxPos[1]}%`, hard: true, specificity: 0.95 });

  // Preferences
  const risk = lc.match(/\b(conservative|moderate|aggressive)\b.*\b(risk|tolerance)\b|\brisk (tolerance|appetite)\b.*\b(conservative|moderate|aggressive)\b/);
  if (risk) {
    const level = (lc.match(/\b(conservative|moderate|aggressive)\b/) || [])[1];
    add({ kind: 'preference', subject: 'risk_tolerance', value: level || 'stated', specificity: 0.8 });
  }
  const horizon = lc.match(/\b(\d{1,2})\s*\+?\s*(year|yr)s?\b/);
  if (horizon || /\b(retirement|long[- ]?term|long horizon)\b/.test(lc))
    add({ kind: 'preference', subject: 'horizon', value: horizon ? `${horizon[1]}y` : 'long', specificity: 0.7 });
  if (/\b(dividend|income|large[- ]?cap|growth|semis?|semiconductor|tech)\b/.test(lc)) {
    const m = lc.match(/\b(dividend|income|large[- ]?cap|growth|semiconductors?|semis?|tech)\b/g);
    add({ kind: 'preference', subject: 'style', value: [...new Set(m)].join(', '), specificity: 0.6, confidence: 0.75 });
  }

  // Goals (event-bounded)
  if (/\b(buy(ing)? a (house|home)|down ?payment|need (the )?(liquidity|cash))\b/.test(lc))
    add({ kind: 'goal', subject: 'liquidity_need', value: 'Near-term liquidity goal', specificity: 0.6, confidence: 0.7 });

  // Corrections (supersede high-confidence)
  if (/\b(no,? i meant|actually,? i meant|correction|that's wrong)\b/.test(lc))
    add({ kind: 'correction', subject: 'correction', value: text.slice(0, 120), specificity: 0.9, confidence: 0.95 });

  // PII gate
  for (const c of out) c.pii = PII_PATTERNS.some((re) => re.test(c.value));
  return out;
}

/**
 * Salience score in [0,1]. PII is a GATE, not a weighted term.
 * @returns {{score:number, decision:'WRITE'|'HOLD'|'SKIP'}}
 */
export function score(candidate, existing = null) {
  if (candidate.pii) return { score: 0, decision: 'SKIP' };
  const durability = DUR[candidate.kind] ?? 0;
  const specificity = candidate.specificity ?? 0.5;
  const confidence = candidate.confidence ?? 0.5;
  const source = SRC[candidate.source] ?? 0.5;
  const refines = existing && existing.value !== candidate.value ? 1 : 0;
  const recency = 1.0;
  let s = (0.30 * durability + 0.20 * specificity + 0.20 * confidence + 0.15 * source + 0.15 * refines) * recency;
  s = +s.toFixed(4);
  const decision = s >= 0.7 ? 'WRITE' : s >= 0.45 ? 'HOLD' : 'SKIP';
  return { score: s, decision };
}
