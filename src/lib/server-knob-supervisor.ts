/**
 * Runtime supervisor for server knobs whose consumers are BOOT-TIME starters (the stream
 * workers).  Two jobs:
 *
 *   1. Register the congress-stream enabled resolver.  congress-stream.ts sits on the
 *      instrumentation import chain that Next also bundles for the edge runtime, so it cannot
 *      statically import the DB-backed server-knobs module itself — the Node-only startup path
 *      injects the resolver instead.  Registration happens in startServerKnobSupervisor(), which
 *      startServerBackgroundWorkers calls BEFORE startStreams() so even the boot gate sees a DB
 *      override.
 *
 *   2. Poll the stream knobs and re-invoke the (idempotent, self-gated) starters on a rising
 *      edge, so a stream that NEVER STARTED (knob off at boot, or the starter declined) starts
 *      within one poll interval of a flip on, without a redeploy.  Rising-edge only — a starter
 *      that declines for its own reasons (missing creds, no watched symbols) warns once per
 *      flip, not once per poll.  The edge is ONLY for first starts: parking and resuming a
 *      stream that already started is each stream module's own level-based job (alpaca streams
 *      keep a capped reconnect chain alive while parked; congress-stream keeps its run loop
 *      alive as a slow self-poll), so an off->on bounce inside one poll window — which shows
 *      the supervisor on->on, no edge — still resumes on its own.
 *
 * The SEC ingest worker needs neither job: startSecIngestWorker now always starts the loop and
 * the loop parks itself per tick (see rag/sec-ingest-worker.ts).
 */

import { setCongressStreamEnabledResolver } from "./congress-stream";
import { serverKnobBool } from "./server-knobs";
import { startStreams } from "./streams";

const STREAM_KNOB_IDS = [
  "STREAMS_ALPACA_NEWS_ENABLED",
  "STREAMS_ALPACA_TRADE_UPDATES_ENABLED",
  "STREAMS_ALPACA_PRICE_EVENTS_ENABLED",
  "CONGRESS_STREAM_ENABLED"
] as const;

export const SERVER_KNOB_SUPERVISOR_POLL_MS = 30_000;

type SupervisorHost = typeof globalThis & { __serverKnobSupervisorStarted?: boolean };
const host = globalThis as SupervisorHost;

/** Idempotent; globalThis-pinned like the other process-level singletons so HMR/test re-evaluation
 *  cannot spawn a second interval. */
export function startServerKnobSupervisor(): void {
  // Resolver registration is safe to repeat and must precede the boot startStreams() call.
  setCongressStreamEnabledResolver(() => serverKnobBool("CONGRESS_STREAM_ENABLED"));
  if (host.__serverKnobSupervisorStarted) return;
  host.__serverKnobSupervisorStarted = true;

  const last: Record<string, boolean> = {};
  for (const id of STREAM_KNOB_IDS) last[id] = serverKnobBool(id);

  const interval = setInterval(() => {
    let risingEdge = false;
    for (const id of STREAM_KNOB_IDS) {
      const cur = serverKnobBool(id);
      if (cur && !last[id]) risingEdge = true;
      last[id] = cur;
    }
    if (!risingEdge) return;
    try {
      // Every starter is self-gated on its own knob and idempotent, so re-invoking the whole
      // family only starts the newly-enabled stream.
      startStreams();
    } catch (err) {
      console.error("[server-knobs] stream restart failed:", err instanceof Error ? err.message : String(err));
    }
  }, SERVER_KNOB_SUPERVISOR_POLL_MS);
  interval.unref?.();
}
