// news-relevance.ts — entity-relevance gating rubric for provider news headlines/sentiment.
//
// Lesson from ZhuLinsen/daily_stock_analysis: providers that carry their OWN relevance score
// (Alpha Vantage's ticker_sentiment[].relevance_score, Marketaux's entities[].match_score) had
// that score parsed and then thrown away by this app, and providers with no native score at all
// (Finnhub company-news, the Alpaca/Benzinga stream) attribute a headline to a symbol whenever
// the provider's own topic-tag says so — with no check that the headline TEXT actually names the
// symbol or its company. Both gaps let context-polluting headlines reach the strategist prompt,
// worst of all when a company's name is an ordinary English word or unrelated brand ("Apple" the
// fruit, "Target" the errand, "Gap" the store aisle, "Shell" the beach find) with nothing
// finance-related in the sentence.
//
// This module is the shared, deterministic text-only rubric used by (a) providers with no native
// score at all, and (b) as the fallback path callers may still want even where a native score IS
// available. It scores a headline's relevance to ONE symbol from headline text alone.
//
// LEAF module: no imports, so every call site and every test share byte-identical logic.
//
// ── Scoring model ────────────────────────────────────────────────────────────────────────────
// Additive across independent signals, capped at 1:
//   - A ticker mention (bare word-boundary match, or a $TICKER cashtag) is the strongest signal —
//     real ticker letters are rarely ALSO a common English word used in an unrelated sense the
//     way company names are, so this needs no corroboration.
//   - A company-name match is next. For names on AMBIGUOUS_COMPANY_NAMES — ordinary dictionary/
//     brand words that are ALSO real company names ("meta", "block", "shell", "gap", ...) — the
//     bare name match earns NOTHING on its own; it only scores when a finance-event term
//     (earnings, downgrade, SEC, ...) co-occurs in the same headline, which is what actually
//     distinguishes "Shell reports record profit" from "walked out of his shell".
// A headline with neither signal scores 0 — never a fabricated/guessed nonzero score.

export interface HeadlineRelevanceResult {
  /** 0 (no textual evidence this headline is about `symbol`) .. 1 (unambiguous match), additive
   *  across signals and clamped to this range. */
  score: number;
  /** Human-readable trace of every signal considered — matched, rejected, and absent — for
   *  debugging why a headline was kept or dropped. Never empty. */
  reasons: string[];
}

export interface HeadlineRelevanceOptions {
  /** Extra company-name aliases to check alongside `companyName` (former/brand names, a DBA,
   *  etc.). Each alias is scored under the exact same rubric, including the ambiguous-name
   *  corroboration gate — an alias is not a way to bypass it. */
  aliases?: readonly string[];
}

const TICKER_MATCH_SCORE = 0.9;
const COMPANY_NAME_MATCH_SCORE = 0.6;
const AMBIGUOUS_NAME_MATCH_SCORE = 0.55;

/**
 * Common-word/brand company names that must NOT score on a bare name match alone — only when a
 * corroborating finance-event term (see FINANCE_EVENT_TERMS) also appears in the same headline.
 * Keyed by the lowercased bare name (after stripping a trailing corporate suffix — see
 * coreCompanyName); values are unused (a Set-shaped map so `AMBIGUOUS_COMPANY_NAMES.foo` reads
 * naturally and other modules/tests can inspect membership directly).
 */
export const AMBIGUOUS_COMPANY_NAMES: Record<string, true> = {
  apple: true,
  meta: true,
  square: true,
  block: true,
  target: true,
  gap: true,
  oracle: true,
  shell: true,
  visa: true,
  camden: true,
  arch: true
};

/** Finance-event vocabulary that corroborates an ambiguous company-name match. Word-boundary,
 *  case-insensitive, deliberately narrow (real filing/market-event words) so ordinary prose about
 *  the ambiguous word's non-financial sense can't accidentally satisfy it. */
