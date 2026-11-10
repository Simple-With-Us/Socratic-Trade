// Demand-first symbol order for RAG ingest: names the desk is more likely to
// trade come first so a per-run cap fills held/watchlist/scan-adjacent names
// before the broad index tail.

import { listUsers, listWatchlistSymbols } from "../db-api-keys";
import { listRecentlyHeldSymbolsAllUsers, listRecentlyHeldSymbolValuesAllUsers } from "../db-fills";
import { getPolicy } from "../db-profiles";
import { symbolsForPolicyUniverse } from "../index-universes";
import { normalizeSymbol } from "../money";
import { getTechnicalWatchlist } from "../web-sources/technical";
import fs from "fs";
import path from "path";

function loadManifestRank(manifestPath: string = path.resolve("data/rag-universe-manifest.json")): Map<string, number> {
  const rank = new Map<string, number>();
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { issuers?: Array<{ ticker?: unknown; rank?: unknown }> };
    for (const issuer of parsed.issuers ?? []) {
      const ticker = typeof issuer.ticker === "string" ? normalizeSymbol(issuer.ticker) : "";
      const r = typeof issuer.rank === "number" ? issuer.rank : undefined;
      if (ticker && r !== undefined && !rank.has(ticker)) rank.set(ticker, r);
    }
  } catch {
    // Non-fatal tail-fill.
  }
  return rank;
}

function pushUnique(out: string[], seen: Set<string>, raw: string): void {
  const s = normalizeSymbol(raw);
  if (!s || seen.has(s)) return;
  seen.add(s);
  out.push(s);
}

/**
 * Names the desk is most likely to trade: held by value, then watchlists,
 * then the technical watchlist.  Used to deepen history after a latest-only
 * universe pass.  Does not include the policy index or the 1k manifest tail.
 */
export function rankHighInterestSymbols(options?: { now?: number }): string[] {
  const now = options?.now ?? Date.now();
  const seen = new Set<string>();
  const out: string[] = [];

  try {
    const held = [...listRecentlyHeldSymbolValuesAllUsers(30, now).entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [symbol] of held) pushUnique(out, seen, symbol);
  } catch {
    for (const s of listRecentlyHeldSymbolsAllUsers(30, now)) pushUnique(out, seen, s);
  }

  for (const userId of listUsers()) {
    try {
      for (const item of listWatchlistSymbols(userId)) pushUnique(out, seen, item.symbol);
    } catch {
      // ignore per-user watchlist errors
    }
  }

  try {
    for (const s of getTechnicalWatchlist()) pushUnique(out, seen, s);
  } catch {
    // ignore
  }

  return out;
}

/**
 * Holdings by value, then watchlists, technical watchlist, each user's policy
 * index universe, then the 1k-issuer RAG manifest.  A symbol appears once at
 * its best tier so the cursor fills what the desk actually trades first.
 */
export function rankDemandFirstSymbols(options?: { symbols?: string[]; now?: number }): string[] {
  if (options?.symbols?.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of options.symbols) pushUnique(out, seen, raw);
    return out;
  }

  const now = options?.now ?? Date.now();
  const seen = new Set<string>();
  const out = rankHighInterestSymbols({ now });
  for (const s of out) seen.add(s);

  for (const userId of listUsers()) {
    try {
      for (const s of symbolsForPolicyUniverse(getPolicy(userId))) pushUnique(out, seen, s);
    } catch {
      // ignore per-user policy errors
    }
  }

  const manifest = [...loadManifestRank().entries()].sort((a, b) => a[1] - b[1]);
  for (const [symbol] of manifest) pushUnique(out, seen, symbol);

  return out;
}
