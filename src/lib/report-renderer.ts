// report-renderer.ts — three pure, plain-text/markdown-lite renderers over a
// WatchlistReportContext (report-context.ts), one per delivery tier. Each function is pure: same
// context in, same string out, no I/O. notify.ts (CHANNEL_CAPABILITIES) picks the largest tier
// that fits a given channel's length cap. Every value is honest-or-omitted: a symbol with no
// quote or no proposal history renders "no data" text, never a fabricated number or a padded
// trajectory row. All ASCII-only (no em dashes/unicode) so the SMS/pushover tiers stay
// predictable, single-segment where possible.

import { feedStatusLabel } from "./dashboard-ui";
import type { WatchlistReportContext, WatchlistSymbolReport } from "./report-context";
import type { SymbolProposalTrajectoryRow } from "./db-proposals";

const CENTRAL_TIME_ZONE = "America/Chicago";

/** "YYYY-MM-DD" in Central Time — DST-safe (mirrors app/console/lib/format.ts's centralDateKey,
 *  duplicated rather than imported: that module is client-scoped). Falls back to the raw input on
 *  an unparseable timestamp rather than throwing — a malformed stored value must never crash the
 *  digest build. */
export function ctDateKey(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CENTRAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

/** "Aug 11, 2026, 3:15 PM CT" — used for the digest's own generated/as-of stamps. */
export function ctDateTime(iso: string | undefined): string {
  if (!iso) return "no data yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "no data yet";
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
  return `${formatted} CT`;
}

function fmtMoney(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "-";
}

function fmtPct(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtConfidence(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "-";
}

function decisionLabel(row: SymbolProposalTrajectoryRow): string {
  return feedStatusLabel(row.decision) || row.decision;
}

/** Drop trailing lines (replacing them with a "+N more" note) until the joined text fits
 *  `maxChars`. Used by the brief tier's hard cap so an oversized watchlist still fits the
 *  smallest channel instead of being silently dropped by notify()'s channel-level truncation. */
function capLines(lines: string[], maxChars: number, unit: string): string {
  const full = lines.join("\n");
  if (full.length <= maxChars || lines.length === 0) return full;
  for (let kept = lines.length - 1; kept >= 0; kept--) {
    const omitted = lines.length - kept;
    const candidate = [...lines.slice(0, kept), `+${omitted} more ${unit}${omitted === 1 ? "" : "s"} not shown`].join("\n");
    if (candidate.length <= maxChars) return candidate;
  }
  return `+${lines.length} ${unit}s not shown`;
}

// ── Full tier: one detailed section per symbol, incl. the trajectory table ──────────────────────

function renderTrajectoryTable(trajectory: SymbolProposalTrajectoryRow[]): string {
  if (trajectory.length === 0) return "    No proposal history yet.";
  return trajectory
    .map((row) => {
      const date = ctDateKey(row.createdAt).padEnd(10);
      const tag = (row.tradeThesisTag ?? "-").padEnd(24);
      const decision = decisionLabel(row).padEnd(16);
      return `    ${date} ${tag} ${decision} conf ${fmtConfidence(row.confidenceScore)}`;
    })
    .join("\n");
}

function renderFullSymbolSection(s: WatchlistSymbolReport): string {
  const lines: string[] = [s.symbol];
  if (s.quote) {
    const name = s.quote.companyName ? ` (${s.quote.companyName})` : "";
    const sector = s.quote.sector ? `  Sector: ${s.quote.sector}` : "";
    lines.push(`  ${fmtMoney(s.quote.price)}${name}  Change: ${fmtPct(s.quote.intradayChangePct)}${sector}`);
  } else {
    lines.push("  No market scan data for this symbol yet.");
  }
  if (s.latestProposal) {
    const p = s.latestProposal;
    lines.push(
      `  Latest idea: ${p.side.toUpperCase()}, ${decisionLabel(p)}, confidence ${fmtConfidence(p.confidenceScore)}, ` +
        `ref ${fmtMoney(p.referencePrice)}, thesis ${p.tradeThesisTag ?? "-"} (${ctDateKey(p.createdAt)} CT)`
    );
  } else {
    lines.push("  No proposal history for this symbol yet.");
  }
  lines.push("  Recent history (date CT, thesis, decision, confidence):");
  lines.push(renderTrajectoryTable(s.trajectory));
  return lines.join("\n");
}

export function renderWatchlistDigestFull(context: WatchlistReportContext): string {
  const header =
    `Watchlist Digest - ${ctDateKey(context.generatedAt)}\n` +
    `Generated: ${ctDateTime(context.generatedAt)}.  Market scan as of: ${ctDateTime(context.marketScanAsOf)}.`;
  if (context.symbols.length === 0) {
    return `${header}\n\nNo symbols on your watchlist yet.  Add one in the console to start seeing it here.`;
  }
  const sections = context.symbols.map(renderFullSymbolSection);
  return `${header}\n\n${sections.join("\n\n")}`;
}

// ── Medium tier: every symbol, one short block each, top movers first ───────────────────────────

function renderMediumSymbolLine(s: WatchlistSymbolReport): string {
  const price = s.quote ? `${fmtMoney(s.quote.price)} (${fmtPct(s.quote.intradayChangePct)})` : "no scan data";
  const idea = s.latestProposal
    ? `${s.latestProposal.side.toUpperCase()} ${decisionLabel(s.latestProposal)}, conf ${fmtConfidence(s.latestProposal.confidenceScore)}`
    : "no proposal history";
  return `${s.symbol} ${price} - ${idea}`;
}

export function renderWatchlistDigestMedium(context: WatchlistReportContext): string {
  const header = `Watchlist Digest - ${ctDateKey(context.generatedAt)} (top movers first)`;
  if (context.symbols.length === 0) {
    return `${header}\n\nNo symbols on your watchlist yet.`;
  }
  // Sort by |intradayChangePct| descending; symbols with no change data keep their original
  // (watchlist) order and sort after every symbol that has one — "top movers" is a sort, not a
  // filter, so every watchlist symbol still appears.
  const ranked = context.symbols
    .map((s, index) => {
      const pct = s.quote?.intradayChangePct;
      return { s, index, mag: pct === undefined ? undefined : Math.abs(pct) };
    })
    .sort((a, b) => {
      if (a.mag !== undefined && b.mag !== undefined) return b.mag - a.mag;
      if ((a.mag !== undefined) !== (b.mag !== undefined)) return a.mag !== undefined ? -1 : 1;
      return a.index - b.index;
    })
    .map((r) => r.s);
  const lines = ranked.map(renderMediumSymbolLine);
  return `${header}\n\n${lines.join("\n")}`;
}

// ── Brief tier: one line per symbol, hard-capped so it always fits the smallest channel ─────────

/** Keeps the brief tier comfortably under Pushover's 1024-char cap (notify.ts
 *  CHANNEL_CAPABILITIES) even for a large watchlist, leaving room for the title. */
export const WATCHLIST_DIGEST_BRIEF_MAX_CHARS = 900;

function renderBriefSymbolLine(s: WatchlistSymbolReport): string {
  const price = s.quote ? `${fmtMoney(s.quote.price)} ${fmtPct(s.quote.intradayChangePct)}` : "no data";
  const decision = s.latestProposal ? `${s.latestProposal.side.toUpperCase()} ${decisionLabel(s.latestProposal)}` : "no proposals";
  return `${s.symbol} ${price} ${decision}`;
}

export function renderWatchlistDigestBrief(context: WatchlistReportContext): string {
  if (context.symbols.length === 0) return "Watchlist digest: no symbols on your watchlist yet.";
  const lines = context.symbols.map(renderBriefSymbolLine);
  return capLines(lines, WATCHLIST_DIGEST_BRIEF_MAX_CHARS, "symbol");
}
