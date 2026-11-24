/**
 * The last vs-SPY benchmark result per connected account, kept in this web process only.
 * Written by the dashboard snapshot after it computes the benchmark; read by the token-gated
 * /api/ops/snapshot so a remote check can see the state without a user session.  No account
 * numbers, no secrets: a status word, a reason, dates and percentages.  Empty after a restart
 * until the next dashboard load, which the snapshot reports as null (never as "ok").
 */
export interface BenchmarkStateRecord {
  status: "ok" | "unavailable";
  reason: string | null;
  detail: string | null;
  cashFlowSource: "broker" | "inferred" | null;
  brokerLedgerComplete: boolean;
  benchmarkSymbol: string;
  startDate: string | null;
  endDate: string | null;
  accountReturnPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  timedOutSections: string[];
  computedAt: string;
}

const MAX_ACCOUNTS = 200;
// Pinned on globalThis so the dashboard writer and the ops-snapshot reader share one Map even if
// Next bundles this module into more than one route chunk.
const globalStore = globalThis as typeof globalThis & { __benchmarkStates?: Map<string, BenchmarkStateRecord> };
const states: Map<string, BenchmarkStateRecord> = (globalStore.__benchmarkStates ??= new Map<string, BenchmarkStateRecord>());

export function recordBenchmarkState(accountId: string | undefined, record: Omit<BenchmarkStateRecord, "computedAt">, now: Date = new Date()): void {
  if (!accountId) return;
  if (states.has(accountId)) {
    states.delete(accountId); // Map.set keeps the original position; delete first so a refresh counts as recent
  } else if (states.size >= MAX_ACCOUNTS) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
  states.set(accountId, { ...record, timedOutSections: [...record.timedOutSections], computedAt: now.toISOString() });
}

export function readBenchmarkState(accountId: string): BenchmarkStateRecord | null {
  const found = states.get(accountId);
  return found ? { ...found, timedOutSections: [...found.timedOutSections] } : null;
}

export function resetBenchmarkStateForTests(): void {
  states.clear();
}
