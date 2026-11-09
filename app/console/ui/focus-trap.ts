"use client";

/** Shared modal focus trap for console dialog surfaces.
 *
 *  Every `role="dialog" aria-modal="true"` surface has to do four things or it is worse
 *  than no trap at all — a half-trap strands keyboard users: (1) move focus into the
 *  dialog when it opens, (2) cycle Tab / Shift+Tab inside it, (3) close on Escape when
 *  the surface is dismissible, and (4) put focus back on the element that opened it.
 *  `useFocusTrap` does all four; `Sheet`, nav `TabsSheet`, the scan Columns popover,
 *  `SymbolDrawerHost`, `ConsentGate`, and `CommandPalette` all use it.
 *
 *  Surfaces stack (an `EvidenceCard` inside a `<Sheet>` opens the symbol drawer; Cmd+K
 *  can open the palette over either). Only the TOPMOST trap acts: traps register on a
 *  module-level stack in mount order, and a trap that is no longer on top ignores Tab,
 *  Escape, and focus policing. Escape therefore closes only the surface the user is
 *  looking at (#2561).
 *
 *  The sentry re-focuses the last element THIS trap deliberately focused, not
 *  `focusables[0]`. Handlers run in registration order, so a lower surface that still
 *  has a leftover listener cannot pin focus to the first element forever.
 *
 *  Nothing here calls `stopPropagation`. Swallowing keydown/focusin at the window would
 *  also swallow it for React's delegated `onKeyDown`/`onFocus` handlers inside the dialog
 *  (React attaches those at the root container, below `window` in the propagation path),
 *  which breaks widgets the dialog contains. Running last and correcting is enough. */

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Hard stop for a focus fight. Our sentry only re-focuses in response to focus leaving the
 *  container, and a well-behaved page settles in two or three exchanges (see the sheet
 *  interaction above), so a burst larger than this means some other listener is pulling
 *  focus back out every time we pull it in. Losing the trap for one task is bad; wedging
 *  the tab in an infinite synchronous loop is unrecoverable. The counter resets on a
 *  microtask, i.e. once the whole synchronous exchange has unwound. */
const MAX_FOCUS_CORRECTIONS_PER_TASK = 12;

/** Focusable descendants in DOM order. Hidden elements are excluded — `focus()` on a
 *  `display:none` element silently does nothing, which would make Tab look dead when a
 *  dialog holds a collapsed section. */
export function getTrapFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0
  );
}

