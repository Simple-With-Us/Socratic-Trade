"use client";

/** Fixed positioning + portal target for header dropdown panels (ST-4544).
 *
 *  The console header bar (shell.tsx ChromeBar) is `overflow-x: auto` as a
 *  320px-width guard. Per CSS, that makes its computed `overflow-y` `auto`
 *  too, so any absolutely positioned dropdown inside the bar is clipped to
 *  the bar's ~46px height: the menu state opens, but the panel never shows
 *  (verified in WebKit and Chromium — hit-testing at the panel center lands
 *  on the click-away backdrop). Rendering the panel in a portal with
 *  `position: fixed` anchored to the trigger's rect escapes the scroll
 *  container entirely, in every browser.
 *
 *  Portal target matters: every `--con-*` theme variable is scoped to
 *  `.console-root` (console.css), so a panel portaled to <body> renders
 *  without its surface/text colors (same trap ToastProvider documents in
 *  shell.tsx). The hook therefore resolves the container from the trigger —
 *  its own `.console-root`, falling back to <body> outside the console.
 *
 *  Returns `{ style, container }`, both empty while closed or before the
 *  first measurement, so callers render the panel only when both exist.
 *  The first measurement is synchronous in the effect (no frame where the
 *  backdrop exists without the panel); later updates are rAF-throttled and
 *  skipped when the computed position is unchanged, so scrolling inside a
 *  panel's own list does not churn renders. Closing resets the measurement,
 *  so a reopen never flashes the previous position. */

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export interface AnchoredMenu {
  style: CSSProperties | undefined;
  container: Element | null;
}

const CLOSED: AnchoredMenu = { style: undefined, container: null };

/** Pure geometry: the fixed top/left for a panel of the given width under a
 *  trigger rect, clamped to an 8px viewport margin on both sides. */
export function anchoredMenuPosition(
  rect: { left: number; right: number; bottom: number },
  viewportWidth: number,
  opts: { align: "left" | "right"; width: number; gap?: number }
): { top: number; left: number } {
  const gap = opts.gap ?? 4;
  const w = Math.min(opts.width, Math.max(0, viewportWidth - 16));
  const desired = opts.align === "left" ? rect.left : rect.right - w;
  const left = Math.max(8, Math.min(desired, Math.max(8, viewportWidth - w - 8)));
  return { top: Math.round(rect.bottom + gap), left: Math.round(left) };
}

export function useAnchoredMenu(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  opts: { align: "left" | "right"; width: number; gap?: number }
): AnchoredMenu {
  const { align, width, gap = 4 } = opts;
  const [measured, setMeasured] = useState<AnchoredMenu>(CLOSED);

  useEffect(() => {
    if (!open) {
      // Drop the last measurement on close, so a reopen cannot paint one
      // frame at the previous open's stale coordinates if the trigger moved
      // (or the viewport resized) while closed. CLOSED is module-level, so
      // React bails out when nothing changed.
      setMeasured(CLOSED);
      return;
    }
    let raf = 0;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const { top, left } = anchoredMenuPosition(el.getBoundingClientRect(), window.innerWidth, {
        align,
        width,
        gap
      });
      const container = el.closest(".console-root") ?? document.body;
      setMeasured((prev) =>
        prev.container === container &&
        (prev.style as { top?: number } | undefined)?.top === top &&
        (prev.style as { left?: number } | undefined)?.left === left
          ? prev
          : { style: { position: "fixed", top, left, zIndex: 50 }, container }
      );
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    update();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open, triggerRef, align, width, gap]);

  return open ? measured : CLOSED;
}

/** Moves keyboard focus into an opened menu panel (first focusable control,
 *  else the panel itself) once per open. Portaled panels sit at the end of
 *  `.console-root` in DOM order, so without this, Tab from the trigger would
 *  traverse the whole page before reaching the menu. The existing close
 *  paths return focus to the trigger. Returns the ref to attach to the
 *  panel element (which needs `tabIndex={-1}` as the fallback target). */
export function useMenuInitialFocus(open: boolean, ready: boolean) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      focusedRef.current = false;
      return;
    }
    if (!ready || focusedRef.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    focusedRef.current = true;
    (panel.querySelector<HTMLElement>("button:not([disabled]), a[href]") ?? panel).focus();
  }, [open, ready]);

  return panelRef;
}
