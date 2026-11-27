"use client";

/** The console's ONE toast system: sonner (OD-11, "sonner wins"). The pre-W23
 *  custom ToastProvider stack (its own viewport, pausable countdowns, and
 *  .con-toasts CSS) is retired; every console toast now renders through the
 *  root-layout ThemedToaster like the rest of the app. This module keeps the
 *  console's honest kind semantics as a thin typed adapter over sonner:
 *  - neg (a failure) persists until dismissed — a failure must not vanish
 *    unread, which is what the retired stack's untimed error toast did;
 *  - pos/warn/info auto-dismiss on sonner's defaults.
 *  The adapter is the only console surface allowed to call sonner's toast. */

import { toast } from "sonner";

export type ToastKind = "info" | "pos" | "neg" | "warn";

export function sonnerToast(kind: ToastKind, title: string, detail?: string): void {
  const opts: { description?: string } | undefined = detail ? { description: detail } : undefined;
  if (kind === "neg") {
    // duration Infinity + closeButton: the failure stays up until the user
    // reads and dismisses it, mirroring the retired stack's untimed errors.
    toast.error(title, { ...opts, duration: Infinity, closeButton: true });
    return;
  }
  if (kind === "pos") {
    toast.success(title, opts);
    return;
  }
  if (kind === "warn") {
    toast.warning(title, opts);
    return;
  }
  toast.info(title, opts);
}