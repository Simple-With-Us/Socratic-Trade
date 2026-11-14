"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

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

/** Browser-chrome colors. Dark is #0a0a0a on every surface. Light is
 *  surface-specific: console/admin `--con-bg` (#f1f4f6) vs the public root
 *  layout's declared `themeColor` (#ffffff). Keep in lockstep with
 *  app/layout.tsx, app/console/layout.tsx and console.css. */
export const THEME_COLOR_DARK = "#0a0a0a";
export const THEME_COLOR_LIGHT_CONSOLE = "#f1f4f6";
export const THEME_COLOR_LIGHT_PUBLIC = "#ffffff";
const CONSOLE_PATH = /^\/(console|admin)(\/|$)/;

/** Light chrome color for the current surface. The boot script runs in <head>
 *  before `.console-root` exists, so the pathname is checked as well. */
export function themeColorFor(doc: Document, resolved: ResolvedTheme): string {
  if (resolved === "dark") return THEME_COLOR_DARK;
  const consoleSurface =
    doc.querySelectorAll(".console-root").length > 0 || CONSOLE_PATH.test(doc.location?.pathname ?? "");
  return consoleSurface ? THEME_COLOR_LIGHT_CONSOLE : THEME_COLOR_LIGHT_PUBLIC;
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
  const color = themeColorFor(doc, resolved);
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
export const themeInitScript = `(function(){function paint(r){var root=document.documentElement;root.classList.toggle('dark',r==='dark');root.dataset.theme=r;var nodes=document.querySelectorAll('.console-root');for(var i=0;i<nodes.length;i++){nodes[i].setAttribute('data-theme',r);}var p=(document.location&&document.location.pathname)||'';var con=nodes.length>0||/^\\/(console|admin)(\\/|$)/.test(p);var color=r==='dark'?'#0a0a0a':(con?'#f1f4f6':'#ffffff');var metas=document.querySelectorAll('meta[name="theme-color"]');for(var j=0;j<metas.length;j++){metas[j].setAttribute('content',color);metas[j].removeAttribute('media');}}try{var t=localStorage.getItem('theme');if(t!=='dark'&&t!=='light'&&t!=='system'){t='light';}var r=t==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;paint(r);}catch(e){paint('light');}})();`;

/**
 * `remembered` is this session's pick when it could not be saved.  It wins
 * over storage, so a system change does not undo a pick that a readable but
 * unwritable store (quota, write-blocked) still holds a stale value for.
 */
export function bindDocumentTheme(
  doc: Document,
  onChange: (next: { choice: ThemeChoice; resolved: ResolvedTheme }) => void,
  remembered: () => ThemeChoice | null = () => null
): () => void {
  const view = doc.defaultView;
  const apply = () => {
    let stored: string | null = remembered();
    if (stored === null) {
      try {
        stored = view?.localStorage.getItem(THEME_STORAGE_KEY) ?? null;
      } catch {
        stored = null;
      }
    }
    let systemDark = false;
    try {
      systemDark = view?.matchMedia(COLOR_SCHEME_QUERY).matches ?? false;
    } catch {
      systemDark = false;
    }
    onChange(syncDocumentTheme(doc, () => stored, systemDark));
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
  // Set only while this session's pick is unsaved (the write threw).
  const unsavedRef = useRef<ThemeChoice | null>(null);
  const resolvedRef = useRef<ResolvedTheme>("light");
  const pathname = usePathname();

  useLayoutEffect(() => {
    return bindDocumentTheme(
      document,
      (next) => {
        resolvedRef.current = next.resolved;
        setThemeState(next.choice);
        setResolvedTheme(next.resolved);
      },
      () => unsavedRef.current
    );
  }, []);

  // Client navigation re-renders the segment's static viewport themeColor
  // (#ffffff public, #f1f4f6 console), which would undo a dark pick. Repaint
  // after each route change. The first run repeats bind's paint and is harmless.
  useLayoutEffect(() => {
    applyDocumentTheme(document, resolvedRef.current);
  }, [pathname]);

  const set = useCallback((next: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
      unsavedRef.current = null;
    } catch {
      unsavedRef.current = next;
    }
    let systemDark = false;
    try {
      systemDark = window.matchMedia(COLOR_SCHEME_QUERY).matches;
    } catch {
      systemDark = false;
    }
    const resolved = resolveTheme(next, systemDark);
    resolvedRef.current = resolved;
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
