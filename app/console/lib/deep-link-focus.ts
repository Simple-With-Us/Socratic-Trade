/** Shared query-param focus helpers for console deep links.
 *
 *  Push URLs carry `?proposal=` and `?symbol=` (`src/lib/push-deep-links.ts`).
 *  These parsers match the iOS `DeepLink` charset/length rules so a tap that
 *  lands on the website highlights the same row the native app would. */

export const DEEP_LINK_FOCUS_CLASS = "con-deep-link-focus";

const PROPOSAL_ID_MAX = 64;
const PROPOSAL_ID_CHARS = /^[A-Za-z0-9-_.]+$/;
const SYMBOL_MAX = 10;
const SYMBOL_CHARS = /^[A-Za-z0-9.-]+$/;

export function proposalElementId(id: string): string {
  return `proposal-${id}`;
}

export function symbolElementId(symbol: string, surface: "row" | "card" = "row"): string {
  return surface === "card" ? `symbol-${symbol}-card` : `symbol-${symbol}`;
}

export function readProposalQuery(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > PROPOSAL_ID_MAX) return null;
  if (!PROPOSAL_ID_CHARS.test(trimmed)) return null;
  return trimmed;
}

export function readSymbolQuery(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.length > SYMBOL_MAX) return null;
  if (!SYMBOL_CHARS.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/** Scroll the first visible matching element into view. Hidden `lg:` /
 *  `lg:hidden` twins can share a logical target; we skip zero-size nodes so
 *  a `display:none` table does not steal the scroll on a phone. */
export function scrollDeepLinkTarget(ids: Array<string | null | undefined>): void {
  if (typeof document === "undefined") return;
  for (const id of ids) {
    if (!id) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    el.scrollIntoView({ block: "center" });
    return;
  }
}
