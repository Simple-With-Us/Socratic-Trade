"use client";

/** Inline "Saving… / Saved / Couldn't save" indicator for auto-saving settings cards.
 *  Pairs with useAutoSave — pass its `status`. Renders nothing when idle so a card
 *  that hasn't been touched shows no chrome. Success fades on its own (the hook flips
 *  back to idle after ~1.8s); errors stay until the next edit. aria-live so a screen
 *  reader hears the outcome without a visual toast. */

import { Check, Loader2, TriangleAlert } from "lucide-react";
import type { AutoSaveStatus } from "../lib/useAutoSave";

export function SaveStatus({ status, className }: { status: AutoSaveStatus; className?: string }) {
  if (status === "idle") return null;
  const base = "inline-flex items-center gap-1 text-[length:var(--con-fs-xs)] font-semibold";
  if (status === "saving") {
    return (
      <span className={`${base} text-[color:var(--con-faint)] ${className ?? ""}`} role="status" aria-live="polite">
        <Loader2 size={12} className="animate-spin" /> Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className={`${base} text-[color:var(--con-pos)] ${className ?? ""}`} role="status" aria-live="polite">
        <Check size={12} /> Saved
      </span>
    );
  }
  return (
    <span
      className={`${base} text-[color:var(--con-neg)] ${className ?? ""}`}
      role="status"
      aria-live="polite"
      title="The last change could not be saved — it was put back.  See the error notice; try again."
    >
      <TriangleAlert size={12} /> Couldn&apos;t save
    </span>
  );
}
