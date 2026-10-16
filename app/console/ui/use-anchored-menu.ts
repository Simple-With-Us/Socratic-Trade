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
 *  Measures synchronously when `open` flips (the click-away backdrop is
 *  mounted in the same commit, so a deferred measurement would leave a window
 *  where a click dismisses the menu that was just opened), then re-measures on
 *  resize and on any scroll while open — coalesced to one per frame, and only
 *  committing when the anchor actually moved. The bar is sticky, but the row
 *  itself can scroll horizontally on phones. */

import { useEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchoredMenu {
  style: CSSProperties | undefined;
  container: Element | null;
}

const CLOSED: AnchoredMenu = { style: undefined, container: null };

export function useAnchoredMenu(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  opts: { align: "left" | "right"; width: number; gap?: number }
): AnchoredMenu {
  const { align, width, gap = 4 } = opts;
  const [measured, setMeasured] = useState<AnchoredMenu>(CLOSED);

  useEffect(() => {
    if (!open) {
      // Drop the last measurement on close. `return open ? measured : CLOSED`
      // already hides the panel while closed, but the stale rect would survive
      // in state and be painted for a frame on the next open if the trigger
      // moved (or the viewport resized) in between. CLOSED is a module-level
      // constant, so React bails out of the re-render when nothing changed.
      setMeasured(CLOSED);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const w = Math.min(width, Math.max(0, vw - 16));
      const desired = align === "left" ? r.left : r.right - w;
      const left = Math.max(8, Math.min(desired, Math.max(8, vw - w - 8)));
      const next = {
        style: { position: "fixed", top: Math.round(r.bottom + gap), left: Math.round(left), zIndex: 50 },
        container: el.closest(".console-root") ?? document.body
      } as const;
      // Skip the setState when the anchor has not actually moved. The scroll
      // listener is capture-phase on `window`, so it also fires for scrolls
      // inside the panel's own overflow container (e.g. the notification list),
      // where the trigger rect is unchanged — re-rendering the whole portal
      // subtree on every tick of those was pure waste.
      setMeasured((prev) =>
        prev.container === next.container && prev.style?.position === next.style.position &&
        prev.style?.top === next.style.top && prev.style?.left === next.style.left
          ? prev
          : next
      );
    };
    // Measure synchronously, before scheduling the rAF: the click-away backdrop
    // is mounted as soon as `open` is true, so a panel that only appears a
    // frame later leaves a window where a click dismisses the menu the user
    // just opened.
    update();
    // Burst-coalesce resize/scroll into at most one measurement per frame.
    let raf = 0;
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };
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
