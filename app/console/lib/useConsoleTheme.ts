"use client";

/** Console-scoped theme resolution: system preference by default, with an
 *  explicit choice persisted in localStorage under a console-scoped key and
 *  applied via data-theme on the console root — so it can never clash with
 *  the legacy app's theming (.dark class on <html>). */

import { useCallback, useState } from "react";

export type ConsoleTheme = "system" | "light" | "dark";

const STORAGE_KEY = "console:theme";

function readStored(): ConsoleTheme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function useConsoleTheme(): {
  theme: ConsoleTheme;
  /** Value for the console root's data-theme attribute (undefined = follow system). */
  dataTheme: "light" | "dark" | undefined;
  cycle: () => void;
} {
  const [theme, setTheme] = useState<ConsoleTheme>(readStored);

  const cycle = useCallback(() => {
    setTheme((prev) => {
      const next: ConsoleTheme = prev === "system" ? "dark" : prev === "dark" ? "light" : "system";
      try {
        if (next === "system") window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode etc. — theme still applies for this session */
      }
      return next;
    });
  }, []);

  return { theme, dataTheme: theme === "system" ? undefined : theme, cycle };
}
