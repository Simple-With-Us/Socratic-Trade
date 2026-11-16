"use client";

import { useTheme } from "../../ui/theme";

export type ConsoleTheme = "system" | "light" | "dark";

export function useConsoleTheme(): {
  theme: ConsoleTheme;
  /** Resolved light or dark. Same value written to `<html>` by applyDocumentTheme. */
  dataTheme: "light" | "dark";
  cycle: () => void;
  set: (next: ConsoleTheme) => void;
} {
  const { theme, resolvedTheme, toggle, set } = useTheme();

  return {
    theme,
    dataTheme: resolvedTheme,
    cycle: toggle,
    set,
  };
}
