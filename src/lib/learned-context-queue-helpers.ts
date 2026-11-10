/**
 * Pure helpers for the learned-context confirmation queue UI.
 * No React, no I/O — pure functions so they can be unit-tested.
 */

import {
  buildStrategyDirectiveBlock,
  containDirectiveValue,
  directiveProvenanceLabel
} from "./learned-context/directive-block";

export type PendingTier = "risk" | "strategy-directive";

/** Maps a pending tier to the Chip tone used in the UI. */
export function tierTone(tier: PendingTier): "warn" | "info" {
  return tier === "risk" ? "warn" : "info";
}

/** Maps a pending tier to a human-readable label. */
export function tierLabel(tier: PendingTier): string {
  return tier === "risk" ? "Risk" : "Strategy Directive";
}

/**
 * Formats the attributed AI-LEARNED block that approval will append to the
 * strategy prompt for a 'strategy-directive' item.
 *
 * This is a PREVIEW the owner approves against, so it must be byte-identical to what the server
 * actually merges. Both sides call the same pure builder in learned-context/directive-block.ts:
 * the provenance line and, for non-owner-authored text, the containment pass are applied here too.
 * Always pass the row's `source`/`origin`; an unknown source is labelled as such and contained,
 * because "we could not tell where this came from" is never a reason to grant it owner trust.
 *
 * @param id  - The pending item ID (used as the block identifier).
 * @param date - ISO date string; only the date portion is shown.
 * @param value - The directive text.
 * @param source - The pending row's source (decides owner-authored vs contained).
 * @param origin - The pending row's origin, shown in the provenance line.
 */
export function formatStrategyDirectiveBlock(
  id: string,
  date: string,
  value: string,
  source?: string | null,
  origin?: string | null
): string {
  const contained = containDirectiveValue(value, source);
  return buildStrategyDirectiveBlock(id, contained.value, date, directiveProvenanceLabel(source, origin));
}

/**
 * Returns a concise relative date label for display (e.g. "Today", "Yesterday",
 * "3 days ago", or the ISO date string for older items).
 *
 * @param isoDate - ISO 8601 date/datetime string.
 * @param now     - Optional Date for the current time (defaults to Date.now()).
 */
export function relativeDate(isoDate: string, now?: Date): string {
  const then = new Date(isoDate);
  if (isNaN(then.getTime())) return isoDate;
  const base = now ?? new Date();
  const diffMs = base.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return then.toISOString().slice(0, 10);
}
