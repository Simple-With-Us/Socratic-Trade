"use client";

import { useCallback, useEffect, useState } from "react";

/** Mirrors ConsoleFont's value set — see useConsoleFont.ts for why "site" and "lato" both exist. */
export type ConsoleTextBoxFont = "site" | "lato" | "system" | "serif" | "mono";

export interface ConsoleTextBoxFontOption {
  value: ConsoleTextBoxFont;
  label: string;
  description: string;
  fontFamily: string;
}

export const CONSOLE_TEXT_BOX_FONT_OPTIONS: ConsoleTextBoxFontOption[] = [
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

const STORAGE_KEY = "console:textBoxFont";
const CHANGE_EVENT = "console:textBoxFontChange";

function isConsoleTextBoxFont(value: unknown): value is ConsoleTextBoxFont {
  return CONSOLE_TEXT_BOX_FONT_OPTIONS.some((o) => o.value === value);
}

function readStored(): ConsoleTextBoxFont {
  if (typeof window === "undefined") return "site";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isConsoleTextBoxFont(stored) ? stored : "site";
  } catch {
    return "site";
  }
}

function store(next: ConsoleTextBoxFont) {
  try {
    if (next === "site") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode etc. - preference still applies for this session */
  }
}

export function useConsoleTextBoxFont(): {
  textBoxFont: ConsoleTextBoxFont;
  dataTextBoxFont: Exclude<ConsoleTextBoxFont, "site"> | undefined;
  setTextBoxFont: (next: ConsoleTextBoxFont) => void;
} {
  const [textBoxFont, setTextBoxFontState] = useState<ConsoleTextBoxFont>(readStored);

  useEffect(() => {
    function onChange(event: Event) {
      const next = (event as CustomEvent<ConsoleTextBoxFont>).detail;
      if (isConsoleTextBoxFont(next)) setTextBoxFontState(next);
    }
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setTextBoxFontState(readStored());
    }
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setTextBoxFont = useCallback((next: ConsoleTextBoxFont) => {
    setTextBoxFontState(next);
    store(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return {
    textBoxFont,
    dataTextBoxFont: textBoxFont === "site" ? undefined : textBoxFont,
    setTextBoxFont
  };
}
