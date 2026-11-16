import { mkdirSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// The suite's temp SQLite databases (the `DATABASE_URL=file:<tmpdir>/agentic-*.db`
// beforeAll pattern, plus assorted `chat-*`/`trading-test-*`/`llm-provider-test-*`
// names) used to be written loose into the shared OS temp dir and never deleted —
// 178k files / ~130GB accumulated on one machine before a manual cleanup on
// 2026-07-09. vitest.config.ts now points the test runtime's TMPDIR/TMP/TEMP at a
// single per-run `agentic-vitest-*` directory, so every tmpdir()-derived artifact
// lands there without touching any test file; this global setup creates that
// directory and its teardown removes it.
//
// Crashed/killed runs still leak their per-run directory, so setup also sweeps
// `agentic-*` entries in the REAL temp dir older than 6h — the same age rule as the
// fleet disk janitor, and old enough that a concurrent (even hour-long) run's
// artifacts are never touched.

const STALE_AGE_MS = 6 * 60 * 60 * 1000;

function sweepStaleLeftovers(realTmp: string): void {
  let entries: string[];
  try {
    entries = readdirSync(realTmp);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_AGE_MS;
  for (const name of entries) {
    if (!name.startsWith("agentic-")) continue;
    const full = join(realTmp, name);
    try {
      if (lstatSync(full).mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // Raced with another run or the janitor, or a permission oddity — cleanup is
      // best-effort and must never fail the suite.
    }
  }
}

type GlobalSetupProject = { config?: { env?: Record<string, string | undefined> } };

export default function globalSetup(project?: GlobalSetupProject): (() => void) | void {
  // This runs in the vitest main process, where TMPDIR is NOT overridden — so
  // tmpdir() here is the real system temp dir that we sweep and that contains the
  // per-run directory.
  const realTmp = tmpdir();
  sweepStaleLeftovers(realTmp);

  // The per-run directory is computed once in vitest.config.ts (same process) and
  // handed off via the resolved test env, with the process env as a fallback.
  const runTmpRoot = project?.config?.env?.TMPDIR ?? process.env.AGENTIC_VITEST_TMPDIR;
  if (!runTmpRoot || !basename(runTmpRoot).startsWith("agentic-vitest-")) return;

  mkdirSync(runTmpRoot, { recursive: true });
  return () => {
    try {
      rmSync(runTmpRoot, { recursive: true, force: true });
    } catch {
      // Leaked on failure (e.g. a file still locked on Windows) — the >6h sweep on
      // the next run reclaims it.
    }
  };
}
