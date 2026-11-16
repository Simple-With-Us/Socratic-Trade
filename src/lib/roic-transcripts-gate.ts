// roic-transcripts-gate.ts — zero-import leaf for the ROIC.ai earnings-call source.
//
// Same cycle-safe pattern as earningscalls-gate.ts.  vector-db retrieval, strategy,
// and chat sanitization must not import the producer (which imports storeDocument).
//
// Opt-in = ROIC key present (Connections or env).  ROIC_TRANSCRIPTS_DISABLED=1 is
// the kill-switch that turns ingest AND retrieval off without deleting the key.

/** Metadata `source` stamped on every ROIC-derived transcript vector. */
export const ROIC_TRANSCRIPT_SOURCE = "roic-earnings-transcript";

/** Shared transcript doc type — same lane as FMP / EarningsCalls; `source` distinguishes. */
export const ROIC_TRANSCRIPT_DOC_TYPE = "earnings-transcript";

function flagOn(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}

function isDummyKey(value: string): boolean {
  const normalized = value.toLowerCase().trim();
  return (
    normalized === "" ||
    normalized === "dummy" ||
    normalized === "placeholder" ||
    normalized === "false" ||
    normalized === "none"
  );
}

/** Owner kill-switch: ROIC_TRANSCRIPTS_DISABLED=1 halts fetching AND retrieval. */
export function roicTranscriptsKillSwitchOn(): boolean {
  return flagOn(process.env.ROIC_TRANSCRIPTS_DISABLED);
}

/**
 * True when a usable ROIC key exists in env.  Connections-only keys are resolved
 * by the producer via resolveApiKeyWithSource; this leaf only sees env so
 * vector-db can stay cycle-free.  The producer AND this gate both consult the
 * kill-switch.  Retrieval also admits ROIC when the producer already ingested
 * (source stamp) and the kill-switch is off — env is the production path.
 */
export function roicEnvKeyPresent(): boolean {
  for (const name of ["ROIC_API_KEY", "ROIC_KEY"] as const) {
    const raw = process.env[name]?.trim();
    if (raw && !isDummyKey(raw)) return true;
  }
  return false;
}

/** Key-in-env (or kill-switch off + env) — used by retrieval when userId is unknown. */
export function roicTranscriptsEnabled(): boolean {
  if (roicTranscriptsKillSwitchOn()) return false;
  return roicEnvKeyPresent();
}
