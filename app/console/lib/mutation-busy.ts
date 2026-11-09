/**
 * Process-wide in-flight mutation counter for the console.
 * Both request helpers (console/lib/api.ts and settings/lib.ts) call
 * begin/end around POST/PATCH/PUT/DELETE so the chrome can show Saving…
 * instead of looking idle while a slow write is still running.
 */

type Listener = (count: number) => void;

const listeners = new Set<Listener>();
let count = 0;

export function isConsoleMutationMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

export function beginConsoleMutation(): void {
  count += 1;
  for (const listener of listeners) listener(count);
}

export function endConsoleMutation(): void {
  count = Math.max(0, count - 1);
  for (const listener of listeners) listener(count);
}

export function consoleMutationBusyCount(): number {
  return count;
}

export function subscribeConsoleMutationBusy(listener: Listener): () => void {
  listeners.add(listener);
  listener(count);
  return () => {
    listeners.delete(listener);
  };
}
