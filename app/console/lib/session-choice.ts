/** Persist only an opaque connected-account identity, never brokerage account numbers. */
export function scanTabChoiceKey(account: { id: string } | undefined): string | null {
  return account?.id ? `console:scan:tab:${account.id}` : null;
}

/** A single validated session-only UI choice. No credentials or account data are stored. */
export function createSessionChoiceStore<T extends string>(options: {
  key: string | null;
  choices: readonly T[];
  defaultValue: T;
  storage: () => Pick<Storage, "getItem" | "setItem">;
  events: EventTarget;
}) {
  const { key, choices, defaultValue, storage, events } = options;
  if (!choices.includes(defaultValue)) throw new Error("Default session choice must be allowed");
  const eventName = `st:session-choice:${key ?? "unscoped"}`;
  let fallback: T | undefined;
  const getSnapshot = (): T => {
    if (fallback !== undefined) return fallback;
    if (key === null) return defaultValue;
    try {
      const stored = storage().getItem(key);
      return choices.find((choice) => choice === stored) ?? defaultValue;
    } catch {
      return defaultValue;
    }
  };
  const subscribe = (notify: () => void) => {
    const changed = (event: Event) => {
      if (event.type === "storage") {
        const changedKey = (event as StorageEvent).key;
        if (changedKey !== null && changedKey !== key) return;
        fallback = undefined;
      }
      notify();
    };
    events.addEventListener(eventName, changed);
    events.addEventListener("storage", changed);
    return () => {
      events.removeEventListener(eventName, changed);
      events.removeEventListener("storage", changed);
    };
  };
  const set = (value: T) => {
    if (!choices.includes(value)) return;
    fallback = undefined;
    try {
      if (key === null) fallback = value;
      else storage().setItem(key, value);
    } catch {
      // A blocked/full session store must not break tab switching in this mounted view.
      fallback = value;
    }
    events.dispatchEvent(new Event(eventName));
  };
  return { getSnapshot, getServerSnapshot: () => defaultValue, subscribe, set };
}
