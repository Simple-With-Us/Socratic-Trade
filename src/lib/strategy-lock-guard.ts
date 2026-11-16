import { renewStrategyLock } from "./db-execution";

export const STRATEGY_LOCK_HEARTBEAT_MS = 60_000;
export const STRATEGY_LOCK_STALE_MS = 5 * 60_000;

export class StrategyLockOwnershipLostError extends Error {
  constructor() {
    super("Strategy lock ownership was lost; refusing further execution.");
    this.name = "StrategyLockOwnershipLostError";
  }
}

type RenewStrategyLock = typeof renewStrategyLock;

export interface StrategyLockGuard {
  /**
   * Re-prove ownership synchronously before an irreversible money-path step.
   * Once any heartbeat fails, this guard stays failed closed for the rest of the invocation.
   */
  assertOwned(): void;
  stop(): void;
}

export function createExecuteProposalLockOwner(proposalId: string): string {
  return `execute-${proposalId}-${globalThis.crypto.randomUUID()}`;
}

export function startStrategyLockGuard(
  input: {
    owner: string;
    userId: string;
    connectedAccountId?: string;
    heartbeatMs?: number;
    staleMs?: number;
  },
  deps: { renew?: RenewStrategyLock } = {}
): StrategyLockGuard {
  const renew = deps.renew ?? renewStrategyLock;
  const heartbeatMs = input.heartbeatMs ?? STRATEGY_LOCK_HEARTBEAT_MS;
  const staleMs = input.staleMs ?? STRATEGY_LOCK_STALE_MS;
  let stopped = false;
  let ownershipLost = false;

  const markLost = (reason: unknown): void => {
    if (ownershipLost) return;
    ownershipLost = true;
    const detail = reason instanceof Error ? reason.message : String(reason);
    console.error(`[strategy-lock] ownership lost for ${input.owner}: ${detail}`);
  };

  const renewNow = (): boolean => {
    if (stopped || ownershipLost) return false;
    try {
      const renewed = renew(input.owner, input.userId, input.connectedAccountId, staleMs);
      if (!renewed) markLost("renewal was refused");
      return renewed;
    } catch (error) {
      markLost(error);
      return false;
    }
  };

  // The callback is deliberately synchronous and fully caught: a DB error must mark this
  // invocation failed closed, never escape the timer as an uncaught interval exception.
  const timer = setInterval(() => {
    renewNow();
  }, heartbeatMs);
  timer.unref?.();

  return {
    assertOwned(): void {
      if (ownershipLost || stopped || !renewNow()) {
        throw new StrategyLockOwnershipLostError();
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}