const FINANCE_EVENT_TERMS = [
  "earnings", "guidance", "lawsuit", "upgrade", "upgraded", "downgrade", "downgraded", "recall",
  "insider", "merger", "acquisition", "sec", "filing", "dividend", "buyback", "ceo", "forecast",
  "shares", "stock"
];

// Trailing corporate suffix so "Apple Inc." and "Apple" match the same way. Anchored to the end
// of the (already-trimmed) name string, not the whole headline.
const CORPORATE_SUFFIX_RE = /\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|group|holdings|nv|sa)\.?$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `word` appears in `text` as a whole token — optionally with a leading `$` (ticker
 *  cashtag form, e.g. "$AAPL") when `allowCashtag` — bounded by non-alphanumeric characters or
 *  the string edges on both sides, so "AAPL" never matches inside "SNAAPLE". */
function hasWordBoundaryMatch(text: string, word: string, allowCashtag: boolean): boolean {
  if (!word) return false;
  const esc = escapeRegExp(word);
  const prefix = allowCashtag ? "\\$?" : "";
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${prefix}${esc}(?:[^A-Za-z0-9]|$)`, "i");
  return re.test(text);
}

/** Strips a trailing corporate suffix and surrounding whitespace. Returns "" for blank input. */
function coreCompanyName(name: string): string {
  return name.trim().replace(CORPORATE_SUFFIX_RE, "").trim();
}

/** Every FINANCE_EVENT_TERMS entry that appears (word-boundary, case-insensitive) in `headline`. */
function financeEventTermsPresent(headline: string): string[] {
  const found: string[] = [];
  for (const term of FINANCE_EVENT_TERMS) {
    if (hasWordBoundaryMatch(headline, term, false)) found.push(term);
  }
  return found;
}

/** Scores one company-name candidate against the headline, applying the ambiguous-name
 *  corroboration gate, and appends a human-readable trace line to `reasons`. */
function scoreNameCandidate(headline: string, rawName: string, corroboration: string[], reasons: string[]): number {
  const core = coreCompanyName(rawName);
  if (!core) return 0;
  if (!hasWordBoundaryMatch(headline, core, false)) {
    reasons.push(`company name "${core}" not found`);
    return 0;
  }

  const key = core.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(AMBIGUOUS_COMPANY_NAMES, key)) {
    if (corroboration.length > 0) {
      reasons.push(`ambiguous company name "${core}" matched, corroborated by finance term(s): ${corroboration.join(", ")}`);
      return AMBIGUOUS_NAME_MATCH_SCORE;
    }
    reasons.push(`ambiguous company name "${core}" matched but no corroborating finance-event term found — ignored`);
    return 0;
  }

  reasons.push(`company name "${core}" matched`);
  return COMPANY_NAME_MATCH_SCORE;
}

/**
 * Deterministic 0..1 relevance rubric for whether `headline` is actually about `symbol` (and,
 * optionally, `companyName`) — see the file header for the scoring model. Pure: same inputs
 * always produce the same output, no I/O, no randomness.
 */
export function scoreHeadlineRelevance(
  headline: string,
  symbol: string,
  companyName?: string,
  opts?: HeadlineRelevanceOptions
): HeadlineRelevanceResult {
  const text = typeof headline === "string" ? headline : "";
  const sym = typeof symbol === "string" ? symbol.trim() : "";
  const reasons: string[] = [];

  if (!text.trim() || !sym) {
    return { score: 0, reasons: ["empty headline or symbol — no evidence possible"] };
  }

  let score = 0;

  if (hasWordBoundaryMatch(text, sym, true)) {
    reasons.push(`ticker "${sym}" matched (bare word or $-prefixed)`);
    score += TICKER_MATCH_SCORE;
  } else {
    reasons.push(`ticker "${sym}" not found`);
  }

  const corroboration = financeEventTermsPresent(text);
  const names = [companyName, ...(opts?.aliases ?? [])].filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0
  );
  for (const name of names) {
    score += scoreNameCandidate(text, name, corroboration, reasons);
  }

  return { score: Math.min(1, score), reasons };
}
