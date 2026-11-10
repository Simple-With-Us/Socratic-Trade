"use client";

/** Persisted, user-customizable mobile bottom-tab selection (P3 owner
 *  feedback: "tapping a bottom tab shows nothing" led into the bigger ask —
 *  let the owner pick which destinations live in the thumb-reach bar).
 *
 *  SSR-safe by construction: the hook's initial state is always
 *  DEFAULT_MOBILE_TAB_HREFS (same on server and first client render), so
 *  there is no hydration mismatch. The real, possibly-customized selection
 *  is read from localStorage in an effect and swapped in after mount.
 *  Unknown/stale hrefs (a destination renamed or removed since the value was
 *  saved) are dropped silently rather than surfaced as an error. */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "console.mobileTabs.v1";

export const MOBILE_TABS_MIN = 2;
export const MOBILE_TABS_MAX = 4;

/** Owner-decided default pins (stored by href, not label — renames are safe):
 *  Home, Proposals, Activity, Orders. */
export const DEFAULT_MOBILE_TAB_HREFS: readonly string[] = [
  "/console",
  "/console/approvals",
  "/console/activity",
  "/console/orders"
];

function readStored(validHrefs: ReadonlySet<string>): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.filter((href): href is string => typeof href === "string" && validHrefs.has(href));
    if (cleaned.length < MOBILE_TABS_MIN) return null;
    return cleaned.slice(0, MOBILE_TABS_MAX);
  } catch {
    return null;
  }
}

function writeStored(hrefs: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(hrefs));
  } catch {
    // Private-mode / quota errors: the selection just won't persist this session.
  }
}

export interface MobileTabsState {
  /** Hrefs of the destinations currently pinned to the bottom bar. Order is
   *  not meaningful here — callers render tabs in canonical destination
   *  order, this is a membership set. */
  tabHrefs: string[];
  /** False until the client has read localStorage; callers can use this to
   *  avoid flashing a "changed" state, though the default is stable either way. */
  mounted: boolean;
  isPinned: (href: string) => boolean;
  /** True if this href could be pinned/unpinned right now (i.e. the action
   *  would not violate the min/max bound). Used to disable the pin control. */
  canToggle: (href: string) => boolean;
  togglePin: (href: string) => void;
}

/** @param validHrefs Every href a stored selection is allowed to reference —
 *  pass the full destination list so stale entries get dropped. */
export function useMobileTabs(validHrefs: readonly string[]): MobileTabsState {
  const validKey = validHrefs.join("|");
  const [mounted, setMounted] = useState(false);
  const [hrefs, setHrefs] = useState<string[]>(() => [...DEFAULT_MOBILE_TAB_HREFS]);

  useEffect(() => {
    const validSet = new Set(validHrefs);
    const stored = readStored(validSet);
    setHrefs(stored ?? DEFAULT_MOBILE_TAB_HREFS.filter((href) => validSet.has(href)));
    setMounted(true);
    // validKey is the stable dependency; validHrefs itself is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);

  const togglePin = useCallback(
    (href: string) => {
      setHrefs((current) => {
        const pinned = current.includes(href);
        if (pinned) {
          if (current.length <= MOBILE_TABS_MIN) return current;
          const next = current.filter((h) => h !== href);
          writeStored(next);
          return next;
        }
        if (current.length >= MOBILE_TABS_MAX) return current;
        const next = [...current, href];
        writeStored(next);
        return next;
      });
    },
    []
  );

  const isPinned = useCallback((href: string) => hrefs.includes(href), [hrefs]);
  const canToggle = useCallback(
    (href: string) => (hrefs.includes(href) ? hrefs.length > MOBILE_TABS_MIN : hrefs.length < MOBILE_TABS_MAX),
    [hrefs]
  );

  return { tabHrefs: hrefs, mounted, isPinned, canToggle, togglePin };
}
