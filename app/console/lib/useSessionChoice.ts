"use client";

import { useMemo, useSyncExternalStore } from "react";
import { createSessionChoiceStore } from "./session-choice";

// Keep choices constant at the caller so this store is stable across renders.
export function useSessionChoice<T extends string>(key: string | null, choices: readonly T[], defaultValue: T): [T, (value: T) => void] {
  const store = useMemo(() => createSessionChoiceStore({
    key, choices, defaultValue,
    storage: () => window.sessionStorage,
    // Server rendering only calls getServerSnapshot, never subscribe or storage.
    events: typeof window === "undefined" ? new EventTarget() : window
  }), [key, choices, defaultValue]);
  return [useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot), store.set];
}
