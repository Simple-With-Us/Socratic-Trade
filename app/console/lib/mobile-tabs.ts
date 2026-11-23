"use client";

/** Persisted, user-customizable mobile bottom-tab selection (P3 owner
 *  feedback: "tapping a bottom tab shows nothing" led into the bigger ask —
 *  let the owner pick which destinations live in the thumb-reach bar).
 *
 *  THE CAPACITY RULES ARE PORTED FROM THE NATIVE APP (ST-4645 / audit W4).
 *
 *  The web bar used to be hard-capped at four tabs no matter how wide the
 *  window was, while the native app's `TabBarCapacity` adapts to the window
 *  (ios/SocraticTrade/MobileControlView.swift:114-125) — so on a phone, Scan,
 *  Coach, Guardrails and Connections were always behind More. The native rules
 *  are reproduced here, in order:
 *
 *   1. **Width decides how many slots exist.** `tabBarCapacity` turns the
 *      measured bar width into a slot count; one slot is always reserved for
 *      "More", which absorbs everything that does not fit.
 *   2. **Too narrow for the owner's choice → fall back to the defaults.**
 *      The stored choice is left untouched, so widening the window restores
 *      it (native: `TabPreferences.resolve`).
 *   3. **Before the owner expresses a preference the bar AUTO-FILLS** to
 *      whatever fits: the owner-decided defaults first, then the remaining
 *      destinations in canonical order (native: `TabPreferences.autoFill`).
 *
 *  Not ported: the native "borrowed slot" (opening a screen from More lends it
 *  the slot before More) and "Home is chrome, never toggleable" — both are
 *  native-window behaviours with no web equivalent today, and neither is
 *  needed for the slot math.
 *
 *  SSR-safe by construction: the hook's initial state is always the same on
 *  the server and on the first client render (the width is not knowable
 *  during SSR), so there is no hydration mismatch. The real, possibly-
 *  customized selection is read from localStorage in an effect and swapped in
 *  after mount. Unknown/stale hrefs (a destination renamed or removed since
 *  the value was saved) are dropped silently rather than surfaced as an error. */

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "console.mobileTabs.v1";

export const MOBILE_TABS_MIN = 2;

/** Ceiling on what can be PINNED (mirrors the native `TabPreferences.maxTabs`).
 *  What actually RENDERS is bounded by the capacity — see `tabBarCapacity`. */
export const MOBILE_TABS_MAX = 8;

/** The narrowest a tab may get before it stops being a legible, thumb-friendly
 *  target. 390px / 64 = 6 slots, one of which is "More", so a phone shows FIVE
 *  destinations beside More — the same count the native bar shows at that
 *  width (its compact bar shows four, and the brief for this port asked for
 *  five at >=390px). */
export const MOBILE_TAB_SLOT_MIN_PX = 64;

/** The capacity used until the bar has been measured (server render and the
 *  first client render must agree, or React reports a hydration mismatch). */
export const DEFAULT_MOBILE_TAB_CAPACITY = 4;

/** Owner-decided default pins (stored by href, not label — renames are safe):
 *  Home, Proposals, Activity, Orders. */
export const DEFAULT_MOBILE_TAB_HREFS: readonly string[] = [
  "/console",
  "/console/approvals",
  "/console/activity",
  "/console/orders"
];

/** How many destinations fit beside "More" at a given bar width.
 *
 *  Pure math, kept out of the view so it can be unit-tested without a DOM —
 *  the same split the native `TabBarCapacity` keeps for its XCTest. */
export function tabBarCapacity(availableWidthPx: number): number {
  if (!Number.isFinite(availableWidthPx) || availableWidthPx <= 0) return MOBILE_TABS_MIN;
  // One slot is reserved for the "More" button, which absorbs the rest.
  const slots = Math.floor(availableWidthPx / MOBILE_TAB_SLOT_MIN_PX) - 1;
  return Math.max(MOBILE_TABS_MIN, Math.min(MOBILE_TABS_MAX, slots));
}

/** The most tabs that may be PINNED at a given capacity (native: `pinLimit`). */
export function mobileTabPinLimit(capacity: number): number {
  if (!Number.isFinite(capacity)) return MOBILE_TABS_MIN;
  return Math.max(MOBILE_TABS_MIN, Math.min(MOBILE_TABS_MAX, Math.floor(capacity)));
}

/** The membership the bar shows when the owner has NOT expressed a preference:
 *  the owner-decided defaults first, then the remaining destinations in
 *  canonical order, cut to what fits. */
export function autoFillMobileTabs(
  allHrefs: readonly string[],
  defaults: readonly string[],
  capacity: number
): string[] {
  const slots = mobileTabPinLimit(capacity);
  const rest = allHrefs.filter((href) => !defaults.includes(href));
  return [...defaults, ...rest].slice(0, slots);
}

