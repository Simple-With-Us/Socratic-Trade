// proposal-phase-guard.ts — deterministic post-generation consistency checks for TradeProposals.
//
// Every helper here is PURE and produces (or feeds) `TradeProposal.dataAdjustments` receipts:
// visible, kind-prefixed, machine-queryable records of a correction, mismatch, or fallback the app
// observed after the model produced a proposal. Receipts NEVER rewrite the model's rationale and
// NEVER block a proposal — they exist so a repair is auditable instead of silent. Conservative by
// design: every check prefers a false negative over a false claim, and returns nothing at all when
// its input signal is absent (an unknown session, a missing scan) rather than guessing.
import type { MarketSession } from "./market-hours";
import type { MarketScan } from "./types";
import { normalizeSymbol } from "./money";

/** Phrases that read as executing immediately — a mismatch when the market can't fill right now. */
const IMMEDIATE_ACTION_PHRASES = ["buy now", "buying now", "at the open", "right now", "this morning"] as const;

/** Phrases that read as an after-hours recap — a mismatch while the regular session is live. */
const EOD_RECAP_PHRASES = ["after the close", "closed up", "closed down", "end-of-day recap"] as const;

const SESSION_LABEL: Record<MarketSession, string> = {
  closed: "closed",
  pre: "premarket",
  regular: "the regular session",
  post: "after-hours"
};

/**
 * Deterministic, case-insensitive check that a rationale's timing language matches the actual
 * market session at proposal time. Returns a `session_phrase_mismatch: …` receipt string, or null
 * when nothing fires. Null (not a receipt) when the session is unknown — no signal, no claim.
 * Substring matching on a short fixed phrase list on purpose: false negatives are fine, a receipt
 * must never be speculative. The rationale itself is never rewritten.
 */
export function sessionPhrasingReceipt(
  rationale: string | null | undefined,
  session: MarketSession | null | undefined
): string | null {
  if (!rationale || session == null) return null;
  const text = rationale.toLowerCase();

  if (session === "closed" || session === "pre") {
    const hit = IMMEDIATE_ACTION_PHRASES.find((phrase) => text.includes(phrase));
    if (hit) {
      return `session_phrase_mismatch: The rationale uses immediate-action phrasing ("${hit}") while the market session is ${SESSION_LABEL[session]}.  Execution follows the order's actual session eligibility, not the phrasing.`;
    }
  }

  if (session === "regular") {
    const hit = EOD_RECAP_PHRASES.find((phrase) => text.includes(phrase));
    if (hit) {
      return `session_phrase_mismatch: The rationale uses end-of-day recap phrasing ("${hit}") while the regular trading session is still open.`;
    }
  }

  return null;
}

/**
 * Names the proposal symbol's degraded CORE scan inputs, or [] when nothing observable is degraded.
 * HONEST at the sizing seam: reads only the symbol's own quote off the marketScan already passed to
 * the deterministic sizer — never a proxy that claims sourcing knowledge the seam lacks. Degraded
 * means one of:
 *   - the scan carries candidates but none for this symbol (sized with no market data for it);
 *   - the quote exists but has no positive price (no real entry anchor);
 *   - the quote's per-field enrichment observation for price reports status "failed" — the
 *     cascade's ALL-providers-failed stamp (data-providers.ts), i.e. the model judged this name on
 *     a bare screener row.
 * No marketScan (or an empty vestigial one) → [] — absence of attached data is not evidence of
 * degraded data. Optional enrichment simply being unconfigured never counts as degradation.
 */
export function degradedCoreInputs(symbol: string, marketScan: MarketScan | null | undefined): string[] {
  if (!marketScan) return [];
  const sym = normalizeSymbol(symbol);
  const quote =
    marketScan.topCandidates.find((candidate) => normalizeSymbol(candidate.symbol) === sym) ??
    marketScan.quotesBySymbol?.[sym];
  if (!quote) {
    return marketScan.topCandidates.length > 0 ? ["no scan quote for the symbol"] : [];
  }
  const degraded: string[] = [];
  if (!(typeof quote.price === "number" && Number.isFinite(quote.price) && quote.price > 0)) {
    degraded.push("no positive price on the scan quote");
  }
  if (quote.fieldObservations?.price?.status === "failed") {
    degraded.push("enrichment failed across all providers");
  }
  return degraded;
}
