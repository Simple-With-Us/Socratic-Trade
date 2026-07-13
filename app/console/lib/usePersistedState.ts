"use client";

import { useEffect, useState } from "react";

export function usePersistedState<T extends string>(key: string, defaultValue: T): [T, (val: T) => void] {
  const [val, setVal] = useState<T>(defaultValue);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored) {
        setVal(stored as T);
      }
    } catch {
      // ignore
    }
  }, [key]);

  const updateVal = (newVal: T) => {
    setVal(newVal);
    try {
      window.sessionStorage.setItem(key, newVal);
    } catch {
      // ignore
    }
  };

  return [val, updateVal];
}
