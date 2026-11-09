"use client";

/** Auto-save primitive for settings surfaces — the "changes save themselves, like
 *  the Data-sharing section" behavior, generalized so any card can adopt it.
 *
 *  Design (owner-directed 2026-07-09; mirrors app/console/settings/sharing.tsx but
 *  scaled from 3 toggles to whole multi-field cards):
 *   - Persist on the control event: toggles/selects/checkboxes on change, text/number
 *     inputs on BLUR — never per keystroke (callers decide which; the hook just runs
 *     the save it's handed).
 *   - SERIALIZED writes: the shared policy endpoint is read-merge-write, so two
 *     concurrent PUTs could race on stale state. Every save() chains onto the previous
 *     one, so at most one write is in flight and each sees the prior write's result.
 *   - OPTIMISTIC with revert: the caller updates its own field state immediately for
 *     instant feedback, and passes an `onError` that puts the field back if the write
 *     fails (the server 400s on invalid input, e.g. a bad webhook URL or out-of-range
 *     rate). Failures also raise the same "Not saved" toast every settings card uses.
 *   - One inline status ("Saving…/Saved/Couldn't save") per card instead of a success
 *     toast per field — a 15-field page would otherwise spam the toast stack. Errors
 *     always toast (louder signal + the server's reason).
 *
 *  This does NOT touch the persistence layer or the endpoints — it reuses savePolicy /
 *  the per-surface POSTs exactly as the explicit-Save cards did. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConsoleApiError } from "./api";
import { useToast } from "../ui/toast";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

export interface AutoSaveOptions {
  /** Put the field back to its pre-change value when the write fails. */
  onError?: () => void;
  /** Override the failure toast title (default "Not saved"). */
  errorTitle?: string;
  /** Optional extra success toast — use only for high-signal discrete actions
   *  (e.g. a delivery channel turned on/off), NOT for every field. */
  successToast?: { title: string; detail?: string };
}

export interface AutoSaveController {
  status: AutoSaveStatus;
  /** Whether a write is in flight (controls disable themselves while true, like
   *  sharing.tsx's `busy` gate). */
  saving: boolean;
  /** Enqueue a save. Returns immediately; the write runs serialized behind any
   *  in-flight save. */
  save: (run: () => Promise<void>, opts?: AutoSaveOptions) => void;
}

/** `saver` is the async persistence call for one field change — e.g.
 *  `() => savePolicy({ taxSettings: { washSaleGuard: false } }).then(refresh)`.
 *  The card owns the patch shape; the hook owns ordering, status, and error UX. */
export function useAutoSave(): AutoSaveController {
  const toast = useToast();
  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const [pendingCount, setPendingCount] = useState(0);
  const inFlightRef = useRef(0);
  // True if any write in the current burst failed — keeps a later concurrent
  // success from silently overwriting a visible "Couldn't save".
  const burstErroredRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const save = useCallback(
    (run: () => Promise<void>, opts?: AutoSaveOptions) => {
      // A new burst starts whenever nothing is currently in flight.
      if (inFlightRef.current === 0) burstErroredRef.current = false;
      inFlightRef.current += 1;
      setPendingCount((count) => count + 1);
      setStatus("saving");
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      // Chain onto the previous write so at most one is in flight; isolate a prior
      // failure so it can't reject this link.
      queueRef.current = queueRef.current
        .catch(() => {})
        .then(async () => {
          try {
            await run();
            if (mountedRef.current && opts?.successToast) {
              toast.push("pos", opts.successToast.title, opts.successToast.detail);
            }
          } catch (error) {
            burstErroredRef.current = true;
            if (opts?.onError) opts.onError();
            if (mountedRef.current) {
              toast.push(
                "neg",
                opts?.errorTitle ?? "Not saved",
                error instanceof ConsoleApiError ? error.message : error instanceof Error ? error.message : String(error)
              );
              setStatus("error");
            }
            return;
          } finally {
            inFlightRef.current -= 1;
            if (mountedRef.current) setPendingCount((count) => Math.max(0, count - 1));
          }
          // Settle only when the whole burst has drained, so a rapid multi-field
          // change shows one steady "Saving…" then a single "Saved" — and never
          // overwrites a "Couldn't save" from a sibling field that failed.
          if (mountedRef.current && inFlightRef.current === 0 && !burstErroredRef.current) {
            setStatus("saved");
            savedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setStatus((s) => (s === "saved" ? "idle" : s));
            }, 1800);
          }
        });
    },
    [toast]
  );

  // A failed early item may set status="error" while later serialized items are still running.
  // Keep controls disabled until the actual queue drains rather than deriving busy from the label.
  return { status, saving: pendingCount > 0, save };
}
