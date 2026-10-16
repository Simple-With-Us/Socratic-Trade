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
 *  Recomputes on resize and on any scroll while open — the bar is sticky,
 *  but the row itself can scroll horizontally on phones. */

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
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const w = Math.min(width, Math.max(0, vw - 16));
      const desired = align === "left" ? r.left : r.right - w;
      const left = Math.max(8, Math.min(desired, Math.max(8, vw - w - 8)));
      setMeasured({
        style: { position: "fixed", top: Math.round(r.bottom + gap), left: Math.round(left), zIndex: 50 },
        container: el.closest(".console-root") ?? document.body
      });
    };
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, triggerRef, align, width, gap]);

  return open ? measured : CLOSED;
}
