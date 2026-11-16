"use client";

import { useCallback, useEffect, useState } from "react";

/** "site" is the stored value for "follow the site default", which IS Lato — it keeps that key
 *  (rather than being renamed) so preferences saved before Lato landed still resolve. "lato" is the
 *  same face pinned explicitly, so a later change to the site default leaves this choice alone. */
export type ConsoleFont = "site" | "lato" | "system" | "serif" | "mono";

export interface ConsoleFontOption {
  value: ConsoleFont;
  label: string;
  description: string;
  fontFamily: string;
}

export const CONSOLE_FONT_OPTIONS: ConsoleFontOption[] = [
  {
    value: "site",
    label: "Site",
    description: "Follow the Socratic Trade default, which is Lato today.",
    fontFamily: "var(--font-lato), ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
  },
  {
    value: "lato",
    label: "Lato",
    description: "Pin the humanist sans the iOS app and site share, whatever the default becomes.",
    fontFamily: "var(--font-lato), ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
  },
  {
    value: "system",
    label: "System",
    description: "Use the operating system UI font for denser editable text.",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
  },
  {
    value: "serif",
    label: "Serif",
    description: "Use a book-style serif for long strategy prose.",
    fontFamily: "Georgia, \"Times New Roman\", serif"
  },
  {
    value: "mono",
    label: "Mono",
    description: "Use the previous fixed-width prompt style.",
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, monospace"
  }
];

const STORAGE_KEY = "console:consoleFont";
const CHANGE_EVENT = "console:consoleFontChange";

function isConsoleFont(value: unknown): value is ConsoleFont {
  return CONSOLE_FONT_OPTIONS.some((o) => o.value === value);
}

function readStored(): ConsoleFont {
  if (typeof window === "undefined") return "site";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isConsoleFont(stored) ? stored : "site";
  } catch {
    return "site";
  }
}

function store(next: ConsoleFont) {
  try {
    if (next === "site") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode etc. - preference still applies for this session */
  }
}

export function useConsoleFont(): {
  consoleFont: ConsoleFont;
  dataConsoleFont: Exclude<ConsoleFont, "site"> | undefined;
  setConsoleFont: (next: ConsoleFont) => void;
} {
  const [consoleFont, setConsoleFontState] = useState<ConsoleFont>(readStored);

  useEffect(() => {
    function onChange(event: Event) {
      const next = (event as CustomEvent<ConsoleFont>).detail;
      if (isConsoleFont(next)) setConsoleFontState(next);
    }
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setConsoleFontState(readStored());
    }
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setConsoleFont = useCallback((next: ConsoleFont) => {
    setConsoleFontState(next);
    store(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return {
    consoleFont,
    dataConsoleFont: consoleFont === "site" ? undefined : consoleFont,
    setConsoleFont
  };
}
