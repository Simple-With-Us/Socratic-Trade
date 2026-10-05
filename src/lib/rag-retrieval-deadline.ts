import { isDeadlineTimeoutError, markDeadlineTimeout, withDeadline } from "./inflight-deadline";

/**
 * Budget for one strategy-run RAG retrieval (query embed + dense vector read).
 * Issue #2961: the embed fetch used to be called with `signal: undefined`, so a
 * silent peer could hold the trading loop for undici's headers timeout (~5 min)
 * or longer. 15s matches the other short I/O ceilings in this process.
 */
export const RAG_QUERY_IO_DEADLINE_MS = 15_000;

export const STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE = "strategy RAG retrieval timed out";

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal != null);
  if (active.length === 0) return undefined;
  if (active.length === 1 || typeof AbortSignal.any !== "function") return active[0];
  return AbortSignal.any(active);
}

/**
 * Caller signal plus a default budget. The timer is unref'd so a finished call
 * does not keep the process (or a unit-test worker) alive, and `cancel()` drops
 * it as soon as the retrieval settles.
 */
export function createRagQueryAbort(
  caller?: AbortSignal,
  ms: number = RAG_QUERY_IO_DEADLINE_MS
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutError = () => markDeadlineTimeout(new Error(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE));
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutError());
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  const onCallerAbort = () => {
    if (!controller.signal.aborted) controller.abort(caller?.reason ?? timeoutError());
  };
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  };
}

/**
 * Stop awaiting `promise` when `signal` aborts. The original promise is always
 * observed so a late rejection cannot surface as unhandled.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  promise.then(
    () => undefined,
    () => undefined
  );
  if (!signal) return promise;
  if (signal.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE);
    return Promise.reject(reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason instanceof Error ? signal.reason : new Error(STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE);
      reject(reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Bound one strategy-run retrieval. On deadline the controller aborts in-flight
 * embed/query work and the caller gets `onTimeout` — the run continues and the
 * account is not halted. Any other error, including lock-ownership loss, propagates.
 */
export async function withStrategyRagRetrievalDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => T,
  ms: number = RAG_QUERY_IO_DEADLINE_MS
): Promise<T> {
  const controller = new AbortController();
  try {
    return await withDeadline(
      run(controller.signal),
      ms,
      STRATEGY_RAG_RETRIEVAL_TIMEOUT_MESSAGE,
      { controller }
    );
  } catch (error) {
    if (isDeadlineTimeoutError(error)) return onTimeout();
    throw error;
  }
}
