// strategy-run-execution-registry.ts — process-local, in-memory liveness registry for
// strategy_run_requests currently being executed by THIS process's Node event loop.
//
// Deliberately dependency-free (no imports from ./db, ./db-execution, ./strategy, or any module
// that transitively reaches those) so it can be imported from db-execution.ts — a leaf reachable
// from the ./db barrel — WITHOUT recreating db -> db-execution -> strategy-run-requests ->
// strategy -> db.  That exact cycle (introduced when isStrategyRunExecutionLive was imported
// directly from strategy-run-requests.ts into db-execution.ts) broke `npm run build` with
// `ReferenceError: Cannot access 'y' before initialization` while collecting
// /api/account/deletion (2026-09-01, PR #3138 review).  db-execution.ts already carried an
// explicit comment warning against importing strategy-run-requests.ts for exactly this reason.
//
// Extracted out of strategy-run-requests.ts, which re-exports these names unchanged so no
// existing `from "./strategy-run-requests"` import site needs to change.

export type ExecutionBeat = { at: number; timer?: ReturnType<typeof setInterval> };

const executionHost = globalThis as unknown as {
  __socraticStrategyRunExecutions?: Map<string, ExecutionBeat>;
};

function executionMap(): Map<string, ExecutionBeat> {
  return (executionHost.__socraticStrategyRunExecutions ??= new Map());
}

export function isStrategyRunExecutionLive(runId: string): boolean {
  return executionMap().has(runId);
}

export function beginStrategyRunExecution(
  runId: string,
  now: number = Date.now()
): { stop: () => void; owns: () => boolean } {
  const prev = executionMap().get(runId);
  if (prev?.timer) clearInterval(prev.timer);
  const beat: ExecutionBeat = { at: now };
  beat.timer = setInterval(() => {
    beat.at = Date.now();
  }, 15_000);
  beat.timer.unref?.();
  executionMap().set(runId, beat);
  return {
    owns: () => executionMap().get(runId) === beat,
    stop: () => {
      if (beat.timer) clearInterval(beat.timer);
      if (executionMap().get(runId) === beat) executionMap().delete(runId);
    }
  };
}

export function resetStrategyRunExecutionsForTest(): void {
  for (const beat of executionMap().values()) {
    if (beat.timer) clearInterval(beat.timer);
  }
  executionMap().clear();
}
