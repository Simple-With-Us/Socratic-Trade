"use client";

/** Tracks a CSS media query from React.
 *
 *  Used where a surface must NOT be mounted at the wrong width — the CSS
 *  `hidden lg:block` / `lg:hidden` trick hides a twin tree but keeps BOTH
 *  trees in the DOM, which is how a 250-symbol scan used to mount 250 phone
 *  cards AND the whole virtualized desktop table at the same time (audit #2).
 *  Gating the render in JavaScript mounts only the tree that applies.
 *
 *  The first render answers with `initial`, and the real value lands in a
 *  LAYOUT effect, so the swap happens before the browser paints — no flash of
 *  the wrong layout. `initial` is `true` (desktop) by default because the
 *  desktop tree is the cheap one: the scan table is virtualized, while the
 *  phone card list is a plain map. Nothing in the console is server-rendered
 *  with a snapshot (the shell shows its load screen until the first fetch
 *  lands), so there is no hydration mismatch to worry about. */

import { useEffect, useLayoutEffect, useState } from "react";

/** `useLayoutEffect` warns during SSR; on the server there is no layout to
 *  measure anyway, so fall back to `useEffect` there. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(initial);
  useIsomorphicLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    // Safari < 14 and older Edge.
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, [query]);
  return matches;
}

/** Tailwind's `lg` breakpoint (1024px) and up — the desktop console layout,
 *  where the left rail replaces the phone tab bar.
 *
 *  Defaults to `true` so the first render mounts the (virtualized, cheap)
 *  desktop tree; the layout effect corrects it before the first paint. */
export function useIsDesktopConsole(): boolean {
  return useMediaQuery("(min-width: 1024px)", true);
}
