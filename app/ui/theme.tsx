"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";
const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<{
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  toggle: () => void;
  set: (t: ThemeChoice) => void;
}>({
  theme: "light",
  resolvedTheme: "light",
  toggle: () => {},
  set: () => {}
});

export function readThemeChoice(stored: string | null): ThemeChoice {
  if (stored === "dark" || stored === "light" || stored === "system") return stored;
  return "light";
}

/** System follows the OS. An explicit light or dark choice ignores it.
 *  Missing storage stays light (owner ruling 2026-08-10). */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
}

/** One writer for both theme signals. `.dark` drives Tailwind `dark:` and the
 *  public tokens. `data-theme` drives the console. They are always the resolved
 *  light or dark value, including when the stored choice is system. */
export function applyDocumentTheme(doc: Document, resolved: ResolvedTheme): void {
  const root = doc.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  const nodes = doc.querySelectorAll(".console-root");
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]?.setAttribute("data-theme", resolved);
  }
  const color = resolved === "dark" ? "#0a0a0a" : "#f1f4f6";
  const metas = doc.querySelectorAll('meta[name="theme-color"]');
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    meta?.setAttribute("content", color);
    meta?.removeAttribute("media");
  }
}

/** Read storage, resolve system, and paint. A denied store falls back to light. */
export function syncDocumentTheme(
  doc: Document,
  readStored: () => string | null,
  systemPrefersDark: boolean
): { choice: ThemeChoice; resolved: ResolvedTheme } {
  try {
    const choice = readThemeChoice(readStored());
    const resolved = resolveTheme(choice, systemPrefersDark);
    applyDocumentTheme(doc, resolved);
    return { choice, resolved };
  } catch {
    applyDocumentTheme(doc, "light");
    return { choice: "light", resolved: "light" };
  }
}

/**
 * Runs before first paint. Keep it equivalent to syncDocumentTheme: same
 * storage key, same light default, same system resolution, and both signals
 * written together. test/theme-sync.test.ts evals this string.
 */
export const themeInitScript = `(function(){function paint(r){var root=document.documentElement;root.classList.toggle('dark',r==='dark');root.dataset.theme=r;var nodes=document.querySelectorAll('.console-root');for(var i=0;i<nodes.length;i++){nodes[i].setAttribute('data-theme',r);}var color=r==='dark'?'#0a0a0a':'#f1f4f6';var metas=document.querySelectorAll('meta[name="theme-color"]');for(var j=0;j<metas.length;j++){metas[j].setAttribute('content',color);metas[j].removeAttribute('media');}}try{var t=localStorage.getItem('theme');if(t!=='dark'&&t!=='light'&&t!=='system'){t='light';}var r=t==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;paint(r);}catch(e){paint('light');}})();`;

export function bindDocumentTheme(
  doc: Document,
  onChange: (next: { choice: ThemeChoice; resolved: ResolvedTheme }) => void
): () => void {
  const view = doc.defaultView;
  const apply = () => {
    try {
      const stored = view?.localStorage.getItem(THEME_STORAGE_KEY) ?? null;
      const systemDark = view?.matchMedia(COLOR_SCHEME_QUERY).matches ?? false;
      onChange(syncDocumentTheme(doc, () => stored, systemDark));
    } catch {
      applyDocumentTheme(doc, "light");
      onChange({ choice: "light", resolved: "light" });
    }
  };
  apply();
  let media: MediaQueryList | undefined;
  try {
    media = view?.matchMedia(COLOR_SCHEME_QUERY);
  } catch {
    media = undefined;
  }
  const listener = () => apply();
  media?.addEventListener("change", listener);
  return () => media?.removeEventListener("change", listener);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>("light");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  useLayoutEffect(() => {
    return bindDocumentTheme(document, (next) => {
      setThemeState(next.choice);
      setResolvedTheme(next.resolved);
    });
  }, []);

  const set = useCallback((next: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    let systemDark = false;
    try {
      systemDark = window.matchMedia(COLOR_SCHEME_QUERY).matches;
    } catch {
      systemDark = false;
    }
    const resolved = resolveTheme(next, systemDark);
    applyDocumentTheme(document, resolved);
    setThemeState(next);
    setResolvedTheme(resolved);
  }, []);

  const toggle = useCallback(
    () => set(theme === "light" ? "dark" : theme === "dark" ? "system" : "light"),
    [theme, set]
  );

  return <ThemeContext.Provider value={{ theme, resolvedTheme, toggle, set }}>{children}</ThemeContext.Provider>;
}

/** Public theme hook. Console chrome and ticker logos resolve through this
 *  so light, dark, and system stay on one resolver. Default remains light
 *  until the user picks Dark or System. */
export function useTheme() {
  return useContext(ThemeContext);
}
