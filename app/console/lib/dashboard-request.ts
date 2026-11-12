/**
 * One in-flight GET /api/dashboard per tab.
 *
 * Poll ticks skip while a request is running, and again for about as long as
 * the previous response took when that response was slow. The shared fetch
 * aborts only when every subscriber has aborted (unmount). A second caller
 * joins the request that is already running.
 */

const SLOW_REQUEST_MS = 8_000;
const MAX_BACKOFF_MS = 30_000;

interface SharedRequest<T> {
  promise: Promise<T>;
  controller: AbortController;
  startedAt: number;
  subscribers: Set<object>;
}

let shared: SharedRequest<unknown> | null = null;
let backoffUntil = 0;
let nowFn: () => number = () => Date.now();

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function noteDuration(startedAt: number): void {
  const finishedAt = nowFn();
  const elapsed = finishedAt - startedAt;
  if (elapsed < SLOW_REQUEST_MS) return;
  backoffUntil = finishedAt + Math.min(elapsed, MAX_BACKOFF_MS);
}

export function dashboardFetchInFlight(): boolean {
  return shared !== null;
}

export function shouldSkipDashboardPoll(now = nowFn()): boolean {
  return shared !== null || now < backoffUntil;
}

export function setDashboardRequestClockForTests(clock: (() => number) | null): void {
  nowFn = clock ?? (() => Date.now());
}

export function resetDashboardRequestForTests(): void {
  const current = shared;
  shared = null;
  backoffUntil = 0;
  nowFn = () => Date.now();
  if (!current) return;
  current.promise.catch(() => {});
  current.controller.abort();
}

function bindSubscriber<T>(entry: SharedRequest<T>, signal?: AbortSignal): Promise<T> {
  const token = {};
  entry.subscribers.add(token);
  const remove = () => {
    entry.subscribers.delete(token);
  };
  if (!signal) return entry.promise.finally(remove);

  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      remove();
      if (entry.subscribers.size === 0) entry.controller.abort();
      reject(abortError());
      return;
    }
    const onAbort = () => {
      cleanup();
      remove();
      if (entry.subscribers.size === 0) entry.controller.abort();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort);
    entry.promise.then(
      (value) => {
        cleanup();
        remove();
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        remove();
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        reject(error);
      }
    );
  });
}

export function loadSharedDashboard<T>(
  fetchImpl: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (shared) return bindSubscriber(shared as SharedRequest<T>, signal);

  const controller = new AbortController();
  const startedAt = nowFn();
  let created: Promise<T>;
  try {
    created = Promise.resolve(fetchImpl(controller.signal));
  } catch (error) {
    return Promise.reject(error);
  }
  const promise = created.finally(() => {
    noteDuration(startedAt);
    if (shared?.controller === controller) shared = null;
  });
  const entry: SharedRequest<T> = {
    promise,
    controller,
    startedAt,
    subscribers: new Set()
  };
  shared = entry as SharedRequest<unknown>;
  return bindSubscriber(entry, signal);
}
