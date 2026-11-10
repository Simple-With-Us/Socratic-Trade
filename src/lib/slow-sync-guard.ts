// Instrumentation for synchronous CPU pins on the serving event loop.
//
// 2026-08-10: during the trial backfill, the prod next-server pinned at 100%+ CPU in state R
// for 11-85s stretches, freezing /api/health (Uptime Robot incidents) and every other request.
// The pin follows large filing ingests but the exact synchronous hot spot is content-dependent,
// so callers wrap their heavyweight sync calls with timeSync() and the process names the
// culprit (label, subject, duration) in its own logs. Warn-only — never changes behavior.

const SLOW_SYNC_WARN_MS = 1_000;

/** Run `fn` synchronously; warn with `label`/`subject` when it holds the event loop over 1s. */
export function timeSync<T>(label: string, subject: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - start;
    if (ms >= SLOW_SYNC_WARN_MS) {
      console.warn(`[slow-sync] ${label} held the event loop ${ms}ms (${subject})`);
    }
  }
}

/** Yield the event loop between heavyweight pipeline iterations so queued HTTP requests run. */
export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
