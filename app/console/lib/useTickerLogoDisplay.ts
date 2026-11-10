"use client";

import { useCallback, useEffect, useState } from "react";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { DEFAULT_TICKER_LOGO_DISPLAY, isTickerLogoDisplay } from "@/lib/ticker-logos";

const STORAGE_KEY = "console:tickerLogoDisplay";
const CHANGE_EVENT = "console:tickerLogoDisplayChange";

function readStored(): TickerLogoDisplay {
  if (typeof window === "undefined") return DEFAULT_TICKER_LOGO_DISPLAY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isTickerLogoDisplay(raw) ? raw : DEFAULT_TICKER_LOGO_DISPLAY;
  } catch {
    return DEFAULT_TICKER_LOGO_DISPLAY;
  }
}

export function useTickerLogoDisplay(): {
  tickerLogoDisplay: TickerLogoDisplay;
  setTickerLogoDisplay: (next: TickerLogoDisplay) => void;
} {
  const [display, setDisplayState] = useState<TickerLogoDisplay>(DEFAULT_TICKER_LOGO_DISPLAY);

  useEffect(() => {
    setDisplayState(readStored());
    const sync = () => setDisplayState(readStored());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setTickerLogoDisplay = useCallback((next: TickerLogoDisplay) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* best-effort */
    }
    setDisplayState(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { tickerLogoDisplay: display, setTickerLogoDisplay };
}