function focusNode(el: HTMLElement | null) {
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

/** Where Tab / Shift+Tab should land next, as a pure function of the focusable list.
 *
 *  Unlike `nextSheetFocusTarget` (sheet.tsx), which returns `null` in the middle of the
 *  list and lets the browser's native Tab handle it, this always names a target. A sheet
 *  underneath us has already called `preventDefault()` by the time we run, so "let the
 *  browser do it" is not available: if we don't move focus ourselves, Tab does nothing at
 *  all. `active` is the element focus started on, and is null when focus began outside the
 *  container (a stray focus, or the very first Tab after opening). */
export function nextTrapFocusTarget<T>(focusables: T[], active: T | null, container: T, shiftKey: boolean): T {
  if (focusables.length === 0) return container;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  const index = active === null ? -1 : focusables.indexOf(active);
  if (index === -1) return shiftKey ? last : first;

  const next = shiftKey ? index - 1 : index + 1;
  if (next < 0) return last;
  if (next >= focusables.length) return first;
  return focusables[next];
}

export interface FocusTrapHandle {
  /** True for a surface the user cannot dismiss (the consent gate). Lets other console
   *  chrome refuse to open on top of it — see `hasBlockingFocusTrap`. */
  readonly blocking: boolean;
}

/** Mount order of the live traps; the last entry is the surface on top. */
const trapStack: FocusTrapHandle[] = [];

export function pushFocusTrap(handle: FocusTrapHandle): FocusTrapHandle {
  trapStack.push(handle);
  return handle;
}

export function releaseFocusTrap(handle: FocusTrapHandle): void {
  const index = trapStack.lastIndexOf(handle);
  if (index >= 0) trapStack.splice(index, 1);
}

export function isTopmostFocusTrap(handle: FocusTrapHandle): boolean {
  return trapStack.length > 0 && trapStack[trapStack.length - 1] === handle;
}

/** True while a non-dismissible surface is open. The consent gate claims to block the
 *  console until it is answered; without this, Cmd+K would still open the palette over it
 *  and navigate away, so the claim would be false. */
export function hasBlockingFocusTrap(): boolean {
  return trapStack.some((trap) => trap.blocking);
}

export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
  options?: {
    /** Omit for a surface that must not be dismissible. */
    onEscape?: () => void;
    blocking?: boolean;
  }
): void {
  // Keep the latest options without making them a dependency of the trap effect below.
  // Callers pass an inline arrow (`() => setOpen(false)`) that is a new reference every
  // render, so a dependency on it would re-run the effect on every parent re-render —
  // including on each keystroke in a text field inside the dialog — and re-focus the first
  // focusable, yanking the caret out of the input. Sheet hit that when its trap depended
  // on `onClose`; the effect below depends only on `active`.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const opener =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement
        ? document.activeElement
        : null;

    const handle = pushFocusTrap({ blocking: optionsRef.current?.blocking === true });

    // The element this trap last put focus on. The sentry restores THIS rather than the
    // first focusable, so correcting after a lower surface's sentry does not reset the
    // user's position in the tab order.
    let lastFocused: HTMLElement | null = null;
    const focusInsideTrap = (el: HTMLElement | null) => {
      if (!el) return;
      lastFocused = el;
      focusNode(el);
    };

    // Recorded in the capture phase, before any other window listener can move focus, so
    // the Tab target is computed from where focus actually started.
    let activeOnKeyDown: Element | null = null;
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key === "Tab") activeOnKeyDown = document.activeElement;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopmostFocusTrap(handle)) return;
      const el = containerRef.current;
      if (!el || !el.isConnected) return;

      if (e.key === "Escape") {
        const onEscape = optionsRef.current?.onEscape;
        if (!onEscape) return;
        e.preventDefault();
        onEscape();
        return;
      }

      if (e.key !== "Tab") return;
      const started = activeOnKeyDown instanceof HTMLElement ? activeOnKeyDown : null;
      const from = started && el.contains(started) ? started : null;
      const focusables = getTrapFocusables(el);
      e.preventDefault();
      focusInsideTrap(nextTrapFocusTarget(focusables, from, el, e.shiftKey));
    };

    let corrections = 0;
    let resetQueued = false;
    const onFocusIn = (e: FocusEvent) => {
      if (!isTopmostFocusTrap(handle)) return;
      const el = containerRef.current;
      if (!el || !el.isConnected) return;

      if (e.target instanceof Node && el.contains(e.target)) {
        // A legitimate move inside the dialog (a click, or a lower sentry's handiwork we
        // already corrected) — remember it as the position to restore to.
        if (e.target instanceof HTMLElement) lastFocused = e.target;
        return;
      }

      if (corrections >= MAX_FOCUS_CORRECTIONS_PER_TASK) return;
      corrections += 1;
      if (!resetQueued) {
        resetQueued = true;
        queueMicrotask(() => {
          corrections = 0;
          resetQueued = false;
        });
      }

      const restore = lastFocused && lastFocused.isConnected && el.contains(lastFocused) ? lastFocused : null;
      focusInsideTrap(restore ?? getTrapFocusables(el)[0] ?? el);
    };

    // Listeners go up before the initial focus so a sentry belonging to a surface
    // underneath us cannot steal that first focus uncontested.
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);

    focusInsideTrap(getTrapFocusables(container)[0] ?? container);

    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      // Only the surface on top owns focus. A trap that closes from underneath another one
      // must not drag focus out of the dialog the user is actually looking at.
      const wasTopmost = isTopmostFocusTrap(handle);
      releaseFocusTrap(handle);
      if (wasTopmost && opener && opener.isConnected) focusNode(opener);
    };
  }, [active, containerRef]);
}