/** The membership the bar shows for a chosen set: the owner's picks, trimmed to
 *  what fits — falling back to the defaults when their set does not fit (and
 *  leaving the stored choice alone, so widening restores it). */
export function resolveMobileTabs(
  chosen: readonly string[],
  defaults: readonly string[],
  capacity: number
): string[] {
  const slots = mobileTabPinLimit(capacity);
  const base = chosen.length > slots ? defaults : chosen;
  return base.slice(0, slots);
}

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
  /** Hrefs of the destinations the bar shows right now, in bar order. */
  tabHrefs: string[];
  /** False until the client has read localStorage; callers can use this to
   *  avoid flashing a "changed" state, though the default is stable either way. */
  mounted: boolean;
  /** True when the owner has expressed a preference. Until then the bar
   *  auto-fills to whatever the width fits (native: `hasCustomSelection`). */
  hasCustomSelection: boolean;
  /** True if this href could be pinned/unpinned right now (i.e. the action
   *  would not violate the min/max bound). Used to disable the pin control. */
  isPinned: (href: string) => boolean;
  canToggle: (href: string) => boolean;
  togglePin: (href: string) => void;
  /** The most tabs that may be pinned at the current width. */
  pinLimit: number;
}

/** @param validHrefs Every href a stored selection is allowed to reference —
 *  pass the full destination list so stale entries get dropped.
 *  @param capacity How many destinations fit beside "More" at the current
 *  width — see `tabBarCapacity`. */
export function useMobileTabs(validHrefs: readonly string[], capacity: number): MobileTabsState {
  const validKey = validHrefs.join("|");
  const [mounted, setMounted] = useState(false);
  // `null` until the stored selection has been read (and stays null when the
  // owner has never chosen one) — that is the "auto-fill" state.
  const [stored, setStored] = useState<string[] | null>(null);

  useEffect(() => {
    const validSet = new Set(validHrefs);
    const storedValue = readStored(validSet);
    setStored(storedValue);
    setMounted(true);
    // validKey is the stable dependency; validHrefs itself is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);

  const pinLimit = mobileTabPinLimit(capacity);

  const defaults = useMemo(
    () => DEFAULT_MOBILE_TAB_HREFS.filter((href) => validHrefs.includes(href)),
    // validKey stands in for validHrefs (a fresh array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [validKey]
  );

  // The PIN set: the owner's stored choice, or the auto-filled membership when
  // they have never chosen one (native: `pinned`).
  const pinned = useMemo(
    () => stored ?? autoFillMobileTabs(validHrefs, defaults, capacity),
    // validKey stands in for validHrefs (a fresh array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, defaults, capacity, validKey]
  );

  // What the BAR renders: the pinned set in canonical destination order,
  // trimmed to what fits — falling back to the defaults when the owner's
  // choice does not fit (their stored choice is left untouched, so widening
  // the window restores it).
  const tabHrefs = useMemo(() => {
    if (stored === null) {
      // Auto-fill keeps the owner-decided defaults in their own order first
      // (Home, Proposals, Activity, Orders) and then the remaining
      // destinations in canonical order — so the defaults the owner already
      // chose stay exactly where they were.
      return autoFillMobileTabs(validHrefs, defaults, capacity);
    }
    const slots = mobileTabPinLimit(capacity);
    const canonical = validHrefs.filter((href) => stored.includes(href));
    const base = canonical.length > slots ? defaults : canonical;
    return base.slice(0, slots);
    // validKey stands in for validHrefs (a fresh array every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, defaults, capacity, validKey]);

  const togglePin = useCallback(
    (href: string) => {
      setStored((current) => {
        // The first touch takes the bar over: it starts from what is on it now
        // (the auto-filled membership) and adds or removes this destination.
        const base = current ?? pinned;
        const pinnedNow = base.includes(href);
        if (pinnedNow) {
          if (base.length <= MOBILE_TABS_MIN) return base;
          const next = base.filter((h) => h !== href);
          writeStored(next);
          return next;
        }
        if (base.length >= MOBILE_TABS_MAX) return base;
        const next = [...base, href];
        writeStored(next);
        return next;
      });
    },
    [pinned]
  );

  const isPinned = useCallback((href: string) => pinned.includes(href), [pinned]);
  const canToggle = useCallback(
    (href: string) =>
      pinned.includes(href) ? pinned.length > MOBILE_TABS_MIN : pinned.length < pinLimit,
    [pinned, pinLimit]
  );

  return {
    tabHrefs,
    mounted,
    hasCustomSelection: stored !== null,
    isPinned,
    canToggle,
    togglePin,
    pinLimit
  };
}
