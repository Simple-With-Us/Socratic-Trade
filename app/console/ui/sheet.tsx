"use client";

/** Modal sheet: centered dialog on desktop, bottom sheet on mobile.
 *  `tone="live"` adds the real-money border treatment. */

import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../lib/format";
import { useOverlay } from "./use-overlay";
import { useFocusTrap } from "./focus-trap";

export function nextSheetFocusTarget<T>(
  focusables: T[],
  active: T | null,
  sheet: T,
  shiftKey: boolean,
  activeIsInside: boolean
): T | null {
  if (focusables.length === 0) return sheet;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!activeIsInside) return first ?? sheet;
  if (shiftKey && (active === first || active === sheet)) return last ?? sheet;
  if (!shiftKey && active === last) return first ?? sheet;
  return null;
}

export function Sheet({
  open,
  onClose,
  title,
  tone,
  wide,
  children
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  tone?: "live";
  /** Widens the desktop dialog (920px vs the default 560px) for content that
   *  needs more horizontal room, e.g. a multi-column table. Mobile bottom
   *  sheet stays full-width either way. */
  wide?: boolean;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const overlayId = useId();

  useOverlay(overlayId, open, onClose);

  // Stack-aware trap: only the topmost surface handles Escape / Tab / focus
  // restore. A drawer or palette opened from inside this sheet must not also
  // close the sheet (#2561). Callers still pass an inline `onClose`; the hook
  // keeps that callback off the effect deps so a TypedConfirm keystroke cannot
  // re-focus the header X.
  useFocusTrap(sheetRef, open, { onEscape: onClose });

  if (!open) return null;

  return (
    <>
      <div className="con-scrim" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className={cx("con-sheet", wide && "con-sheet-wide", tone === "live" && "con-sheet-live")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        tabIndex={-1}
      >
        <header className="flex items-center justify-between gap-4 border-b border-[color:var(--con-line)] px-5 py-3.5">
          <h2 id={headingId} className="text-[length:var(--con-fs-md)] font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="con-icon-btn"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </>
  );
}
