"use client";

/** Shared overlay lifecycle for console modal surfaces: body scroll-lock,
 *  browser-back / edge-swipe dismissal via history, and visualViewport CSS vars
 *  (--con-vv-height, --con-vv-offset-top) for dvh-safe sizing when the on-screen
 *  keyboard is open. Ref-counted so stacked overlays (sheet under drawer) nest
 *  cleanly. */

import { useEffect, useRef } from "react";

let scrollLockCount = 0;
let savedScrollY = 0;
let viewportSyncCount = 0;

export function syncVisualViewport(): void {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) {
    root.style.setProperty("--con-vv-height", "100dvh");
    root.style.setProperty("--con-vv-offset-top", "0px");
    return;
  }
  root.style.setProperty("--con-vv-height", `${vv.height}px`);
  root.style.setProperty("--con-vv-offset-top", `${vv.offsetTop}px`);
}

function lockBodyScroll(): void {
  if (typeof document === "undefined") return;
  if (scrollLockCount === 0) {
    savedScrollY = window.scrollY;
    document.documentElement.classList.add("con-overlay-open");
    document.body.classList.add("con-overlay-open");
    document.body.style.position = "fixed";
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.width = "100%";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll(): void {
  if (typeof document === "undefined") return;
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;
  document.documentElement.classList.remove("con-overlay-open");
  document.body.classList.remove("con-overlay-open");
  document.body.style.removeProperty("position");
  document.body.style.removeProperty("top");
  document.body.style.removeProperty("width");
  window.scrollTo(0, savedScrollY);
}

function startViewportSync(): void {
  if (typeof window === "undefined") return;
  if (viewportSyncCount === 0) {
    syncVisualViewport();
    window.visualViewport?.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("scroll", syncVisualViewport);
  }
  viewportSyncCount += 1;
}

function stopViewportSync(): void {
  if (typeof window === "undefined") return;
  viewportSyncCount = Math.max(0, viewportSyncCount - 1);
  if (viewportSyncCount > 0) return;
  window.visualViewport?.removeEventListener("resize", syncVisualViewport);
  window.visualViewport?.removeEventListener("scroll", syncVisualViewport);
  document.documentElement.style.removeProperty("--con-vv-height");
  document.documentElement.style.removeProperty("--con-vv-offset-top");
}

/** Test helpers — reset module state between vitest cases. */
export function __resetOverlayStateForTests(): void {
  scrollLockCount = 0;
  viewportSyncCount = 0;
  savedScrollY = 0;
  if (typeof document !== "undefined") {
    document.documentElement.classList.remove("con-overlay-open");
    document.body.classList.remove("con-overlay-open");
    document.body.style.removeProperty("position");
    document.body.style.removeProperty("top");
    document.body.style.removeProperty("width");
    document.documentElement.style.removeProperty("--con-vv-height");
    document.documentElement.style.removeProperty("--con-vv-offset-top");
  }
}

export function __getOverlayLockCountForTests(): number {
  return scrollLockCount;
}

export function useOverlay(
  id: string,
  open: boolean,
  onClose: () => void,
  options?: { history?: boolean }
): void {
  const onCloseRef = useRef(onClose);
  const historyEnabled = options?.history !== false;
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    lockBodyScroll();
    startViewportSync();
    if (!historyEnabled) {
      return () => {
        unlockBodyScroll();
        stopViewportSync();
      };
    }

    history.pushState({ conOverlay: id }, "");

    let dismissedByHistory = false;
    const onPopState = () => {
      dismissedByHistory = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      unlockBodyScroll();
      stopViewportSync();
      if (!dismissedByHistory) {
        const state = history.state as { conOverlay?: string } | null;
        if (state?.conOverlay === id) {
          history.back();
        }
      }
    };
  }, [open, id, historyEnabled]);
}
