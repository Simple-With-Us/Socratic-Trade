// prompt-headlines.ts — compaction of raw news headlines for the strategist prompt (handoff 3.6).
//
// Quotes carry `headlines: string[]` (bare provider titles — the upstream pipeline keeps no
// source/publisher or timestamp per headline, so none is shown: we never fabricate provenance).
// This module makes the injected sample bounded and faithful:
//   - strips HTML markup/entities and collapses whitespace,
//   - dedupes near-identical headlines (normalized-equality always; prefix-containment only for
//     long headlines, so "Apple" can never swallow every other Apple headline),
//   - caps the count at HEADLINES_PER_CANDIDATE,
//   - NEVER truncates a headline mid-claim — a headline is kept whole or not at all, because a
//     cut like "Apple beats estimates … [but warns on guidance]" inverts meaning.
// LEAF module: no imports, so tests and strategy.ts both use the exact same logic.

/** Max raw headlines injected per candidate into the strategist prompt (was 2 pre-3.6). */
export const HEADLINES_PER_CANDIDATE = 5;

/** Minimum normalized length before prefix-containment counts as a near-duplicate. Below this,
 *  only exact normalized equality dedupes (short strings prefix-match too promiscuously). */
const PREFIX_DEDUPE_MIN_LENGTH = 30;

/** Strip HTML tags + common entities, collapse whitespace. Returns "" for non-text input. */
function stripMarkup(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case/punctuation-insensitive key for near-duplicate detection. */
function dedupeKey(headline: string): string {
  return headline.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isNearDuplicate(key: string, kept: string[]): boolean {
  for (const seen of kept) {
    if (seen === key) return true;
    const shorter = Math.min(seen.length, key.length);
    if (shorter >= PREFIX_DEDUPE_MIN_LENGTH && (seen.startsWith(key) || key.startsWith(seen))) return true;
  }
  return false;
}

/**
 * Bounded, deduped, markup-free headline sample for one candidate. Returns [] (which
 * compactPromptObject drops entirely) when nothing usable survives — never an empty scaffold.
 * Headlines are kept WHOLE in provider order (already newest-first); count capped at `max`.
 */
export function compactHeadlinesForPrompt(
  headlines: readonly string[] | undefined,
  max: number = HEADLINES_PER_CANDIDATE
): string[] {
  if (!headlines || headlines.length === 0 || max <= 0) return [];
  const out: string[] = [];
  const keptKeys: string[] = [];
  for (const raw of headlines) {
    if (typeof raw !== "string") continue;
    const cleaned = stripMarkup(raw);
    if (!cleaned) continue;
    const key = dedupeKey(cleaned);
    if (!key || isNearDuplicate(key, keptKeys)) continue;
    keptKeys.push(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}
