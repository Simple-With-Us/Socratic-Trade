// earningscalls-gate.ts — zero-import leaf: the single enablement predicate + identity
// constants for the EarningsCalls.dev transcript source.
//
// Kept as its own dependency-free module (env reads only) because THREE otherwise-unrelated
// layers need the exact same answer and must never drift or form an import cycle:
//   - the producer (earningscalls-transcripts.ts) to decide whether to fetch at all,
//   - vector-db.ts retrieval gating (buildExtraFilters / filterMatchesForTranscriptRights),
//   - strategy.ts / chat orchestrator doc-type request + post-fetch sanitization.
// vector-db must not import the (heavy) producer module, and the producer dynamic-imports
// vector-db — a shared leaf is the only cycle-safe home.
//
// Opt-in model (owner-directed, 2026-07-16): the key IS the consent. The owner signing up for
// the EarningsCalls.dev plan and installing a key is the opt-in to fetching, caching, and
// RAG-ingesting transcripts from that source — there is no second rights flag (contrast
// FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED, which exists because the FMP key is also used for
// many non-transcript endpoints). EARNINGSCALLS_DISABLED=1 is the kill-switch that turns the
// whole source off without deleting the key.
//
// Two credential slots, one source (the vendor sells through two channels):
//   - EARNINGSCALLS_API_KEY      — first-party key (X-API-Key @ earningscalls.dev; paid only)
//   - EARNINGSCALLS_RAPIDAPI_KEY — RapidAPI marketplace key (x-rapidapi-* headers @
//     earnings-call-transcripts1.p.rapidapi.com; this is where the free 200/month plan lives,
//     and is the channel the owner subscribed through on 2026-07-16)
// Direct wins when both are present (first-party has no marketplace proxy in the path).

/** Metadata `source` value stamped on every EarningsCalls.dev-derived vector/chunk. */
export const EARNINGSCALLS_TRANSCRIPT_SOURCE = "earningscalls-dev";

/** Shared transcript doc type — same value as FMP's so transcript retrieval stays one doc-type
 *  lane; the `source` field is what distinguishes (and independently gates) the two producers. */
export const EARNINGSCALLS_TRANSCRIPT_DOC_TYPE = "earnings-transcript";

function flagOn(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}

/** Owner kill-switch: EARNINGSCALLS_DISABLED=1 halts fetching AND retrieval of this source. */
export function earningsCallsKillSwitchOn(): boolean {
  return flagOn(process.env.EARNINGSCALLS_DISABLED);
}

/** The active credential (direct first-party preferred over RapidAPI), or null when neither
 *  env is set. Kill-switch is NOT consulted here — enablement composes it below. */
export function earningsCallsCredential(): { channel: "direct" | "rapidapi"; key: string } | null {
  const isDummy = (k: string) => {
    const normalized = k.toLowerCase().trim();
    return normalized === "" || normalized === "dummy" || normalized === "placeholder" || normalized === "false" || normalized === "none";
  };

  const direct = process.env.EARNINGSCALLS_API_KEY?.trim();
  if (direct && !isDummy(direct)) return { channel: "direct", key: direct };
  const rapid = process.env.EARNINGSCALLS_RAPIDAPI_KEY?.trim();
  if (rapid && !isDummy(rapid)) return { channel: "rapidapi", key: rapid };
  return null;
}

/**
 * True when the EarningsCalls.dev source is active: a credential present (key = opt-in, either
 * channel) and the kill-switch off. Gates BOTH sides symmetrically — no key/killed means the
 * producer makes zero HTTP calls AND previously-ingested earningscalls chunks stop being
 * retrievable (mirroring how withdrawing the FMP rights flag removes FMP transcripts from
 * every RAG consumer).
 */
export function earningsCallsTranscriptsEnabled(): boolean {
  if (earningsCallsKillSwitchOn()) return false;
  return earningsCallsCredential() !== null;
}
