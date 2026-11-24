"use client";

/** Console-native toast notices: visible, non-blocking, self-dismissing.
 *  Used for every mutation error/success so failures never block the screen. */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/format";

export type ToastKind = "info" | "pos" | "neg" | "warn";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastApi {
  push: (kind: ToastKind, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const TOAST_AUTO_DISMISS_MS = 6000;

export interface ToastCountdown {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

/** Pausable one-shot countdown (WCAG 2.2.1: a timed toast must be extendable).
 *  Pause/resume are idempotent; the callback fires once, after `ms` of
 *  unpaused time. `now` is injectable for fake-timer tests. */
export function createToastCountdown(ms: number, onExpire: () => void, now: () => number = Date.now): ToastCountdown {
  let remaining = ms;
  let startedAt = now();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(expire, remaining);
  let done = false;

  function expire() {
    if (done) return;
    done = true;
    timer = null;
    onExpire();
  }
  return {
    pause() {
      if (done || timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (now() - startedAt));
    },
    resume() {
      if (done || timer !== null) return;
      startedAt = now();
      timer = setTimeout(expire, remaining);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      done = true;
    }
  };
}

const KIND_CLASS: Record<ToastKind, string | undefined> = {
  info: undefined,
  pos: "con-toast-pos",
  neg: "con-toast-neg",
  warn: "con-toast-warn"
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const countdowns = useRef(new Map<number, ToastCountdown>());
  // A toast can be held by pointer and focus at once; resume only when both leave.
  const pauseSources = useRef(new Map<number, Set<"pointer" | "focus">>());

  const dismiss = useCallback((id: number) => {
    countdowns.current.get(id)?.cancel();
    countdowns.current.delete(id);
    pauseSources.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pauseFor = useCallback((id: number, source: "pointer" | "focus") => {
    const sources = pauseSources.current.get(id) ?? new Set<"pointer" | "focus">();
    sources.add(source);
    pauseSources.current.set(id, sources);
    countdowns.current.get(id)?.pause();
  }, []);

  const resumeFor = useCallback((id: number, source: "pointer" | "focus") => {
    const sources = pauseSources.current.get(id);
    if (!sources) return;
    sources.delete(source);
    if (sources.size === 0) {
      pauseSources.current.delete(id);
      countdowns.current.get(id)?.resume();
    }
  }, []);

  const push = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, kind, title, detail }]);
    // Error toasts stay until dismissed (deliberate: a failure must not vanish
    // unread); every other kind auto-dismisses on a pausable countdown.
    if (kind !== "neg") {
      countdowns.current.set(id, createToastCountdown(TOAST_AUTO_DISMISS_MS, () => dismiss(id)));
    }
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="con-toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx("con-toast", KIND_CLASS[t.kind])}
            role={t.kind === "neg" ? "alert" : "status"}
            aria-live={t.kind === "neg" ? "assertive" : "polite"}
            onPointerEnter={() => pauseFor(t.id, "pointer")}
            onPointerLeave={() => resumeFor(t.id, "pointer")}
            onFocus={() => pauseFor(t.id, "focus")}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeFor(t.id, "focus");
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{t.title}</div>
                {t.detail && <div className="mt-0.5 text-[color:var(--con-muted)]">{t.detail}</div>}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                className="con-icon-btn con-toast-dismiss shrink-0"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
